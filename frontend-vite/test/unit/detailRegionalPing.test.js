import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { parse } from 'acorn';
import { createDetailRegionalPingController } from '../../src/detail/regionalPingController.js';
import { ALL_REGIONS, UNGROUPED_REGION } from '../../src/services/regionalPing.js';
import {
  getDetailHistoryPointLimit,
  getDetailHistoryBucketMinutes,
  getDetailHistoryDays,
  syncDetailHistoryStateFromStorage,
} from '../../src/detail/historyRange.js';
import { coldStartAxisBounds } from '../../src/detail/telemetryAxis.js';
import { createDetailPingSampleCache } from '../../src/detail/sampleCache.js';
import { currentLanguage } from '../../src/core/preferences.js';
import {
  buildAggregateHealthSnapshot,
  acceptHealthSnapshot,
  evaluateHealthSnapshot,
} from '../../src/detail/healthSnapshot.js';

vi.hoisted(() => {
  globalThis.window = { __DBG__: {} };
});

const region = (value) => ({ kind: 'region', region: value });
const targets = [
  { key: 'eu1', region: '欧洲' },
  { key: 'eu2', region: '欧洲' },
  { key: 'us', region: '美国' },
  { key: 'un', region: '' },
  ...['default', '__ungrouped__', 'all', '<&"/沪'].map((value) => ({ key: value, region: value })),
];
const history = (name) => ({
  targets: [
    {
      key: name,
      history: [
        { time: '2026-11-07T00:00:00Z', avg_latency: 0 },
        { time: '2026-11-07T00:01:00Z', avg_latency: null },
      ],
    },
  ],
});
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function harness() {
  const cache = {};
  let current = true;
  const fetchTargets = vi.fn(async () => ({ targets }));
  const fetchHistory = vi.fn(async (_sid, _hours, _limit, _source, options) =>
    history(options.selection.region || options.selection.kind),
  );
  const onChange = vi.fn();
  const owner = createDetailRegionalPingController({
    serverId: 7,
    generation: 2,
    isCurrent: () => current,
    cache,
    fetchTargets,
    fetchHistory,
    onChange,
  });
  return {
    owner,
    cache,
    fetchTargets,
    fetchHistory,
    onChange,
    invalidate: () => {
      current = false;
    },
  };
}

