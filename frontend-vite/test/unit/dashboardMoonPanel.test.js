import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'acorn';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDashboardTab } from '../../src/modules/dashboardTab.js';

const table = readFileSync(new URL('../../src/modules/serverTable.js', import.meta.url), 'utf8');

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function dashboardHarness({
  overviewMode = false,
  mountedOverview = false,
  mountedGlobe = true,
  selectedServerId = null,
} = {}) {
  vi.stubGlobal('document', { querySelector: vi.fn(() => (mountedOverview ? {} : null)) });
  vi.stubGlobal('window', { __DBG__: {} });
  const state = { servers: [] };
  const servers = [{ name: 'updated server' }];
  const globe = mountedGlobe ? { setServers: vi.fn() } : null;
  const loadServers = vi.fn(async () => {
    await Promise.resolve();
    state.servers = servers;
  });
  const renderOverview = vi.fn();
  const program = parse(table, { ecmaVersion: 'latest', sourceType: 'module' });
  const call = program.body
    .filter((node) => node.type === 'VariableDeclaration')
    .flatMap((node) => node.declarations)
    .find((node) => node.id.name === 'dashboardTab').init;
  expect(call.callee.name).toBe('createDashboardTab');
  // Evaluate the real caller's options without booting the application or WebGL.
  const options = vm.runInNewContext(
    `(${table.slice(call.arguments[0].start, call.arguments[0].end)})`,
    {
      state,
      selectedServerId,
      overviewMode,
      loadServers,
      globe,
      renderPublicOverviewPage: renderOverview,
    },
  );
  expect(Object.keys(options).sort()).toEqual([
    'getMountedGlobe',
    'loadServers',
    'overviewMode',
    'renderOverview',
    'selectedServerId',
    'state',
  ]);
  return { tab: createDashboardTab(options), state, servers, globe, loadServers, renderOverview };
}

describe('dashboard refresh after migration to the solar system', () => {
  it('serverTable keeps legacy sun and moon DOM renderers out of the home page', () => {
    expect(table).not.toMatch(/globeSunMount|globeMoonRoot|globeMoonPanel/);
    expect(table).not.toMatch(/renderSunBadge|renderMoonPanel/);
  });

  it.each([
    { name: 'home', overviewMode: false, mountedOverview: false, mountedGlobe: true },
    {
      name: 'home before globe mount',
      overviewMode: false,
      mountedOverview: false,
      mountedGlobe: false,
    },
    { name: 'overview', overviewMode: true, mountedOverview: true, mountedGlobe: false },
    {
      name: 'overview after navigation',
      overviewMode: true,
      mountedOverview: false,
      mountedGlobe: false,
    },
  ])("refresh completes with serverTable's six arguments: $name", async (scenario) => {
    const h = dashboardHarness(scenario);
    await expect(h.tab.refresh()).resolves.toBeUndefined();
    expect(h.loadServers).toHaveBeenCalledTimes(1);
    expect(h.state.servers).toBe(h.servers);
    if (h.globe) {
      expect(h.globe.setServers).toHaveBeenCalledTimes(1);
      expect(h.globe.setServers).toHaveBeenCalledWith(h.servers);
    }
    const rendersOverview = scenario.overviewMode && scenario.mountedOverview;
    expect(h.renderOverview).toHaveBeenCalledTimes(rendersOverview ? 1 : 0);
    if (rendersOverview) {
      expect(window.__DBG__.OVERVIEW_LAST_REFRESH).toEqual({
        at: expect.any(String),
        count: 1,
        names: ['updated server'],
      });
    } else {
      expect(window.__DBG__.OVERVIEW_LAST_REFRESH).toBeUndefined();
    }
  });

  it('refreshes every ten seconds and stops cleanly with the actual caller options', async () => {
    vi.useFakeTimers();
    const h = dashboardHarness();
    h.tab.startRefresh();
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.loadServers).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.loadServers).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.loadServers).toHaveBeenCalledTimes(2);
    expect(h.globe.setServers).toHaveBeenCalledTimes(2);
    h.tab.stopRefresh();
    await vi.advanceTimersByTimeAsync(10000);
    expect(h.loadServers).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves selected-server detail refresh to its own tab', async () => {
    vi.useFakeTimers();
    const h = dashboardHarness({ selectedServerId: 'server-1' });
    await expect(h.tab.refresh()).resolves.toBeUndefined();
    h.tab.startRefresh();
    expect(h.loadServers).not.toHaveBeenCalled();
    expect(h.globe.setServers).not.toHaveBeenCalled();
    expect(h.renderOverview).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
