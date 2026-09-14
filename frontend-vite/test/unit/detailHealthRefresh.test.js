import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { buildAggregateHealthSnapshot, evaluateHealthSnapshot, acceptHealthSnapshot } from '../../src/detail/healthSnapshot.js';

const INITIAL_AT = '2026-09-15T00:00:00Z';
const NEXT_AT = '2026-09-15T00:00:01Z';
const NOW_MS = Date.parse('2026-09-15T00:00:05Z');

function extractFunction(source, name) {
  const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declaration = program.body.find((node) => node.type === 'FunctionDeclaration' && node.id?.name === name);
  if (!declaration) throw new Error(`missing ${name}`);
  return source.slice(declaration.start, declaration.end);
}

function makeDom() {
  const healthStrong = { textContent: 'Healthy' };
  const healthEm = { textContent: 'Agent online' };
  const freshnessStrong = { textContent: '5 seconds ago' };
  const freshnessEm = { textContent: 'Backend sample interval 5s' };
  const resourceStrong = { textContent: 'CPU 1.0%' };
  const resourceEm = { textContent: 'Memory 2.0% · Disk 3.0%' };
  const summary = {
    className: 'detail-health-summary is-ok',
    children: [
      { querySelector: (selector) => selector === 'strong' ? healthStrong : healthEm },
      { querySelector: (selector) => selector === 'strong' ? freshnessStrong : freshnessEm },
      { querySelector: (selector) => selector === 'strong' ? resourceStrong : resourceEm },
    ],
    querySelector: (selector) => selector === '.health-main strong' ? healthStrong : healthEm,
  };
  return {
    summary,
    document: { querySelector: (selector) => selector === '.detail-health-summary' ? summary : null },
  };
}

function initialSnapshot() {
  return buildAggregateHealthSnapshot({
    serverId: 7,
    generation: 1,
    receiveSeq: 1,
    source: 'aggregate',
    payload: {
      live: { server_id: 7, updated_at: INITIAL_AT, status: 'online', cpu_use: 1, ram_use: 2, disk_use: 3 },
      resource_timeline: [
        { server_id: 7, created_at: '2026-09-14T23:59:55Z', cpu_use: 1, ram_use: 2, disk_use: 3 },
        { server_id: 7, created_at: INITIAL_AT, cpu_use: 1, ram_use: 2, disk_use: 3 },
      ],
    },
  });
}

async function loadRefresh() {
  const source = await readFile(new URL('../../src/modules/serverTable.js', import.meta.url), 'utf8');
  class FixedDate extends Date {
    static now() { return NOW_MS; }
  }
  const dom = makeDom();
  const calls = { api: 0, append: 0 };
  const detailCache = {
    healthReceiveSeq: 1,
    liveUpdatedAt: Date.parse(INITIAL_AT),
    healthSnapshot: initialSnapshot(),
    resourceRows: [],
    pingTargets: null,
  };
  const context = vm.createContext({
    console,
    Date: FixedDate,
    Number,
    String,
    Math,
    Promise,
    setTimeout,
    API_ROOT: 'https://api.example.test',
    detailPageGeneration: 1,
    detailLivePollMode: 'accumulate',
    detailCache,
    document: dom.document,
    window: { __DBG__: {} },
    state: { servers: [{ id: 7, status: 'online', cpu_use: 1, ram_use: 2, disk_use: 3 }] },
    fetchJson: async () => { calls.api += 1; return { live: context.live }; },
    getDetailChartRuntime: async () => ({
      appendDetailLiveMetrics: () => { calls.append += 1; return context.appendResult; },
      detailCharts: {},
    }),
    acceptHealthSnapshot,
    buildAggregateHealthSnapshot,
    evaluateHealthSnapshot,
    resourceTimelineRows: (rows) => rows,
    syncRealtimeResourceCard: () => {},
    t: (key) => key,
  });
  const code = [
    extractFunction(source, 'rowTimeMs'),
    extractFunction(source, 'detailLatestSample'),
    extractFunction(source, 'detailHealthStatus'),
    extractFunction(source, 'updateDetailHealthDom'),
    extractFunction(source, 'refreshDetailLivePoint'),
    'refreshDetailLivePoint',
  ].join('\n');
  const refresh = vm.runInContext(code, context);
  expect(evaluateHealthSnapshot(detailCache.healthSnapshot, NOW_MS)).toMatchObject({ state: 'ok', online: true });
  expect(dom.summary.className).toBe('detail-health-summary is-ok');
  return { refresh, detailCache, calls, dom, context };
}

