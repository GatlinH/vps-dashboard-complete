import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import postcss from 'postcss';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';
import { TrafficChart } from '../../src/components/TrafficChart.js';
import { coldStartAxisBounds } from '../../src/detail/telemetryAxis.js';
import { t } from '../../src/core/preferences.js';

const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
const ids = [
  'detailNetworkChart',
  'detailPingChart',
  'detailCpuChart',
  'detailMemoryChart',
  'detailProcessCountChart',
];
function loadCharts() {
  const source = read('pages/detailCharts.js');
  const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const exports = syntax.body
    .filter((node) => node.type === 'ExportNamedDeclaration')
    .map((node) => node.declaration.id.name);
  const script = syntax.body
    .map((node) =>
      node.type === 'ImportDeclaration'
        ? ''
        : source.slice(node.declaration?.start ?? node.start, node.end),
    )
    .join('\n');
  const window = { __DBG__: {}, matchMedia: () => ({ matches: true }) };
  const document = {
    documentElement: {
      dataset: { theme: 'dark' },
      getAttribute: () => document.documentElement.dataset.theme,
    },
  };
  const context = vm.createContext({ window, document, t, coldStartAxisBounds, console });
  return {
    api: vm.runInContext(
      `${script}\n({${exports.join(',')}, makeHudChartOptions, telemetryEmptyStatePlugin, attachPingPointTooltip})`,
      context,
    ),
    document,
  };
}
it('production canvas ticks and empty hints are readable in both themes', () => {
  const { api, document } = loadCharts();
  for (const theme of ['dark', 'light']) {
    document.documentElement.dataset.theme = theme;
    for (const scale of Object.values(api.makeHudChartOptions().scales)) {
      expect(scale.ticks.font.size).toBe(11);
      expect(scale.ticks.font.family).toContain('monospace');
      expect(scale.ticks.color).toBe(theme === 'light' ? '#334155' : '#94a3b8');
    }
    const ctx = { save: vi.fn(), restore: vi.fn(), fillText: vi.fn() };
    api.telemetryEmptyStatePlugin(false).afterDraw({
      data: { datasets: [] },
      ctx,
      chartArea: { left: 0, right: 100, top: 0, bottom: 100 },
    });
    expect(ctx.font).toContain('12px');
    expect(ctx.fillStyle).toBe(theme === 'light' ? '#475569' : '#94a3b8');
  }
});
it('real exported refresh updates all five registry instances without changing data or bounds', () => {
  const { api, document } = loadCharts();
  expect(api.refreshChartsTheme).toBeTypeOf('function');
  const registry = new TrafficChart();
  for (const id of ids) {
    const options = api.makeHudChartOptions();
    Object.assign(options.scales.x, { min: 1, max: 3600001, type: 'linear' });
    Object.assign(options.scales.y, { min: 0, max: 4 });
    options.scales.y.ticks.precision = 0;
    registry._register(id, {
      options,
      data: {
        datasets: [{ data: id.includes('Ping') ? [] : [{ x: 1, y: 0, rawY: 0, rawMaxY: 7 }] }],
      },
      update: vi.fn(),
    });
  }
  const charts = [...registry._instances.values()];
  const snapshot = charts.map((chart) => ({
    data: chart.data,
    json: JSON.stringify(chart.data),
    axes: JSON.stringify(
      Object.values(chart.options.scales).map((scale) => [
        scale.min,
        scale.max,
        scale.type,
        scale.ticks.precision,
        scale.ticks.callback?.(0),
      ]),
    ),
  }));
  document.documentElement.dataset.theme = 'light';
  api.refreshChartsTheme(registry);
  charts.forEach((chart, index) => {
    expect(chart.update).toHaveBeenCalledExactlyOnceWith('none');
    expect(chart.data).toBe(snapshot[index].data);
    expect(JSON.stringify(chart.data)).toBe(snapshot[index].json);
    expect(
      JSON.stringify(
        Object.values(chart.options.scales).map((scale) => [
          scale.min,
          scale.max,
          scale.type,
          scale.ticks.precision,
          scale.ticks.callback?.(0),
        ]),
      ),
    ).toBe(snapshot[index].axes);
    expect(chart.options.scales.x.ticks.color).toBe('#334155');
    expect(chart.options.plugins.tooltip.bodyColor).toBe('#0f172a');
  });
});
it('native theme lifecycle entry owns one callback on repeated binding', () => {
  const source = read('modules/serverTable.js');
  const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declaration = syntax.body.find(
    (node) => node.type === 'FunctionDeclaration' && node.id.name === 'bindDetailChartTheme',
  );
  expect(declaration, 'production lifecycle entry exists').toBeDefined();
  const listeners = new Set();
  const window = {
    addEventListener: (name, callback) => {
      expect(name).toBe('vps-theme-changed');
      listeners.add(callback);
    },
    removeEventListener: (name, callback) => listeners.delete(callback),
  };
  const runtime = { detailCharts: new TrafficChart(), refreshChartsTheme: vi.fn() };
  const context = vm.createContext({ window, detailChartThemeCleanup: null });
  const bind = vm.runInContext(
    `${source.slice(declaration.start, declaration.end)}; bindDetailChartTheme`,
    context,
  );
  bind(runtime);
  bind(runtime);
  expect(listeners.size).toBe(1);
  for (const listener of listeners) listener();
  expect(runtime.refreshChartsTheme).toHaveBeenCalledExactlyOnceWith(runtime.detailCharts);
  expect(source).toMatch(/bindDetailChartTheme\(detailChartRuntime\)/);
});
it('manual PING tooltip follows production theme tokens at 12px', () => {
  const { api, document } = loadCharts();
  for (const theme of ['light', 'dark']) {
    document.documentElement.dataset.theme = theme;
    const tip = { style: {} };
    document.createElement = () => tip;
    const card = { style: {}, querySelector: () => null, appendChild: vi.fn() };
    api.attachPingPointTooltip(
      { closest: () => card, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      [],
    );
    expect(tip.style.font).toContain('12px');
    expect(tip.style.color).toBe(api.getChartThemeTokens().text);
    expect(tip.style.background).toBe(api.getChartThemeTokens().tooltip.backgroundColor);
  }
});
it('measured low-font leaves are fixed at their real native producers', () => {
  const root = postcss.parse(read('styles/detail-starfleet-console.css'));
  for (const target of ['.process-count-meta', '.history-range-label', '.probe-resource-pill']) {
    const leaves = [];
    root.walkRules((rule) => {
      if (rule.selector.split(',').some((selector) => selector.trim().endsWith(target)))
        rule.walkDecls('font-size', (decl) => leaves.push(decl));
    });
    expect(leaves.length, `${target} positive producer matches`).toBeGreaterThan(0);
    expect(
      leaves.every((decl) => parseFloat(decl.value) >= 12),
      target,
    ).toBe(true);
  }
  expect(read('pages/detailPage.js')).toContain("t('processTotalsOnly')");
  expect(read('pages/detailPage.js')).toContain("t('hostLevelMonitoring')");
});
it('detail probe empty leaves have direct normal 12px fonts in source and compiled CSS', async () => {
  const verifyLeaves = (root) => {
    for (const target of ['.probe-empty-row span', '.probe-empty-row em']) {
      const declarations = [];
      root.walkRules((rule) => {
        if (
          rule.parent.type === 'root' &&
          rule.selector
            .split(',')
            .some((selector) => selector.trim() === `.fleet-detail-console ${target}`)
        )
          rule.walkDecls('font-size', (declaration) => declarations.push(declaration));
      });
      expect(declarations.length, `${target} positive direct font declarations`).toBeGreaterThan(0);
      for (const declaration of declarations) {
        expect(declaration.value).toBe('12px');
        expect(Boolean(declaration.important)).toBe(false);
      }
    }
  };
  verifyLeaves(postcss.parse(read('styles/detail-starfleet-console.css')));
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    publicDir: false,
    logLevel: 'silent',
    build: {
      minify: 'esbuild',
      write: false,
      rollupOptions: {
        input: fileURLToPath(new URL('../../src/pages/detailPage.js', import.meta.url)),
      },
    },
  });
  const asset = output.output.find(
    (entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'),
  );
  expect(asset).toBeDefined();
  verifyLeaves(postcss.parse(String(asset.source)));
});
it('actual Vite-minified CSS keeps positive scoped 12px leaves and solid Day panels', async () => {
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    publicDir: false,
    logLevel: 'silent',
    build: {
      minify: 'esbuild',
      write: false,
      rollupOptions: {
        input: fileURLToPath(new URL('../../src/styles/main.css', import.meta.url)),
      },
    },
  });
  const asset = output.output.find(
    (entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'),
  );
  expect(asset).toBeDefined();
  const root = postcss.parse(String(asset.source));
  for (const target of [
    '.overview-summary-captions',
    '.overview-summary-details',
    '.public-overview-card small',
    '.overview-summary-title',
  ]) {
    const found = [];
    root.walkRules((rule) => {
      if (
        rule.selector.includes(target) &&
        rule.selector.includes('#pageRoot[data-theme-style=lcars]')
      )
        rule.nodes.forEach((entry) => {
          if (entry.prop === 'font-size') found.push(entry);
        });
    });
    expect(found.length, `${target} positive scoped leaves`).toBeGreaterThan(0);
    expect(found.every((entry) => parseFloat(entry.value) >= 12)).toBe(true);
  }
  const panels = [];
  root.walkDecls('--hud-panel', (entry) => {
    if (entry.parent.selector.includes('data-theme=light')) panels.push(entry.value);
  });
  expect(panels).toContain('#fff');
  let important = 0;
  root.walkDecls((entry) => {
    if (entry.important) important += 1;
  });
  expect(important).toBeLessThanOrEqual(6047);
});
