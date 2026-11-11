import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', { __DBG__: {} });

const { CesiumGlobe } = await import('../../src/components/CesiumGlobe.js');
const visitorBeacon = await import('../../src/components/globe/runtime/visitorBeacon.js');

function deferredGlobe(viewer) {
  return Object.assign(Object.create(CesiumGlobe.prototype), {
    viewer,
    servers: [],
    _clusterFanoutExpansionId: 0,
    _hiddenClusterFanoutVisuals: null,
    _nodeEntities: [],
    _visitorEntities: [],
    _visitorInfo: null,
    _visitorLabel: null,
    _visitorFetchStarted: true,
    _arcEntities: [],
    _htmlLabels: new Map(),
    _placeLabels: [],
  });
}

function serversAt(latitude, longitude, id = 104) {
  return [{ id, name: 'deferred-node', latitude, longitude, status: 'online' }];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('CesiumGlobe deferred updateServers (real production entity builder)', () => {
  it.each([undefined, null])(
    'caches valid servers without throwing when viewer is %s',
    (viewer) => {
      const globe = deferredGlobe(viewer);
      const servers = serversAt(35.68, 139.65);

      expect(() => globe.updateServers(servers)).not.toThrow();
      expect(globe.servers).toBe(servers);
      expect(globe._clusterFanoutExpansionId).toBe(1);
      expect(globe._nodeEntities).toEqual([]);
    },
  );

  it('keeps the latest array across consecutive deferred updates', () => {
    const globe = deferredGlobe(undefined);
    const first = serversAt(35.68, 139.65);
    const latest = serversAt(1.35, 103.82, 105);

    expect(() => globe.updateServers(first)).not.toThrow();
    expect(globe.servers).toBe(first);
    expect(() => globe.updateServers(latest)).not.toThrow();
    expect(globe.servers).toBe(latest);
    expect(globe._clusterFanoutExpansionId).toBe(2);
  });

  it('normalizes null to an empty array while preserving fanout cancellation', () => {
    const globe = deferredGlobe(null);
    globe.servers = serversAt(35.68, 139.65);

    expect(() => globe.updateServers(null)).not.toThrow();
    expect(globe.servers).toEqual([]);
    expect(globe._clusterFanoutExpansionId).toBe(1);
  });

  it('routes setServers through the same production updateServers method', () => {
    const globe = deferredGlobe(undefined);
    const servers = serversAt(35.68, 139.65);
    const update = vi.spyOn(globe, 'updateServers');

    expect(() => globe.setServers(servers)).not.toThrow();
    expect(update).toHaveBeenCalledExactlyOnceWith(servers);
    expect(globe.servers).toBe(servers);
    expect(globe._clusterFanoutExpansionId).toBe(1);
  });
});

describe('CesiumGlobe viewer-boundary unit interactions (not rendering E2E)', () => {
  it.each([undefined, null])('skips every viewer-dependent helper when viewer is %s', (viewer) => {
    const globe = deferredGlobe(viewer);
    const build = vi.spyOn(globe, '_buildEntities').mockImplementation(() => {});
    const beacon = vi.spyOn(visitorBeacon, 'installVisitorBeacon').mockImplementation(() => {});
    const camera = vi.spyOn(globe, '_onCameraChanged').mockImplementation(() => {});

    globe.updateServers(serversAt(35.68, 139.65));

    expect(globe._clusterFanoutExpansionId).toBe(1);
    expect(build).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(camera).not.toHaveBeenCalled();
  });

  it('preserves clear, cache, build, beacon, camera order after viewer becomes ready', () => {
    const globe = deferredGlobe(undefined);
    const cached = serversAt(35.68, 139.65);
    const latest = serversAt(1.35, 103.82, 105);
    const calls = [];
    expect(() => globe.updateServers(cached)).not.toThrow();
    globe.viewer = {};
    vi.spyOn(globe, 'clearClusterFanout').mockImplementation(() => {
      calls.push('clear');
      expect(globe.servers).toBe(cached);
    });
    vi.spyOn(globe, '_buildEntities').mockImplementation(() => {
      calls.push('build');
      expect(globe.servers).toBe(latest);
    });
    vi.spyOn(visitorBeacon, 'installVisitorBeacon').mockImplementation((target) => {
      calls.push('beacon');
      expect(target).toBe(globe);
    });
    vi.spyOn(globe, '_onCameraChanged').mockImplementation(() => calls.push('camera'));

    globe.updateServers(latest);

    expect(globe.servers).toBe(latest);
    expect(calls).toEqual(['clear', 'build', 'beacon', 'camera']);
  });

  it('does not swallow ready-viewer entity errors', () => {
    const globe = deferredGlobe({});
    const error = new Error('real warm failure');
    vi.spyOn(globe, '_buildEntities').mockImplementation(() => {
      throw error;
    });
    const beacon = vi.spyOn(visitorBeacon, 'installVisitorBeacon').mockImplementation(() => {});
    const camera = vi.spyOn(globe, '_onCameraChanged').mockImplementation(() => {});

    expect(() => globe.updateServers(serversAt(35.68, 139.65))).toThrow(error);
    expect(beacon).not.toHaveBeenCalled();
    expect(camera).not.toHaveBeenCalled();
  });
});
