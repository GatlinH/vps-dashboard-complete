import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { buildAggregateHealthSnapshot, acceptHealthSnapshot, evaluateHealthSnapshot } from '../../src/detail/healthSnapshot.js';

const NOW = Date.parse('2026-09-15T00:00:20Z');
function declarations(source) {
  return parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(n => n.declaration || n);
}
function extract(source, name) {
  const node = declarations(source).find(n => n.type === 'FunctionDeclaration' && n.id.name === name);
  if (!node) throw new Error(`missing production function ${name}`);
  return source.slice(node.start, node.end);
}
function node(textContent = '') { return { textContent, style: {} }; }
function domFixture() {
  const cells = Array.from({ length: 3 }, () => {
    const strong = node('CPU 11.0%'); const em = node('old');
    return { strong, em, querySelector: s => s === 'strong' ? strong : em };
  });
  const summary = { className: 'old', children: cells, querySelector: s => s.endsWith('strong') ? cells[0].strong : cells[0].em };
  const lines = Object.fromEntries(['CPU', 'MEM', 'LOAD'].map(label => {
    const strong = node('11.0%'); const em = node('old'); const bar = node();
    return [label, { strong, em, bar, querySelector: s => s === 'strong' ? strong : s === 'em' ? em : bar }];
  }));
  const card = { querySelector: s => lines[/data-resource="([^"]+)"/.exec(s)?.[1]] || null };
  const panel = { querySelector: () => null, outerHTML: '' };
  return { cells, summary, lines, panel, document: {
    querySelector: s => s === '.detail-health-summary' ? summary : s === '.probe-observability-grid .resources-card' ? card : null,
    getElementById: id => id === 'detailRealtimePanels' ? panel : null,
  } };
}
async function harness(selectedServerId = 7) {
  const source = await readFile(new URL('../../src/modules/serverTable.js', import.meta.url), 'utf8');
  const cacheSource = await readFile(new URL('../../src/detail/detailCache.js', import.meta.url), 'utf8');
  const dom = domFixture(); const calls = { urls: [], charts: 0 };
  class FixedDate extends Date { static now() { return NOW; } }
  const context = vm.createContext({
    Date: FixedDate, console, setTimeout, clearTimeout,
    selectedServerId, activeDetailServerId: null, detailPageGeneration: 0,
    detailRefreshInFlight: false, detailLivePollMode: 'accumulate', currentLanguage: 'en', API_ROOT: 'https://api.test',
    state: { servers: [{ id: 7, cpu: 4, ram: 8, cpu_use: 11, ram_use: 11 }] }, detailCache: {},
    document: dom.document, window: { __DBG__: {} },
    buildAggregateHealthSnapshot, acceptHealthSnapshot, evaluateHealthSnapshot,
    fetchJson: async url => { calls.urls.push(url); return context.payload; },
    getDetailChartRuntime: async () => ({ appendDetailLiveMetrics: () => false, detailCharts: {} }),
    renderDetailMonitorCharts: async () => { calls.charts++; },
    getDetailHistoryDays: () => 0, getDetailHeavyRefreshAt: () => NOW,
    resourceTimelineRows: rows => rows, numericMetricSeries: () => [], smoothNumericSeries: rows => rows,
    uiLocaleTag: () => 'en', clockOptions: x => x, t: x => x, pctFmt: x => x.toFixed(1),
    clampPct: x => Math.max(0, Math.min(100, Number(x) || 0)),
    resourceUsageFromTotal: (total, pct) => total * pct / 100, fmtResourceGb: x => String(x),
    renderRealtimeResourcePanels: () => '<section/>', applyLanguage: () => {},
    detailProcessMeta: () => ({ count: null, countText: '—' }),
    payload: {},
  });
  const names = ['rowTimeMs', 'detailLatestSample', 'detailHealthStatus', 'beginDetailGeneration', 'refreshDetailLivePoint', 'updateDetailHealthDom', 'syncRealtimeResourceCard', 'repaintDetailChartsFromCache', 'refreshDetailRealtime'];
  const api = vm.runInContext([extract(cacheSource, 'resetDetailCache'), ...names.map(name => extract(source, name)), `({${names.join(',')}})`].join('\n'), context);
  api.beginDetailGeneration(selectedServerId);
  context.detailCache.healthSnapshot = buildAggregateHealthSnapshot({ serverId: 7, generation: context.detailPageGeneration, receiveSeq: 1, payload: {
    live: { server_id: 7, updated_at: '2026-09-15T00:00:10Z', status: 'online', cpu_use: 40, ram_use: 50, disk_use: 60 },
    resource_timeline: [{ created_at: '2026-09-15T00:00:10Z', cpu_use: 11 }],
  } });
  context.detailCache.liveUpdatedAt = Date.parse('2026-09-15T00:00:10Z');
  return { api, context, dom, calls };
}
function coherent(h) {
  expect(h.dom.cells[2].strong.textContent).toBe('CPU 40.0%');
  expect(h.context.detailCache.liveSample).toMatchObject({ cpuPct: 40, ramPct: 50, diskPct: 60, server: { id: 7 } });
  expect(h.dom.lines.CPU.strong.textContent).toBe('40.0%');
  expect(h.dom.lines.MEM.strong.textContent).toBe('50.0%');
}
describe('canonical detail identity and accepted snapshot DOM', () => {
  it.each([7, 999])('repaints real generation for route %s', async id => {
    const h = await harness(id);
    expect(h.context.activeDetailServerId).toBe('7');
    await h.api.repaintDetailChartsFromCache();
    expect(h.calls.charts).toBe(1);
    expect(h.context.window.__DBG__).toHaveProperty('DETAIL_CHART_REPAINT');
  });
  it.each([7, 999])('realtime entry requests canonical live for route %s', async id => {
    const h = await harness(id);
    await h.api.refreshDetailRealtime(id);
    expect(h.calls.urls).toEqual(['https://api.test/api/v1/servers/public/7/live']);
    expect(h.context.window.__DBG__).not.toHaveProperty('DETAIL_LIVE_APPEND_ERROR');
  });
  it('direct live entry resolves the fallback ID', async () => {
    const h = await harness(999);
    await h.api.refreshDetailLivePoint(999);
    expect(h.calls.urls).toEqual(['https://api.test/api/v1/servers/public/7/live']);
  });
  it.each(['empty', 'timeout', 'older'])('keeps real resource DOM coherent for %s live', async mode => {
    const h = await harness();
    if (mode === 'older') h.context.payload = { live: { server_id: 7, updated_at: '2026-09-15T00:00:00Z', status: 'online', cpu_use: 11, ram_use: 11 } };
    if (mode === 'timeout') h.context.fetchJson = async url => { h.calls.urls.push(url); throw new Error('timeout'); };
    await h.api.refreshDetailLivePoint(7);
    expect(h.calls.urls).toHaveLength(1);
    if (mode === 'timeout') expect(h.context.window.__DBG__.DETAIL_LIVE_APPEND_ERROR).toBe('timeout');
    else expect(h.context.window.__DBG__).not.toHaveProperty('DETAIL_LIVE_APPEND_ERROR');
    coherent(h);
  });
  it('clears stale resource values when the accepted metrics are unknown', async () => {
    const h = await harness();
    h.context.detailCache.healthSnapshot.live.cpuPct = null;
    h.context.detailCache.healthSnapshot.live.ramPct = null;
    h.context.payload = { live: { updated_at: '2026-09-15T00:00:00Z', cpu_use: 11 } };
    await h.api.refreshDetailLivePoint(7);
    expect(h.dom.cells[2].strong.textContent).toBe('CPU —');
    expect(h.dom.lines.CPU.strong.textContent).toBe('—');
    expect(h.dom.lines.MEM.strong.textContent).toBe('—');
  });
  it('does not write DOM or diagnostics after an obsolete request fails', async () => {
    const h = await harness(); let reject;
    h.context.fetchJson = url => { h.calls.urls.push(url); return new Promise((_, r) => { reject = r; }); };
    const pending = h.api.refreshDetailLivePoint(7);
    h.context.state.servers = [{ id: 8 }]; h.api.beginDetailGeneration(8);
    h.dom.summary.className = 'new-page';
    reject(new Error('old timeout')); await pending;
    expect(h.calls.urls).toHaveLength(1);
    expect(h.dom.summary.className).toBe('new-page');
    expect(h.context.window.__DBG__).not.toHaveProperty('DETAIL_LIVE_APPEND_ERROR');
  });
});
