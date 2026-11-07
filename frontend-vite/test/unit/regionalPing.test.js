import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_REGIONS,
  UNGROUPED_REGION,
  decodeRegionSelection,
  encodeRegionSelection,
  filterRegionalTargets,
  isExternalPingTarget,
  isValidRegion,
  listTargetRegions,
  normalizeRegion,
  regionSelectionQuery,
  restoreRegionSelection,
} from '../../src/services/regionalPing.js';

const region = (name) => ({ kind: 'region', region: name });
const targets = [
  { key: 'east-tcp', region: '东亚', protocol: 'tcp' },
  { key: 'east-http', region: '东亚', protocol: 'http' },
  { key: 'west-tcp', region: 'Europe & West/北', protocol: 'tcp' },
  { key: 'west-icmp', region: 'Europe & West/北', protocol: 'icmp' },
  { key: 'legacy' },
  { key: 'empty', region: '' },
  { key: 'unknown', region: { name: '东亚' } },
  { key: 'default-name', region: 'default' },
  { key: 'sentinel-name', region: '__ungrouped__' },
  { key: 'vps-9', region: '东亚', type: 'peer' },
  { key: 'peer-other', region: 'Peer only', type: 'peer' },
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('shared regional ping metadata', () => {
  it('counts actual metadata, multiple targets and legacy ungrouped without peers', () => {
    expect(listTargetRegions(targets)).toEqual([
      { region: '东亚', ungrouped: false, target_count: 2 },
      { region: 'Europe & West/北', ungrouped: false, target_count: 2 },
      { region: '', ungrouped: true, target_count: 3 },
      { region: 'default', ungrouped: false, target_count: 1 },
      { region: '__ungrouped__', ungrouped: false, target_count: 1 },
    ]);
    expect(filterRegionalTargets(targets, region('东亚')).map((target) => target.key)).toEqual([
      'east-tcp',
      'east-http',
    ]);
    expect(
      filterRegionalTargets(targets, region('Europe & West/北')).map((target) => target.key),
    ).toEqual(['west-tcp', 'west-icmp']);
    expect(filterRegionalTargets(targets, UNGROUPED_REGION).map((target) => target.key)).toEqual([
      'legacy',
      'empty',
      'unknown',
    ]);
    expect(filterRegionalTargets(targets, ALL_REGIONS)).toHaveLength(9);
    expect(filterRegionalTargets(targets, region('default')).map((target) => target.key)).toEqual([
      'default-name',
    ]);
    expect(
      filterRegionalTargets(targets, region('__ungrouped__')).map((target) => target.key),
    ).toEqual(['sentinel-name']);
    expect(targets[4]).not.toHaveProperty('region');
  });

  it('excludes peer keys even when their type is missing or claims external', () => {
    expect(isExternalPingTarget({ key: 'vps-10', type: 'external' })).toBe(false);
    expect(isExternalPingTarget({ key: 'vps-11' })).toBe(false);
    expect(isExternalPingTarget({ key: 'public-11', type: 'peer' })).toBe(false);
    expect(isExternalPingTarget({ key: 'public-11', type: 'external' })).toBe(true);
    for (const value of [null, undefined, [], 'external']) {
      expect(isExternalPingTarget(value)).toBe(false);
    }
  });

  it('normalizes unknown metadata without coercing null, objects or numeric regions', () => {
    for (const value of [null, undefined, {}, [], 0, false]) {
      expect(normalizeRegion(value)).toBe('');
      expect(isValidRegion(value)).toBe(false);
    }
    for (const value of ['', 'default', '__ungrouped__', '香港/東京', '  actual name  ']) {
      expect(normalizeRegion(value)).toBe(value);
      expect(isValidRegion(value)).toBe(true);
    }
  });

  it('matches the backend string, Unicode character, UTF-8 and newline bounds', () => {
    expect(isValidRegion('a'.repeat(32))).toBe(true);
    expect(isValidRegion('🌏'.repeat(32))).toBe(true);
    for (const value of [
      'a'.repeat(33),
      '🌏'.repeat(33),
      'a\nb',
      'a\rb',
      '\uD800',
      '\uDC00',
      '\uD800a',
      'a\uDC00',
    ]) {
      expect(isValidRegion(value)).toBe(false);
      expect(normalizeRegion(value)).toBe('');
    }
  });

  it('handles absent target lists as empty metadata', () => {
    for (const value of [undefined, null, {}, []]) {
      expect(listTargetRegions(value)).toEqual([]);
      expect(filterRegionalTargets(value, ALL_REGIONS)).toEqual([]);
    }
  });
});

describe('shared region selection protocol', () => {
  it('round-trips selector values without colliding with literal region names', () => {
    const selections = [
      ALL_REGIONS,
      UNGROUPED_REGION,
      ...['default', '__ungrouped__', 'all', 'ungrouped', 'region:all', '东亚 & a/+%?'].map(region),
    ];
    const values = selections.map(encodeRegionSelection);
    expect(new Set(values).size).toBe(selections.length);
    selections.forEach((selection, index) => {
      expect(decodeRegionSelection(values[index])).toEqual(selection);
    });
    expect(decodeRegionSelection('region:%ZZ')).toEqual(ALL_REGIONS);
    expect(decodeRegionSelection('region:')).toEqual(ALL_REGIONS);
    expect(decodeRegionSelection('__ungrouped__')).toEqual(ALL_REGIONS);
    expect(decodeRegionSelection(null)).toEqual(ALL_REGIONS);
    expect(decodeRegionSelection('region:%ED%A0%80')).toEqual(ALL_REGIONS);
    expect(decodeRegionSelection(`region:${'a'.repeat(33)}`)).toEqual(ALL_REGIONS);
  });

  it('keeps all, ungrouped and actual names separate in correctly encoded query parameters', () => {
    expect(regionSelectionQuery(ALL_REGIONS).toString()).toBe('');
    expect(regionSelectionQuery(ALL_REGIONS)).toBeInstanceOf(URLSearchParams);
    expect(regionSelectionQuery(UNGROUPED_REGION).toString()).toBe('ungrouped=1');
    for (const name of ['default', '__ungrouped__', '东亚 & a/+%?']) {
      const query = regionSelectionQuery(region(name));
      expect(query.get('region')).toBe(name);
      expect(query.has('ungrouped')).toBe(false);
      expect(new URLSearchParams(query.toString()).get('region')).toBe(name);
    }
    expect(regionSelectionQuery(region('东亚 & a/+%?')).toString()).toBe(
      'region=%E4%B8%9C%E4%BA%9A+%26+a%2F%2B%25%3F',
    );
  });

  it('restores only legal selections from current target metadata', () => {
    expect(restoreRegionSelection(region('东亚'), targets)).toEqual(region('东亚'));
    expect(restoreRegionSelection(region('missing'), targets)).toEqual(ALL_REGIONS);
    expect(restoreRegionSelection(region('Peer only'), targets)).toEqual(ALL_REGIONS);
    expect(restoreRegionSelection(UNGROUPED_REGION, [])).toEqual(UNGROUPED_REGION);
    expect(restoreRegionSelection(null, targets)).toEqual(ALL_REGIONS);
  });
});

describe('read-only display data transports', () => {
  function mockFetch() {
    vi.useFakeTimers();
    vi.stubGlobal('window', { __DBG__: { API_ROOT: 'http://local.test' } });
    vi.stubGlobal('location', new URL('http://local.test'));
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ targets: [] }) });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('preserves the existing four-argument history request', async () => {
    const fetchMock = mockFetch();
    const { fetchPingTargetHistory } = await import('../../src/services/displayData.js');
    await fetchPingTargetHistory(101, 24, 300, 'external');
    const [url, options] = fetchMock.mock.calls[0];
    const parsed = new URL(url, 'http://local.test');
    expect(parsed.pathname).toBe('/api/v1/probe/public/ping-targets/101/history');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      hours: '24',
      limit: '300',
      source: 'external',
    });
    expect(options?.method ?? 'GET').toBe('GET');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('extends history with selection and propagates upstream abort through the timeout signal', async () => {
    const fetchMock = mockFetch();
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const { fetchPingTargetHistory } = await import('../../src/services/displayData.js');
    const request = fetchPingTargetHistory(101, 2160, 17, 'external', {
      selection: region('东亚 & a/+%?'),
      signal: controller.signal,
    });
    const [url, options] = fetchMock.mock.calls[0];
    expect(Object.fromEntries(new URL(url, 'http://local.test').searchParams)).toEqual({
      hours: '2160',
      limit: '17',
      source: 'external',
      region: '东亚 & a/+%?',
    });
    controller.abort(new Error('cancel history'));
    expect(options.signal.aborted).toBe(true);
    await expect(request).rejects.toThrow('cancel history');
  });

  it.each([ALL_REGIONS, UNGROUPED_REGION, region('default'), region('__ungrouped__')])(
    'uses the overview namespace, source and independent selection for %j',
    async (selection) => {
      const fetchMock = mockFetch();
      const controller = new AbortController();
      const { fetchRegionalPingOverview } = await import('../../src/services/displayData.js');
      await fetchRegionalPingOverview(101, 6, 'external', selection, controller.signal);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      const parsed = new URL(url, 'http://local.test');
      expect(parsed.pathname).toBe('/api/v1/probe/public/ping-targets/101/overview');
      expect(Object.fromEntries(parsed.searchParams)).toEqual({
        hours: '6',
        source: 'external',
        ...Object.fromEntries(regionSelectionQuery(selection)),
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.signal.aborted).toBe(false);
      expect(options?.method ?? 'GET').toBe('GET');
    },
  );

  it('uses one-hour external overview defaults and exact Unicode region query data', async () => {
    const fetchMock = mockFetch();
    const { fetchRegionalPingOverview } = await import('../../src/services/displayData.js');
    await fetchRegionalPingOverview(101);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Object.fromEntries(new URL(fetchMock.mock.calls[0][0]).searchParams)).toEqual({
      hours: '1',
      source: 'external',
    });
    await fetchRegionalPingOverview(101, 24, 'external', region('东亚 & a/+%?'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.fromEntries(new URL(fetchMock.mock.calls[1][0]).searchParams)).toEqual({
      hours: '24',
      source: 'external',
      region: '东亚 & a/+%?',
    });
  });

  it('propagates cancellation to a pending overview GET', async () => {
    const fetchMock = mockFetch();
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (url, options) =>
        new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const { fetchRegionalPingOverview } = await import('../../src/services/displayData.js');
    const request = fetchRegionalPingOverview(101, 1, 'external', ALL_REGIONS, controller.signal);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    controller.abort(new Error('cancel overview'));
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await expect(request).rejects.toThrow('cancel overview');
  });
});