describe('detail external PING owner', () => {
  it('retains full public metadata and selects multiple targets, ungrouped and literal sentinel names', async () => {
    const h = harness();
    await h.owner.refresh();
    expect(h.fetchTargets).toHaveBeenCalledWith(7, 1, 'external');
    for (const selection of [
      region('欧洲'),
      UNGROUPED_REGION,
      ...['default', '__ungrouped__', 'all', '<&"/沪'].map(region),
    ]) {
      await h.owner.selectRegion(selection);
      expect(h.owner.state.selectedRegion).toEqual(selection);
      expect(h.cache.pingTargets.targets.map((target) => target.key)).toEqual(
        selection.kind === 'ungrouped'
          ? ['un']
          : targets
              .filter((target) => target.region === selection.region)
              .map((target) => target.key),
      );
      expect(h.cache.pingTargetsMetadata.targets).toEqual(targets);
    }
  });
  it.each([
    ['region', 1],
    ['range', 30],
  ])('rejects abort-ignoring slow A after fast B (%s)', async (_kind, days) => {
    const h = harness();
    await h.owner.refresh();
    const slow = deferred();
    h.fetchHistory.mockImplementationOnce(() => slow.promise);
    const pending = h.owner.selectRegion(region('欧洲'));
    const signal = h.fetchHistory.mock.calls.at(-1)[4].signal;
    if (days === 1) await h.owner.selectRegion(region('美国'));
    else await h.owner.setTimeRange(days);
    const accepted = h.cache.pingTargetHistory;
    expect(signal.aborted).toBe(true);
    slow.resolve(history('stale'));
    await pending;
    expect(h.cache.pingTargetHistory).toBe(accepted);
  });
  it.each([
    [30, 720, 720],
    [90, 2160, 720],
    [0, 1, 3600],
  ])(
    'requests bounded external history for %s days without rewriting legitimate rows',
    async (days, hours, limit) => {
      const h = harness();
      await h.owner.refresh();
      await h.owner.selectRegion(region('<&"/沪'));
      await h.owner.setTimeRange(days);
      expect(h.fetchHistory).toHaveBeenLastCalledWith(
        7,
        hours,
        limit,
        'external',
        expect.objectContaining({ selection: region('<&"/沪'), signal: expect.any(AbortSignal) }),
      );
      expect(h.cache.pingTargetHistory).toEqual(history('<&"/沪'));
      expect(h.owner.state.timeRange).toBe(days);
    },
  );
  it('restores removed regions and clears explicit empty configuration rather than reusing all targets', async () => {
    const h = harness();
    await h.owner.refresh();
    await h.owner.selectRegion(region('欧洲'));
    h.fetchTargets.mockResolvedValueOnce({
      targets: targets.filter((target) => target.region !== '欧洲'),
    });
    await h.owner.refresh();
    expect(h.owner.state.selectedRegion).toEqual(ALL_REGIONS);
    h.fetchTargets.mockResolvedValueOnce({ targets: [] });
    await h.owner.refresh();
    expect(h.cache.pingTargetsMetadata.targets).toEqual([]);
    expect(h.cache.pingTargets.targets).toEqual([]);
    expect(h.cache.pingTargetHistory.targets).toEqual([]);
  });
  it.each(['dispose', 'generation'])(
    'does not mutate cache or presentation after %s',
    async (mode) => {
      const h = harness();
      await h.owner.refresh();
      const slow = deferred();
      h.fetchHistory.mockImplementationOnce(() => slow.promise);
      const pending = h.owner.selectRegion(region('欧洲'));
      const snapshot = JSON.stringify(h.cache);
      const count = h.onChange.mock.calls.length;
      if (mode === 'dispose') h.owner.dispose();
      else h.invalidate();
      slow.resolve(history('obsolete'));
      await pending;
      expect(JSON.stringify(h.cache)).toBe(snapshot);
      expect(h.onChange).toHaveBeenCalledTimes(count);
    },
  );
  it('retains current selection on every heavy refresh', async () => {
    const h = harness();
    await h.owner.refresh();
    await h.owner.selectRegion(region('欧洲'));
    await h.owner.setTimeRange(90);
    await h.owner.refresh();
    await h.owner.refresh();
    expect(h.cache.pingTargets.targets).toHaveLength(2);
    expect(h.owner.state.selectedRegion).toEqual(region('欧洲'));
    expect(h.fetchHistory.mock.calls.slice(-2).map((call) => [call[1], call[4].selection])).toEqual(
      [
        [2160, region('欧洲')],
        [2160, region('欧洲')],
      ],
    );
  });
});

