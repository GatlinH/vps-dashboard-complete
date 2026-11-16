import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { build } from 'vite';
import { beforeAll, expect, it, vi } from 'vitest';
import { detailLoadingShell, renderDetailConsole } from '../../src/pages/detailPage.js';

vi.mock('../../src/store/state.js', () => ({ state: { currency: 'CNY' } }));

const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');
let css;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    root: fileURLToPath(new URL('../../', import.meta.url)),
    build: {
      write: false,
      minify: 'esbuild',
      rollupOptions: {
        input: {
          main: fileURLToPath(new URL('../../src/styles/main.css', import.meta.url)),
          detail: fileURLToPath(new URL('../../src/pages/detailPage.js', import.meta.url)),
        },
      },
    },
  });
  const assets = output.output.filter(
    (entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'),
  );
  expect(assets.length).toBeGreaterThan(0);
  css = postcss.parse(assets.map((asset) => asset.source).join('\n'));
});
function computed(classes, property, width = 390, context = {}) {
  const lineage = [
    'html',
    'body',
    'display-shell',
    'main display-main',
    '#pageRoot',
    'detail-page-shell starship-console-page detail-loaded-page',
    ...(context.topbar
      ? ['detail-page-topbar', 'detail-page-tools']
      : ['#detailPageGrid detail-page-grid', 'fleet-detail-console']),
    ...classes,
  ];
  let winner;
  let matches = 0;
  css.walkRules((rule) => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule' || parent.name !== 'media') continue;
      const max = parent.params.match(/(?:max-width:\s*|width\s*<=\s*)(\d+)px/);
      const min = parent.params.match(/(?:min-width:\s*|width\s*>=\s*)(\d+)px/);
      if ((max && width > Number(max[1])) || (min && width < Number(min[1]))) return;
    }
    selectorParser((selectors) =>
      selectors.each((selector) => {
        const groups = [[]];
        const combinators = [];
        let specificity = 0;
        selector.each((part) => {
          if (part.type === 'combinator') {
            combinators.push(part.value.trim());
            groups.push([]);
          } else {
            groups.at(-1).push(part);
            specificity +=
              part.type === 'pseudo' && part.value === ':where'
                ? 0
                : part.type === 'id'
                  ? 100
                  : ['class', 'attribute', 'pseudo'].includes(part.type)
                    ? 10
                    : part.type === 'tag'
                      ? 1
                      : 0;
          }
        });
        const accepts = (group, index) =>
          group.every((part) => {
            if (part.type === 'class') return lineage[index].split(' ').includes(part.value);
            if (part.type === 'tag') return lineage[index].split(' ').includes(part.value);
            if (part.type === 'id') return lineage[index].split(' ').includes(`#${part.value}`);
            if (part.type === 'universal') return true;
            if (part.type === 'attribute')
              return (
                index === 0 &&
                part.attribute === 'data-theme' &&
                part.value === (context.theme || 'dark')
              );
            if (part.type === 'pseudo') {
              if (part.value === ':focus-visible')
                return index === lineage.length - 1 && context.focusVisible === true;
              if (part.value === ':not')
                return !part.nodes.some((selector) => accepts(selector.nodes, index));
              if (part.value === ':has')
                return index === 5 && part.toString().includes('.fleet-detail-console');
              if (part.value === ':is' || part.value === ':where')
                return part.nodes.some((selector) => accepts(selector.nodes, index));
              return false;
            }
            return false;
          });
        let index = lineage.length - 1;
        if (!accepts(groups.at(-1), index)) return;
        for (let group = groups.length - 2; group >= 0; group -= 1) {
          index -= 1;
          if (combinators[group] !== '>')
            while (index >= 0 && !accepts(groups[group], index)) index -= 1;
          if (index < 0 || !accepts(groups[group], index)) return;
        }
        rule.walkDecls((decl) => {
          let value = decl.value;
          if (property === 'grid-row' && decl.prop === 'grid-area')
            value = value.split('/')[0].trim();
          else if (property === 'grid-column' && decl.prop === 'grid-area')
            value = value.split('/')[1]?.trim() || 'auto';
          else if (decl.prop === 'outline' && property === 'outline-width')
            value = value.split(' ')[0];
          else if (decl.prop === 'outline' && property === 'outline-color')
            value = value.split(' ').at(-1);
          else if (decl.prop !== property) return;
          matches += 1;
          const priority = (decl.important ? 10000 : 0) + specificity;
          if (!winner || priority >= winner.priority) winner = { value, priority };
        });
      }),
    ).processSync(rule.selector);
  });
  if (property === 'font-size' && matches === 0 && classes.length > 0) {
    return computed(classes.slice(0, -1), property, width, context);
  }
  expect(matches, `${classes.at(-1)} ${property}: positive compiled matches`).toBeGreaterThan(0);
  return property === 'flex' && winner.value === 'none' ? '0 0 auto' : winner.value;
}
function restoreLegacyBoundary(select, check) {
  const original = css;
  const rules = [];
  original.walkRules((rule) => {
    if (select(rule)) rules.push(rule);
  });
  expect(rules.length, 'positive actual full-style legacy mutation witnesses').toBeGreaterThan(0);
  css = original.clone();
  for (const rule of rules) {
    let restored = rule.clone();
    let removed = false;
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type !== 'atrule') continue;
      if (parent.name === 'media' && /(?:min-width:\s*|width\s*>=\s*)769px/.test(parent.params)) {
        removed = true;
        continue;
      }
      const ancestor = parent.clone({ nodes: [] });
      ancestor.append(restored);
      restored = ancestor;
    }
    expect(removed, 'mutated rule really had a 769px ownership boundary').toBe(true);
    css.append(restored);
  }
  try {
    check();
  } finally {
    css = original;
  }
}
it('full source and compiled boundary retain the exact main important blockers only above mobile', () => {
  const source = postcss.parse(read('styles/main.css'));
  const prefix =
    'html body .display-shell main.display-main #pageRoot .detail-page-shell.starship-console-page #detailPageGrid.detail-page-grid';
  for (const root of [source, css]) {
    for (const suffix of [
      '.fleet-right-zone',
      '.fleet-probe-grid',
      '.fleet-probe-grid > *',
      '.fleet-right-zone > *',
    ]) {
      const witnesses = [];
      root.walkRules((rule) => {
        if (
          !rule.selector
            .split(',')
            .some(
              (selector) => selector.replace(/\s*>\s*/g, ' > ').trim() === `${prefix} ${suffix}`,
            )
        )
          return;
        rule.walkDecls((decl) => {
          if (
            decl.important &&
            ((decl.prop === 'display' && decl.value === 'flex') ||
              (decl.prop === 'grid-area' && decl.value === 'auto'))
          )
            witnesses.push(decl);
        });
      });
      expect(witnesses.length, `${suffix}: positive main blocker witnesses`).toBeGreaterThan(0);
      for (const witness of witnesses) {
        let bounded = false;
        for (let parent = witness.parent; parent; parent = parent.parent) {
          if (
            parent.type === 'atrule' &&
            parent.name === 'media' &&
            /(?:min-width:\s*|width\s*>=\s*)769px/.test(parent.params)
          )
            bounded = true;
        }
        expect(bounded, `${suffix}: legacy important blocker excluded at 768px`).toBe(true);
      }
    }
  }
});
it('mobile history is after resources and before five charts, without resurrecting the hidden globe', () => {
  expect(computed([], 'display')).toBe('grid');
  expect(computed(['fleet-console-header'], 'grid-row')).toBe('1');
  expect(computed(['probe-observability-grid'], 'grid-row')).toBe('3');
  expect(computed(['fleet-right-zone'], 'display')).toBe('contents');
  expect(computed(['fleet-right-zone', 'fleet-probe-grid'], 'display')).toBe('contents');
  expect(computed(['fleet-right-zone', 'fleet-probe-grid', 'history-range-bar'], 'grid-row')).toBe(
    '4',
  );
  expect(computed(['fleet-chart-matrix'], 'grid-row')).toBe('5');
  expect(computed(['fleet-right-zone', 'fleet-probe-grid', 'fleet-starmap-panel'], 'display')).toBe(
    'none',
  );
});
it('restoring either actual old main or the unqualified mobile group breaks the compiled layout', () => {
  restoreLegacyBoundary(
    (rule) =>
      rule.selector.includes('#detailPageGrid.detail-page-grid .fleet-right-zone') &&
      rule.nodes.some((decl) => decl.prop === 'display' && decl.value === 'flex' && decl.important),
    () => expect(computed(['fleet-right-zone'], 'display')).toBe('flex'),
  );
  restoreLegacyBoundary(
    (rule) =>
      rule.selector.replace(/\s/g, '') ===
      '.fleet-console-header,.fleet-left-rail,.probe-observability-grid,.fleet-chart-matrix,.fleet-right-zone,.fleet-probe-grid,.fleet-bottom-grid',
    () => {
      expect(computed(['fleet-right-zone'], 'display')).toBe('grid');
      expect(computed(['fleet-right-zone', 'fleet-probe-grid'], 'display')).toBe('grid');
      expect(computed(['probe-observability-grid'], 'grid-template-columns')).toBe('1fr');
    },
  );
});
it('all five native canvas IDs and modifier classes retain the 130px mobile sizing boundary', () => {
  const canvases = [
    [
      'fleet-chart-card compact-metric-card network-throughput-card',
      'network-chart-surface',
      'canvas #detailNetworkChart',
    ],
    ['fleet-chart-card compact-metric-card ping-multi-card', 'canvas #detailPingChart'],
    ['fleet-chart-card compact-metric-card resource-mini-card', 'canvas #detailCpuChart'],
    ['fleet-chart-card compact-metric-card resource-mini-card', 'canvas #detailMemoryChart'],
    [
      'fleet-chart-card pseudo process-count-card compact-metric-card resource-mini-card',
      'canvas #detailProcessCountChart',
    ],
  ];
  const markup = read('pages/detailPage.js');
  for (const canvas of canvases) {
    const id = canvas.at(-1).split('#')[1];
    expect(markup).toContain(`<canvas id="${id}">`);
    for (const width of [360, 390, 430, 600, 768]) {
      for (const property of ['height', 'min-height', 'max-height'])
        expect(
          computed(['fleet-chart-matrix', ...canvas], property, width),
          `${id} ${property}`,
        ).toBe('130px');
      expect(computed(['fleet-chart-matrix', ...canvas], 'box-sizing', width)).toBe('border-box');
      expect(computed(['fleet-chart-matrix', ...canvas], 'aspect-ratio', width)).toBe('auto');
    }
  }
  restoreLegacyBoundary(
    (rule) =>
      rule.selector.includes('.fleet-chart-card.resource-mini-card canvas') &&
      rule.nodes.some((decl) => decl.prop === 'height' && decl.value === '108px' && decl.important),
    () => expect(computed(['fleet-chart-matrix', ...canvases[2]], 'height')).toBe('108px'),
  );
}, 20000);
it('the actual important history foreground uses the light token and retains the dark fallback', () => {
  const label = [
    'fleet-right-zone',
    'fleet-probe-grid',
    'history-range-bar',
    'history-range-label',
  ];
  for (const theme of ['dark', 'light']) {
    expect(computed(label, 'color', 390, { theme })).toBe(
      'var(--detail-history-label-color,#94a3b8)',
    );
    expect(computed(label, 'font-size', 390, { theme })).toBe('12px');
  }
  expect(computed([], '--detail-history-label-color', 390, { theme: 'light' })).toBe('#334155');
  const tokens = [];
  css.walkDecls('--detail-history-label-color', (decl) => tokens.push(decl));
  expect(tokens.length).toBeGreaterThan(0);
  for (const token of tokens) {
    expect(token.parent.selector).toContain('data-theme=light');
    expect(token.value).toBe('#334155');
    expect(token.important || false).toBe(false);
  }
});
it('compiled peer probe table th/td fonts and their phone producer remain 12px', () => {
  const producers = [];
  css.walkRules((rule) => {
    if (
      rule.selector.includes(
        'html body .detail-page-shell.starship-console-page:has(.fleet-detail-console) .fleet-table th',
      ) &&
      rule.selector.includes('.fleet-table td')
    ) {
      producers.push(
        ...rule.nodes.filter((node) => node.type === 'decl' && node.prop === 'font-size'),
      );
    }
  });
  expect(producers.length, 'positive compiled own th/td font producer').toBeGreaterThan(0);
  for (const producer of producers) expect(producer.value).toBe('12px');
  const table = ['fleet-probe-table-panel', 'fleet-table-wrap', 'table fleet-table compact'];
  for (const theme of ['dark', 'light']) {
    for (const [section, cell] of [
      ['thead', 'th'],
      ['tbody', 'td'],
    ]) {
      const descriptor = [...table, section, 'tr', cell];
      for (const width of [360, 390, 430, 600, 720, 768]) {
        expect(computed(descriptor, 'font-size', width, { theme })).toBe('12px');
      }
      expect(computed(table, 'font-size', 768, { theme })).toBe('12px');
    }
  }
}, 20000);
it('mobile currency focus has explicit theme-aware 2px/2px halos and history stays one scrollable row', () => {
  for (const theme of ['dark', 'light']) {
    const context = { topbar: true, focusVisible: true, theme };
    const currency = ['currency-switch detail-currency-switch'];
    expect(computed(currency, 'overflow', 390, context)).toBe('visible');
    expect(computed(currency, 'padding', 390, context)).toBe('4px');
    for (const target of ['currency-btn', 'theme-toggle', 'language-select']) {
      const controls = target === 'currency-btn' ? [...currency, target] : [target];
      expect(computed(controls, 'outline-width', 390, context)).toBe('2px');
      expect(computed(controls, 'outline-offset', 390, context)).toBe('2px');
      expect(computed(controls, 'outline-color', 390, context)).toBe(
        theme === 'light' ? '#334155' : '#94a3b8',
      );
    }
  }
  const history = [
    'fleet-right-zone',
    'fleet-probe-grid',
    'history-range-bar',
    'detail-history-range',
  ];
  expect(computed(history, 'flex-wrap')).toBe('nowrap');
  expect(computed(history, 'overflow-x')).toBe('auto');
  expect(computed(history, 'padding')).toBe('4px');
  expect(computed([...history, 'detail-history-btn'], 'flex')).toBe('0 0 auto');
  expect(computed([...history, 'detail-history-btn'], 'white-space')).toBe('nowrap');
  expect(
    computed(
      [
        'fleet-console-header',
        'fleet-node-identity',
        'fleet-reference-asset fleet-reference-ship fleet-ufo-node',
      ],
      'width',
    ),
  ).toBe('48px');
  expect(
    computed(
      [
        'fleet-console-header',
        'fleet-node-identity',
        'fleet-reference-asset fleet-reference-ship fleet-ufo-node',
      ],
      'height',
    ),
  ).toBe('28px');
  expect(read('modules/serverTable.js')).toContain(
    'class="fleet-reference-asset fleet-reference-ship fleet-ufo-node"',
  );
  const mobile = postcss.parse(read('styles/detail-mobile-layout.css'));
  mobile.walkDecls((decl) => expect(decl.important || false).toBe(false));
});
it('phone/tablet grids have natural heights and unclipped cards', () => {
  for (const width of [360, 390, 430, 600, 768]) {
    expect(computed(['probe-observability-grid'], 'grid-template-columns', width)).toBe(
      width <= 430 ? 'minmax(0,1fr)' : 'repeat(2,minmax(0,1fr))',
    );
    expect(computed(['detail-health-summary'], 'grid-template-columns', width)).toBe(
      'repeat(2,minmax(0,1fr))',
    );
    for (const [property, value] of [
      ['height', 'auto'],
      ['max-height', 'none'],
      ['overflow', 'visible'],
      ['clip-path', 'none'],
    ])
      expect(computed(['fleet-chart-matrix', 'fleet-chart-card'], property, width)).toBe(value);
    expect(computed(['fleet-chart-matrix', 'fleet-chart-card', 'canvas'], 'height', width)).toBe(
      '130px',
    );
    expect(
      computed(
        [
          'fleet-right-zone',
          'fleet-probe-grid',
          'history-range-bar',
          'detail-history-range',
          'detail-history-btn',
        ],
        'min-height',
        width,
      ),
    ).toBe('36px');
  }
  expect(computed(['fleet-chart-matrix', 'fleet-chart-card', 'canvas'], 'height', 1440)).not.toBe(
    '130px',
  );
});
it('production loader/loaded insertion retires skeleton class only after real content lands', () => {
  vi.stubGlobal('document', { documentElement: { getAttribute: () => 'light' } });
  expect(detailLoadingShell({ name: 'Long node', id: 7 })).toContain('detail-loading-page');
  const source = read('modules/serverTable.js');
  const syntax = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const entry = syntax.body
    .map((node) => node.declaration || node)
    .find((node) => node.id?.name === 'renderDetailPage');
  const body = entry.body.body.find((node) => node.type === 'TryStatement').block.body;
  const start = body.findIndex((node) =>
    source.slice(node.start, node.end).startsWith('detailGrid.innerHTML = renderDetailConsole('),
  );
  expect(start).toBeGreaterThan(0);
  const shellClasses = new Set(['detail-loading-page']);
  const shell = {
    classList: {
      remove: (name) => shellClasses.delete(name),
      add: (name) => shellClasses.add(name),
    },
  };
  const detailGrid = { innerHTML: '', closest: () => shell, querySelector: () => null };
  const context = {
    detailGrid,
    renderDetailConsole,
    resolvedServer: { id: 7, name: 'Long node' },
    detailCache: {},
    pingOwner: { state: { selectedRegion: undefined } },
    state: { servers: [] },
    processMeta: { count: 12, countText: '12' },
    document: { querySelector: () => shell },
  };
  const insertion = body
    .slice(start, start + 3)
    .filter((node) => node.type === 'ExpressionStatement')
    .map((node) => source.slice(node.start, node.end))
    .join('\n');
  for (const match of insertion.matchAll(/\b([a-zA-Z][\w]*)\b/g)) {
    const name = match[1];
    if (!(name in context))
      context[name] = /^(render|format)|Value$|^(maskIpForPublicDisplay|statusLabel)$/.test(name)
        ? () => '—'
        : [];
  }
  vm.runInNewContext(insertion, context);
  expect(detailGrid.innerHTML.match(/<canvas id="detail/g)).toHaveLength(5);
  expect(detailGrid.innerHTML.match(/role="group"/g)).toHaveLength(1);
  expect(
    shellClasses.has('detail-loading-page'),
    'loaded insertion must retire skeleton class',
  ).toBe(false);
  vi.unstubAllGlobals();
});