function expectCompletedWithoutCaughtReferenceError(h) {
  expect(h.calls.api).toBe(1);
  expect(h.context.window.__DBG__).not.toHaveProperty('DETAIL_LIVE_APPEND_ERROR');
}

describe('detail health live refresh entry regression', () => {
  it('positive control updates visible danger health for a newer offline point when append succeeds', async () => {
    const h = await loadRefresh();
    h.context.live = { updated_at: NEXT_AT, status: 'offline', cpu_use: 1, ram_use: 2, disk_use: 3 };
    h.context.appendResult = true;

    await h.refresh(7);

    expectCompletedWithoutCaughtReferenceError(h);
    expect(h.calls.append).toBe(1);
    expect(h.dom.summary.className).toBe('detail-health-summary is-danger');
    expect(evaluateHealthSnapshot(h.detailCache.healthSnapshot, NOW_MS).online).toBe(false);
  });

  it('updates visible danger health when same timestamp changes status offline', async () => {
    const h = await loadRefresh();
    h.context.live = { updated_at: INITIAL_AT, status: 'offline', cpu_use: 1, ram_use: 2, disk_use: 3 };
    h.context.appendResult = false;

    await h.refresh(7);

    expectCompletedWithoutCaughtReferenceError(h);
    expect(h.calls.append).toBe(0);
    expect(h.dom.summary.className).toBe('detail-health-summary is-danger');
  });

  it('updates visible danger health when timestamp advances even if chart append is false', async () => {
    const h = await loadRefresh();
    h.context.live = { updated_at: NEXT_AT, status: 'offline', cpu_use: 1, ram_use: 2, disk_use: 3 };
    h.context.appendResult = false;

    await h.refresh(7);

    expectCompletedWithoutCaughtReferenceError(h);
    expect(h.calls.append).toBe(1);
    expect(h.dom.summary.className).toBe('detail-health-summary is-danger');
  });

  it('recomputes stale raw health on request failure without advancing live cache', async () => {
    const h = await loadRefresh();
    h.detailCache.healthSnapshot = buildAggregateHealthSnapshot({
      serverId: 7, generation: 1, receiveSeq: 2,
      payload: { live: { server_id: 7, updated_at: '2026-09-14T23:56:00Z', status: 'offline' }, resource_timeline: [{ server_id: 7, created_at: '2026-09-14T23:56:00Z', cpu_use: 1 }] },
    });
    h.context.fetchJson = async () => { h.calls.api += 1; throw new Error('timeout'); };

    await h.refresh(7);

    expect(h.calls.api).toBe(1);
    expect(h.calls.append).toBe(0);
    expect(h.dom.summary.className).toBe('detail-health-summary is-danger');
    expect(h.detailCache.liveUpdatedAt).toBe(Date.parse(INITIAL_AT));
  });

  it('shows unknown rather than false offline when no trusted raw state exists', async () => {
    const h = await loadRefresh();
    h.detailCache.healthSnapshot = buildAggregateHealthSnapshot({ serverId: 7, generation: 1, receiveSeq: 2, payload: {} });
    h.context.fetchJson = async () => { h.calls.api += 1; return {}; };

    await h.refresh(7);

    expect(h.dom.summary.className).toBe('detail-health-summary is-unknown');
    expect(h.dom.summary.children[0].querySelector('em').textContent).toContain('noSample');
  });
});