const serverSource = readFile(new URL('../../src/modules/serverTable.js', import.meta.url), 'utf8');
function functions(source, names) {
  const declarations = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(
    (node) => node.declaration || node,
  );
  return names
    .map((name) => {
      const declaration = declarations.find(
        (node) =>
          (node.type === 'FunctionDeclaration' && node.id.name === name) ||
          (node.type === 'VariableDeclaration' &&
            node.declarations.some((entry) => entry.id.name === name)),
      );
      return declaration ? source.slice(declaration.start, declaration.end) : '';
    })
    .join('\n');
}
async function chartHarness() {
  const source = await readFile(
    new URL('../../src/pages/detailCharts.js', import.meta.url),
    'utf8',
  );
  const server = await serverSource;
  const drawn = [];
  const context2d = { save() {}, restore() {}, fillText: (text) => drawn.push(text) };
  const canvas = { getContext: () => context2d, closest: () => null };
  const instances = new Map();
  class ChartEnvironment {
    constructor(_ctx, config) {
      this.canvas = canvas;
      this.data = config.data;
      this.options = config.options;
      this.config = config;
      this.ctx = context2d;
      this.chartArea = { left: 0, right: 400, top: 0, bottom: 100 };
      this.update = vi.fn(() => config.plugins.forEach((plugin) => plugin.afterDraw?.(this)));
    }
  }
  const detailCharts = {
    ready: async () => ChartEnvironment,
    _instances: instances,
    destroy: vi.fn((key) => instances.delete(key)),
    _register: (key, chart) => instances.set(key, chart),
  };
  const context = vm.createContext({
    Date,
    console,
    coldStartAxisBounds,
    window: { __DBG__: {} },
    document: {
      documentElement: {
        dataset: { theme: 'dark' },
        getAttribute(name) {
          return name === 'data-theme' ? (this.dataset.theme ?? null) : null;
        },
      },
      getElementById: (id) => (id === 'detailPingChart' ? canvas : null),
    },
    t: (key) => key,
    detailPingSamples: { store: {} },
  });
  const helperNames = [
    'rowTimeMs',
    'pingStepValue',
    'buildLivePingDatasets',
    'buildPersistedPingTargetDatasets',
    'buildPingDatasets',
    'accumulatingAxisBoundsFromTimes',
  ];
  const serverHelpers = vm.runInContext(
    `(currentLanguage) => {
      ${functions(server, [...helperNames, 'formatTooltipClock', 'uiLocaleTag', 'clockOptions', 'UI_LOCALE_TAGS', 'PING_AXIS_STEPS_MS'])}
      return { ${helperNames.join(', ')}, formatTooltipClock, PING_AXIS_STEPS_MS };
    }`,
    context,
  )(currentLanguage);
  for (const name of helperNames) context[name] = serverHelpers[name];
  const render = vm.runInContext(
    source.replace(/^import .*;\n/gm, '').replace(/export /g, '') + '\nrenderDetailMonitorCharts',
    context,
  );
  const deps = {
    detailCharts,
    rowTimeMs: context.rowTimeMs,
    formatHourTick: String,
    formatHourTickWithDate: String,
    formatTooltipClock: serverHelpers.formatTooltipClock,
    telemetryTooltipTime: String,
    seriesWindowFromRows: () => [],
    adaptiveRollingBounds: () => ({ min: 0, max: 1 }),
    fitSeriesToRollingAxis: (points) => points,
    buildPingDatasets: context.buildPingDatasets,
    accumulatingAxisBoundsFromTimes: context.accumulatingAxisBoundsFromTimes,
    fmtRate: String,
    PING_AXIS_STEPS_MS: serverHelpers.PING_AXIS_STEPS_MS,
    latestTimelineMs: () => Date.now(),
    getDetailPingSampleCache: () => ({}),
  };
  return {
    render: (args) => render(args, deps),
    instances,
    canvas,
    drawn,
    detailCharts,
    context,
    deps,
  };
}

async function nullableLossHarness() {
  const chart = await chartHarness();
  const source = await serverSource;
  const sampleCache = createDetailPingSampleCache();
  chart.context.detailPingSamples = sampleCache;
  chart.context.DETAIL_PING_SAMPLE_WINDOW_MS = sampleCache.windowMs;
  vm.runInContext(
    functions(source, ['recordLivePingSamples', 'seedPingSamplesFromHistory']),
    chart.context,
  );
  const sampleTime = Date.now() - 60 * 1000;
  const lossTargets = [null, 0, 25].map((lossPct, index) => ({
    key: `external-${index}`,
    label: `External ${index}`,
    protocol: 'icmp',
    stats: { avg_ms: 20, loss_pct: lossPct },
    results: [{ success: true, seq: 1, latency_ms: 20 }],
    points: [
      {
        x: new Date(sampleTime).toISOString(),
        latency_ms: 20,
        loss_pct: lossPct,
        protocol: 'icmp',
      },
    ],
  }));
  const payload = { server_id: 7, targets: lossTargets };
  return { ...chart, payload, sampleTime };
}

describe('real external PING nullable loss', () => {
  it.each(['live', 'seeded history', 'persisted history'])(
    'preserves unknown, zero and positive loss through %s production datasets',
    async (mode) => {
      const h = await nullableLossHarness();
      let datasets;
      if (mode === 'live') {
        h.context.recordLivePingSamples(h.payload, h.sampleTime, 7);
        datasets = h.context.buildLivePingDatasets(h.payload, 12);
      } else if (mode === 'seeded history') {
        expect(h.context.seedPingSamplesFromHistory(h.payload, 7)).toBe(3);
        datasets = h.context.buildLivePingDatasets(h.payload, 12);
      } else {
        datasets = h.context.buildPersistedPingTargetDatasets(h.payload, 12);
      }
      expect(datasets.map((dataset) => dataset.data.length)).toEqual([1, 1, 1]);
      expect(datasets.map((dataset) => dataset.data[0].rawMs)).toEqual([20, 20, 20]);
      expect(datasets.map((dataset) => dataset.data[0].x)).toEqual([
        h.sampleTime,
        h.sampleTime,
        h.sampleTime,
      ]);
      expect(datasets.map((dataset) => dataset.data[0].lossPct)).toEqual([null, 0, 25]);
    },
  );

  it('renders unknown as —, real zero as 0% and positive loss in the production Chart afterLabel callback', async () => {
    const h = await nullableLossHarness();
    await h.render({ serverId: 7, pingTargetsData: h.payload, pingTargetHistoryData: h.payload });
    const chart = h.instances.get('detailPingChart');
    const afterLabel = chart.options.plugins.tooltip.callbacks.afterLabel;
    const labels = chart.data.datasets.map((dataset) =>
      afterLabel({ dataset, raw: dataset.data[0] }),
    );
    expect(labels).toEqual([
      'chartProtocol icmp · chartLoss —',
      'chartProtocol icmp · chartLoss 0%',
      'chartProtocol icmp · chartLoss 25%',
    ]);
  });

  it.each([30, 90])(
    'renders unknown, real zero and positive loss through renderer-bound custom tooltip mousemove (%sd)',
    async (detailDays) => {
      const h = await nullableLossHarness();
      const elements = [];
      Object.assign(h.context.document, {
        createElement: (tagName) => {
          const element = {
            tagName,
            style: {},
            textContent: '',
            children: [],
            removed: false,
            remove() {
              this.removed = true;
            },
            replaceChildren(...children) {
              this.children = children;
            },
          };
          elements.push(element);
          return element;
        },
      });
      const card = {
        style: {},
        querySelector: () =>
          elements.find(
            (element) => element.className === 'ping-point-tooltip' && !element.removed,
          ),
        appendChild() {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
      };
      const listeners = new Map();
      Object.assign(h.canvas, {
        closest: () => card,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 200 }),
        addEventListener: (name, listener) => {
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name).add(listener);
        },
        removeEventListener: (name, listener) => listeners.get(name)?.delete(listener),
      });
      for (const name of [
        'spanText',
        'replaceChildrenSafe',
        'formatTooltipClock',
        'PING_AXIS_STEPS_MS',
      ]) {
        expect(vm.runInContext(`typeof ${name}`, h.context)).toBe('undefined');
      }
      const lossLines = [];
      let chart;
      let previousTip;
      for (const [index, target] of h.payload.targets.entries()) {
        const latency = index === 0 ? 0 : 20;
        const label = '<img src=x onerror=alert(1)> & "PING"';
        const protocol = index === 2 ? '<svg onload=alert(1)>' : 'icmp';
        const payload = {
          ...h.payload,
          targets: [
            {
              ...target,
              label,
              protocol,
              stats: { ...target.stats, avg_ms: latency },
              results: [{ ...target.results[0], latency_ms: latency }],
              points: [{ ...target.points[0], latency_ms: latency, protocol }],
            },
          ],
        };
        await h.render({ pingTargetsData: payload, pingTargetHistoryData: payload, detailDays });
        const renderedChart = h.instances.get('detailPingChart');
        chart ||= renderedChart;
        expect(renderedChart).toBe(chart);
        expect(chart.canvas).toBe(h.canvas);
        if (previousTip) expect(previousTip.removed).toBe(true);
        const point = chart.data.datasets[0].data[0];
        const scales = chart.options.scales;
        const event = {
          clientX: (400 * (point.x - scales.x.min)) / (scales.x.max - scales.x.min),
          clientY: 200 * (1 - (point.rawMs - scales.y.min) / (scales.y.max - scales.y.min)),
        };
        expect(listeners.get('mousemove').size).toBe(1);
        expect(listeners.get('mouseenter').size).toBe(1);
        expect(listeners.get('mouseleave').size).toBe(1);
        [...listeners.get('mousemove')][0](event);
        const tip = card.querySelector('.ping-point-tooltip');
        expect(tip.style.display).toBe('block');
        expect(tip.children.map((child) => child.tagName)).toEqual([
          'b',
          'span',
          'span',
          'span',
          'span',
        ]);
        expect(tip.children.map((child) => child.textContent)).toEqual([
          chart.data.datasets[0].label,
          `chartTime: ${h.deps.formatTooltipClock(h.sampleTime)}`,
          `chartLatency: ${latency.toFixed(1)} ms`,
          `chartLoss: ${target.stats.loss_pct == null ? '—' : `${target.stats.loss_pct}%`}`,
          `chartProtocol: ${protocol}`,
        ]);
        expect(tip.children[0].textContent).toContain(label);
        expect(tip.children.every((child) => child.children.length === 0)).toBe(true);
        lossLines.push(tip.children[3].textContent);
        [...listeners.get('mouseleave')][0]();
        expect(tip.style.display).toBe('none');
        [...listeners.get('mouseenter')][0](event);
        expect(tip.style.display).toBe('block');
        previousTip = tip;
      }
      h.canvas._detailPingTooltipCleanup();
      expect(previousTip.removed).toBe(true);
      for (const handlers of listeners.values()) expect(handlers.size).toBe(0);
      expect(h.detailCharts.destroy.mock.calls.flat()).not.toContain('detailPingChart');
      expect(lossLines).toEqual(['chartLoss: —', 'chartLoss: 0%', 'chartLoss: 25%']);
    },
  );
});

describe('real detail Chart boundary', () => {
  it.each(['live metadata', 'seeded history'])(
    'keeps a configured empty 1h history authoritative over %s cache',
    async (mode) => {
      const h = await nullableLossHarness();
      const oldTime = Date.now() - 2 * 60 * 60 * 1000;
      const metadata = {
        server_id: 3,
        targets: [24, 30, 500, 0, null].map((latency, index) => ({
          key: `external-${index}`,
          label: `External ${index}`,
          protocol: 'icmp',
          stats: { avg_ms: latency, loss_pct: null },
          results: [],
        })),
      };
      const cachedHistory = (sampleTime) => ({
        ...metadata,
        targets: metadata.targets.map((target) => ({
          ...target,
          points:
            target.stats.avg_ms == null
              ? []
              : [
                  {
                    x: new Date(sampleTime).toISOString(),
                    latency_ms: target.stats.avg_ms,
                    loss_pct: null,
                  },
                ],
        })),
      });
      expect(h.context.seedPingSamplesFromHistory(cachedHistory(oldTime), 3)).toBe(4);
      if (mode === 'live metadata') {
        h.context.recordLivePingSamples(metadata, h.sampleTime, 3);
      } else {
        expect(h.context.seedPingSamplesFromHistory(cachedHistory(h.sampleTime), 3)).toBe(4);
      }
      await h.render({ pingTargetsData: metadata, detailDays: 0 });
      const chart = h.instances.get('detailPingChart');
      expect(
        chart.data.datasets.flatMap((dataset) => dataset.data).map((point) => point.rawMs),
      ).toEqual([24, 30, 500, 0]);
      await h.render({
        pingTargetsData: metadata,
        pingTargetHistoryData: {
          ...metadata,
          targets: metadata.targets.map((target) => ({ ...target, points: [] })),
        },
        detailDays: 0,
      });
      expect(h.instances.get('detailPingChart')).toBe(chart);
      expect(chart.data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(0);
      expect(chart.data.datasets).toHaveLength(0);
    },
  );

  it.each(['no targets', 'outside the window'])(
    'keeps valid history with %s empty despite recent live cache',
    async (mode) => {
      const h = await nullableLossHarness();
      h.context.recordLivePingSamples(h.payload, h.sampleTime, 7);
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      await h.render({
        pingTargetsData: h.payload,
        pingTargetHistoryData: {
          targets:
            mode === 'no targets'
              ? []
              : h.payload.targets.map((target) => ({
                  ...target,
                  points: target.points.map((point) => ({ ...point, x: oldTime })),
                })),
        },
        detailDays: 0,
      });
      const chart = h.instances.get('detailPingChart');
      expect(chart.data.datasets.flatMap((dataset) => dataset.data)).toHaveLength(0);
      expect(chart.data.datasets).toHaveLength(0);
    },
  );

  it.each(['external', 'peer'])(
    'prefers nonempty %s history over conflicting metadata/cache, including real 0ms and nullable loss',
    async (source) => {
      const h = await nullableLossHarness();
      h.context.recordLivePingSamples(h.payload, h.sampleTime, 7);
      const historyTime = Date.now() - 2 * 60 * 1000;
      const persisted = {
        targets: h.payload.targets.map((target, index) => ({
          ...target,
          key: source === 'peer' ? `vps-${index}` : target.key,
          type: source,
          points: [
            {
              x: new Date(historyTime).toISOString(),
              latency_ms: [0, 7, 15][index],
              loss_pct: target.stats.loss_pct,
              protocol: 'icmp',
            },
          ],
        })),
      };
      await h.render({
        pingTargetsData: h.payload,
        pingTargetHistoryData: persisted,
        detailDays: 0,
      });
      const points = h.instances
        .get('detailPingChart')
        .data.datasets.flatMap((dataset) => dataset.data);
      expect(points.map((point) => point.rawMs)).toEqual([0, 7, 15]);
      expect(points.map((point) => point.x)).toEqual([historyTime, historyTime, historyTime]);
      expect(points.map((point) => point.lossPct)).toEqual([null, 0, 25]);
      expect(points.map((point) => point.key)).toEqual(
        persisted.targets.map((target) => target.key),
      );
      expect(points[0].y).toBe(0);
    },
  );

  it.each(['metadata', 'history'])(
    'keeps unavailable %s empty even with real live cache',
    async (source) => {
      const h = await nullableLossHarness();
      h.context.recordLivePingSamples(h.payload, h.sampleTime, 7);
      await h.render({
        pingTargetsData: source === 'metadata' ? { ...h.payload, unavailable: true } : h.payload,
        pingTargetHistoryData:
          source === 'history' ? { ...h.payload, unavailable: true } : h.payload,
        detailDays: 0,
      });
      expect(h.instances.get('detailPingChart').data.datasets).toHaveLength(0);
    },
  );

  it.each([null, {}])(
    'preserves the real live/cache compatibility entry without valid history: %j',
    async (pingTargetHistoryData) => {
      const h = await nullableLossHarness();
      const metadata = {
        ...h.payload,
        targets: h.payload.targets.map((target, index) => ({
          ...target,
          results: [{ success: true, seq: 1, latency_ms: index === 0 ? 0 : 20 }],
        })),
      };
      h.context.recordLivePingSamples(metadata, h.sampleTime, 7);
      await h.render({ pingTargetsData: metadata, pingTargetHistoryData, detailDays: 0 });
      const points = h.instances
        .get('detailPingChart')
        .data.datasets.flatMap((dataset) => dataset.data);
      expect(points.map((point) => point.rawMs)).toEqual([0, 20, 20]);
      expect(points.map((point) => point.lossPct)).toEqual([null, 0, 25]);
    },
  );

  it('updates the existing PING instance/canvas, tooltip, scales and empty plugin across region/locale/timer redraws', async () => {
    const h = await chartHarness();
    const populated = {
      pingTargetsData: { targets: targets.slice(0, 2) },
      pingTargetHistoryData: {
        targets: [{ key: 'eu1', points: [{ x: new Date().toISOString(), latency_ms: 0 }] }],
      },
      detailDays: 1,
    };
    await h.render(populated);
    const chart = h.instances.get('detailPingChart');
    const plugin = chart.config.plugins[0];
    for (const detailDays of [4, 7, 30, 90, 0]) {
      await h.render({ ...populated, detailDays });
      expect(h.instances.get('detailPingChart')).toBe(chart);
      expect(chart.canvas).toBe(h.canvas);
    }
    await h.render({
      pingTargetsData: { targets: [targets[2]] },
      pingTargetHistoryData: { targets: [] },
      detailDays: 90,
    });
    expect(h.instances.get('detailPingChart')).toBe(chart);
    expect(chart.data.datasets).toHaveLength(0);
    expect(chart.options.plugins.tooltip.enabled).toBe(false);
    plugin.afterDraw(chart);
    expect(h.drawn).toContain('chartAccumulatingIcmp');
    await h.render({
      pingTargetsData: { targets: [] },
      pingTargetHistoryData: { targets: [] },
      detailDays: 0,
    });
    plugin.afterDraw(chart);
    expect(h.drawn).toContain('chartNoLatencyTargets');
    expect(chart.update).toHaveBeenCalledTimes(7);
    expect(h.detailCharts.destroy.mock.calls.flat()).not.toContain('detailPingChart');
  });
  it('keeps actual 0ms but never turns null samples into fake zero', async () => {
    const h = await chartHarness();
    await h.render({
      pingTargetsData: { targets: [targets[0]] },
      pingTargetHistoryData: {
        targets: [
          {
            key: 'eu1',
            points: [
              { x: new Date().toISOString(), latency_ms: 0 },
              { x: new Date().toISOString(), latency_ms: null, rawMs: null },
            ],
          },
        ],
      },
    });
    expect(
      h.instances.get('detailPingChart').data.datasets[0].data.map((point) => point.y),
    ).toEqual([0]);
  });
});

async function pageHarness() {
  const source = await serverSource;
  const h = harness();
  let days = 1;
  const panel = { outerHTML: '', querySelector: () => null };
  const document = {
    getElementById: (id) => (id === 'detailRealtimePanels' ? panel : {}),
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  const renderCharts = vi.fn(async () => {});
  const context = vm.createContext({
    Date,
    console,
    performance,
    AbortController,
    window: { __DBG__: {}, addEventListener: vi.fn() },
    document,
    state: { servers: [{ id: 7 }] },
    selectedServerId: 7,
    activeDetailServerId: '7',
    detailPageGeneration: 2,
    detailRefreshInFlight: false,
    detailRangeReqSeq: 0,
    detailRegionalPingOwner: h.owner,
    createDetailRegionalPingController,
    fetchPingTargets: h.fetchTargets,
    fetchPingTargetHistory: h.fetchHistory,
    detailCache: Object.assign(h.cache, {
      resourceRows: [],
      processRows: [],
      networkRows: [],
      probeRows: [],
      historyRows: [],
      healthReceiveSeq: 0,
    }),
    getDetailHistoryDays: () => days,
    getDetailHistoryPointLimit,
    getDetailHistoryBucketMinutes,
    getDetailHeavyRefreshAt: () => 0,
    setDetailHeavyRefreshAt: vi.fn(),
    getServerDetail: vi.fn(async () => ({
      ping_targets: { targets },
      ping_history: history('UNFILTERED-AGGREGATE'),
    })),
    fetchServerHistory: vi.fn(async () => ({ data: [] })),
    fetchResourceTimeline: vi.fn(async () => ({ data: [] })),
    resourceHistoryRequest: () => ({ limit: 720 }),
    refreshDetailLivePoint: async () => {},
    buildAggregateHealthSnapshot,
    acceptHealthSnapshot,
    evaluateHealthSnapshot,
    normalizeHistory24h: (rows) => rows,
    normalizePersistedRows: (rows) => rows,
    resourceTimelineRows: (rows) => rows,
    shouldReplaceResourceTimeline: () => true,
    mergeResourceTimelineHistory: (_old, rows) => rows,
    smoothNumericSeries: (rows) => rows,
    numericMetricSeries: () => [],
    uiLocaleTag: () => 'en',
    clockOptions: (value) => value,
    renderRealtimeResourcePanels: () => '<section/>',
    applyLanguage: vi.fn(),
    detailProcessMeta: () => ({ countText: '—' }),
    t: (key) => key,
    fmtRate: String,
    renderDetailMonitorCharts: renderCharts,
    refreshDetailProbeTargetsNow: vi.fn(),
    recordLivePingSamples: vi.fn(),
    seedPingSamplesFromHistory: vi.fn(),
    currentLanguage: 'en',
    updateRateDisplay: vi.fn(),
    relocalizeDetailChartTitles: vi.fn(),
    relocalizeDetailComposedLabels: vi.fn(),
    resetDetailCache: () => {
      for (const key of Object.keys(h.cache)) h.cache[key] = null;
    },
    detailTab: { stopRealtimeRefresh: vi.fn() },
  });
  const names = [
    'refreshDetailRealtime',
    'refreshDetailHistoryRange',
    'repaintDetailChartsFromCache',
    'refreshDetailPresentation',
    'beginDetailGeneration',
    'ensureDetailRegionalPingOwner',
    'syncDetailPingRegionControl',
    'disposeDetailRegionalPing',
    'stopDetailRealtimeRefresh',
  ];
  vm.runInContext(functions(source, names), context);
  return {
    ...h,
    context,
    renderCharts,
    setDays: (value) => {
      days = value;
    },
  };
}

describe('production detail history/cache lifecycle', () => {
  it('keeps external region/range through the real 20s aggregate refresh and locale repaint; Peer is unfiltered', async () => {
    const h = await pageHarness();
    await h.owner.refresh();
    await h.owner.selectRegion(region('欧洲'));
    h.setDays(90);
    await h.context.refreshDetailHistoryRange(7);
    expect(h.fetchHistory.mock.calls.some((call) => call[3] === 'agent' && call.length === 4)).toBe(
      true,
    );
    expect(h.cache.pingTargetHistory.targets[0].key).toBe('欧洲');
    await h.context.refreshDetailRealtime(7);
    h.context.refreshDetailPresentation({ languageChanged: true });
    await Promise.resolve();
    expect(h.context.getServerDetail).toHaveBeenCalledWith(7, 90);
    expect(h.owner.state.timeRange).toBe(90);
    expect(h.cache.pingTargets.targets.map((target) => target.key)).toEqual(['eu1', 'eu2']);
    expect(h.cache.pingTargetHistory.targets[0].key).toBe('欧洲');
    expect(h.renderCharts.mock.calls.at(-1)[0].pingTargetsData).toBe(h.cache.pingTargets);
    expect(h.owner.state.selectedRegion).toEqual(region('欧洲'));
  });
  it('rejects a slow old range response and preserves realtime zero', async () => {
    const h = await pageHarness();
    await h.owner.refresh();
    const slow = deferred();
    h.context.fetchServerHistory.mockImplementationOnce(() => slow.promise);
    h.setDays(30);
    const pending = h.context.refreshDetailHistoryRange(7);
    h.setDays(0);
    await h.context.refreshDetailHistoryRange(7);
    const accepted = h.cache.probeRows;
    slow.resolve({ data: [{ created_at: new Date().toISOString(), net_up: 99 }] });
    await pending;
    expect(h.cache.probeRows).toBe(accepted);
    expect(h.owner.state.timeRange).toBe(0);
    expect(h.fetchHistory.mock.calls.filter((call) => call[3] === 'external').at(-1)[1]).toBe(1);
  });
  it.each(['other node', 'same node generation', 'pagehide'])(
    'rejects late heavy aggregate after %s',
    async (mode) => {
      const h = await pageHarness();
      await h.owner.refresh();
      const slow = deferred();
      h.context.getServerDetail.mockImplementationOnce(() => slow.promise);
      const pending = h.context.refreshDetailRealtime(7);
      await Promise.resolve();
      if (mode === 'pagehide') h.context.stopDetailRealtimeRefresh();
      else {
        h.context.state.servers = [{ id: mode === 'other node' ? 8 : 7 }];
        h.context.beginDetailGeneration(mode === 'other node' ? 8 : 7);
      }
      const snapshot = JSON.stringify(h.cache);
      const count = h.renderCharts.mock.calls.length;
      slow.resolve({ ping_targets: { targets }, ping_history: history('late') });
      await pending;
      expect(JSON.stringify(h.cache)).toBe(snapshot);
      expect(h.renderCharts).toHaveBeenCalledTimes(count);
    },
  );
  it('preserves stored and active zero without changing established point budgets', () => {
    window.__DBG__.DETAIL_HISTORY_DAYS = 0;
    globalThis.localStorage = { getItem: () => '0' };
    expect(getDetailHistoryDays()).toBe(0);
    expect(syncDetailHistoryStateFromStorage()).toBe(0);
    expect([1, 4, 7, 30, 90].map(getDetailHistoryPointLimit)).toEqual([288, 288, 168, 720, 720]);
  });
});
