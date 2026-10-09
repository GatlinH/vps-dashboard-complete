import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import vm from 'node:vm';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import { getTrafficPct } from '../../src/utils/traffic.js';
import {
  assertLegacySunMoonRemoval,
  legacyTokensInRenderedHtml,
  parseSolarSource,
  readLegacySolarSources,
} from '../../scripts/lib/legacySolarDom.mjs';

const files = readLegacySolarSources(new URL('../../', import.meta.url));
const overviewFile = 'src/pages/overviewPage.js';
const globeStyleFile = 'src/styles/globe.css';
const mainStyleFile = 'src/styles/main.css';
const epoch = Date.parse('2026-10-07T00:00:00.000Z');

class FixtureDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [epoch]));
  }

  static now() {
    return epoch;
  }
}

function renderOverview({ files: sources }) {
  const source = sources.get(overviewFile);
  const ast = parseSolarSource(source, overviewFile);
  const edits = ast.body.flatMap((node) => {
    if (node.type === 'ImportDeclaration') return [{ start: node.start, end: node.end }];
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      return [{ start: node.start, end: node.declaration.start }];
    }
    return [];
  });
  // Strip only the ESM envelope. Every summary, renderer and local helper body
  // comes from the supplied production source, including in mutation runs.
  let executable = source;
  for (const { start, end } of edits.reverse()) {
    executable = executable.slice(0, start) + executable.slice(end);
  }
  const script = new vm.Script(`${executable}\n;renderPublicOverviewPage;`, {
    filename: overviewFile,
  });
  const app = { innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  const servers = [
    {
      id: 101,
      name: 'node-expiring',
      status: 'online',
      price: 10,
      expiry: '2026-10-09T00:00:00.000Z',
    },
    { id: 102, name: 'node-warning', status: 'warn', price: 20, expiry: null },
    { id: 103, name: 'node-offline', status: 'offline', price: 30, expiry: null },
  ].map((server) => ({
    ...server,
    location: 'region-A',
    provider: 'provider-A',
    group: 'fixture-group',
    traffic_used_gb: 10,
    traffic_limit_gb: 100,
  }));
  const renderer = script.runInNewContext({
    Date: FixtureDate,
    state: { servers, serversUpdatedAt: epoch, currency: 'CNY' },
    LANGUAGE_PACKS: { zh: { name: '中文' } },
    currentLanguage: 'zh',
    t: (key) => key,
    toDisplay: (amount) => `¥${Math.round(amount)}`,
    calcResidualValue: (server) => ({ value: server.price }),
    getMonthlyPrice: (server) => server.price,
    sourceAmountToCny: (amount) => Number(amount),
    getSourceCurrency: () => 'CNY',
    updateRateDisplay: () => {},
    normalizePublicServer: (server) => server,
    getTrafficPct,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      getElementById: (id) => (id === 'pageRoot' ? app : null),
      documentElement: { getAttribute: () => 'dark' },
    },
    window: { location: { href: '/?overview=1' } },
  });
  assert.equal(typeof renderer, 'function');
  // Parse/module setup errors above cannot masquerade as a successful kill.
  try {
    renderer();
  } catch (error) {
    assert.fail(`F10_OVERVIEW_STATS renderer threw: ${error.message}`);
  }
  return app.innerHTML;
}

function monthlyKpi(html) {
  const items = html.matchAll(
    /<div class="kpi-item(?:\s[^"]*)?">\s*<span>([^<]*)<\/span>\s*<strong>([^<]*)<\/strong>\s*<\/div>/g,
  );
  return [...items].find(([, key]) => key === 'monthlyTotalCost')?.[2] ?? '';
}

function overviewPanels(html) {
  // Match the actual summary section class, so names in node cards cannot pass.
  return [...html.matchAll(/<section\b[^>]*>/g)].flatMap((match) => {
    const classes = match[0].match(/\bclass="([^"]*)"/)?.[1].split(/\s+/) ?? [];
    if (!classes.includes('public-overview-panel')) return [];
    const end = html.indexOf('</section>', match.index);
    return end < 0 ? [] : [html.slice(match.index, end + '</section>'.length)];
  });
}

function panelByTitle(html, title) {
  return (
    overviewPanels(html).find((panel) =>
      panel.includes(`<div class="public-overview-panel-title">${title}</div>`),
    ) ?? ''
  );
}

function panelByData(html, name) {
  return (
    overviewPanels(html).find((panel) =>
      panel.slice(0, panel.indexOf('>')).includes(`data-panel="${name}"`),
    ) ?? ''
  );
}

function assertOverviewPreserved(input) {
  const html = renderOverview(input);
  assert.match(html, /<span>totalNodes<\/span><strong>3<\/strong>/, 'F10_OVERVIEW_STATS');
  for (const status of ['online', 'warn', 'offline']) {
    assert.ok(
      html.includes(`<span>${status}</span><strong>1</strong>`),
      `F10_OVERVIEW_STATS ${status}`,
    );
  }
  assert.equal(monthlyKpi(html), '¥60', 'F10_OVERVIEW_COST:total');
  assert.match(
    panelByTitle(html, 'monthlyByRegion'),
    /<b>region-A<\/b><span>¥60<\/span>/,
    'F10_OVERVIEW_COST:region',
  );
  assert.match(
    panelByTitle(html, 'monthlyByProvider'),
    /<b>provider-A<\/b><span>¥60<\/span>/,
    'F10_OVERVIEW_COST:provider',
  );
  assert.match(panelByData(html, 'expiry'), /node-expiring/, 'F10_OVERVIEW_ALERTS:expiry');
  assert.match(panelByData(html, 'abnormal'), /node-offline/, 'F10_OVERVIEW_ALERTS:abnormal');
  assert.equal(legacyTokensInRenderedHtml(html).length, 0, 'F10_RENDERED_LEGACY_DOM');
  return html;
}

function replaceOnce(sources, file, before, after) {
  const source = sources.get(file);
  assert.equal(source.split(before).length, 2, `unique mutation anchor in ${file}: ${before}`);
  sources.set(file, source.replace(before, after));
}

function append(file, source) {
  return (sources) => sources.set(file, `${sources.get(file) ?? ''}\n${source}\n`);
}

function changeSharedLayer(sources, change) {
  const root = postcss.parse(sources.get(globeStyleFile));
  const matches = [];
  root.walkRules((rule) => {
    if (rule.selectors.includes('.globe-hint') && rule.selectors.includes('.globe-focus-badge')) {
      matches.push(rule);
    }
  });
  assert.equal(matches.length, 1, 'unique shared layer mutation anchor');
  change(matches[0]);
  sources.set(globeStyleFile, root.toString());
}

function removeOverviewSection(marker) {
  return (sources) => {
    const source = sources.get(overviewFile);
    assert.equal(source.split(marker).length, 2, `unique overview section anchor: ${marker}`);
    const at = source.indexOf(marker);
    const start = source.lastIndexOf('<section', at);
    const end = source.indexOf('</section>', at) + '</section>'.length;
    assert.ok(start >= 0 && end > at);
    sources.set(overviewFile, source.slice(0, start) + source.slice(end));
    // The fixture still renders node cards containing these names after the
    // summary section disappears; a whole-page search would give false passes.
    const html = renderOverview({ files: sources });
    assert.match(html, /node-expiring/);
    assert.match(html, /node-offline/);
    assert.match(html, /provider-A/);
    assert.match(html, /region-A/);
  };
}

async function verifyMutation({
  name,
  prefix,
  mutate,
  check = assertLegacySunMoonRemoval,
  diagnostic,
}) {
  // Each mutation parses the full source tree three times. Let the runner flush
  // its reporter/RPC queue between cases, without changing any check or timeout.
  await setImmediate();
  const original = new Map(files);
  const copy = new Map(files);
  check({ files: copy });
  let failure;
  try {
    mutate(copy);
    assert.notDeepEqual([...copy], [...original], `${name} must change its memory copy`);
    try {
      check({ files: copy });
    } catch (error) {
      failure = error;
    }
    expect(failure?.code, `${prefix}: ${name} must fail an assertion, not parsing/loading`).toBe(
      'ERR_ASSERTION',
    );
    assert.ok(failure.message.startsWith(prefix), `${name}: ${failure.message}`);
    if (diagnostic) assert.match(failure.message, diagnostic);
  } finally {
    // Restore the same Map that was mutated, without writing product files.
    copy.clear();
    for (const entry of original) copy.set(...entry);
    check({ files: copy });
    assert.deepEqual([...files], [...original], 'the original source collection stays read-only');
  }
  const actual = failure.message.match(/^F10_[A-Z_]+(?::[a-z]+)?/)[0];
  console.log(`F10_MUTATION | ${name} | original=PASS | mutant=${actual} | restored=PASS`);
}

const staticMutations = [
  {
    name: 'empty legacy file',
    prefix: 'F10_LEGACY_FILE_EXISTS',
    mutate: (copy) => copy.set('src/ui/sunMoonEntry.js', ''),
  },
  ...[
    ['moved function', 'src/reintroduced.js', 'export function renderMoonPanel() {}'],
    ['sun function in mjs', 'src/reintroduced.mjs', 'function renderSunBadge() {}'],
    ['const arrow in jsx', 'src/reintroduced.jsx', 'const renderMoonPanel = () => <aside />;'],
    [
      'named function expression',
      'src/reintroduced.js',
      'const renamed = function renderMoonPanel() {};',
    ],
    ['destructured binding', 'src/reintroduced.js', 'const { entry: renderMoonPanel } = {};'],
    [
      'export alias',
      'src/reintroduced.js',
      'const renamed = () => {}; export { renamed as renderMoonPanel };',
    ],
    [
      'string export alias',
      'src/reintroduced.mjs',
      'const renamed = () => {}; export { renamed as "renderSunBadge" };',
    ],
  ].map(([name, file, source]) => ({
    name,
    prefix: 'F10_LEGACY_DEFINITION',
    mutate: append(file, source),
    diagnostic: /src\/reintroduced\.(?:js|jsx|mjs):\d+/,
  })),
  ...[
    ['dead function declaration', 'function mountDisplayPage() {}'],
    ['dead const mount', 'const mountDisplayPage = () => {};'],
  ].map(([name, source]) => ({
    name,
    prefix: 'F10_DEAD_MOUNT_EXISTS',
    mutate: append(overviewFile, source),
  })),
  ...['globeSunMount', 'globeMoonRoot', 'globeMoonPanel'].flatMap((id) => [
    {
      name: `renamed string template ${id}`,
      prefix: 'F10_OLD_OVERVIEW_TEMPLATE',
      mutate: append(overviewFile, `function renamedMount() { return '<div id="${id}"></div>'; }`),
    },
    {
      name: `renamed template literal ${id}`,
      prefix: 'F10_OLD_OVERVIEW_TEMPLATE',
      mutate: append(
        overviewFile,
        `function renamedMount() { return \`<div id="${id}">\${'child'}</div>\`; }`,
      ),
    },
  ]),
  ...[
    ['drawer base rule', globeStyleFile, '.globe-moon-drawer { display: block; }'],
    [
      'late mobile core rule',
      globeStyleFile,
      '@media (max-width: 600px) { .moon-solar-core { opacity: 1; } }',
    ],
    ['old id in new css', 'src/reintroduced.css', '#globeSunMount { z-index: 1; }'],
    [
      'functional selector',
      'src/reintroduced.css',
      ':is(.globe-hint, .globe-moon-pill) { opacity: 1; }',
    ],
    ['escaped legacy class', 'src/reintroduced.css', '.moon\\2d stat { opacity: 1; }'],
  ].map(([name, file, source]) => ({
    name,
    prefix: 'F10_LEGACY_SELECTOR',
    mutate: append(file, source),
    diagnostic: /src\/[^\s]+\.css:\d+/,
  })),
  {
    name: 'whole shared layer removed',
    prefix: 'F10_SHARED_LAYER_LOST',
    mutate: (copy) => changeSharedLayer(copy, (rule) => rule.remove()),
  },
  ...['.globe-hint', '.globe-focus-badge'].map((selector) => ({
    name: `shared branch removed ${selector}`,
    prefix: 'F10_SHARED_LAYER_LOST',
    mutate: (copy) =>
      changeSharedLayer(copy, (rule) => {
        rule.selectors = rule.selectors.filter((branch) => branch !== selector);
      }),
  })),
  {
    name: 'shared z-index changed',
    prefix: 'F10_SHARED_LAYER_LOST',
    mutate: (copy) =>
      changeSharedLayer(copy, (rule) =>
        rule.walkDecls('z-index', (decl) => {
          decl.value = '39';
        }),
      ),
  },
  {
    name: 'shared important removed',
    prefix: 'F10_SHARED_LAYER_LOST',
    mutate: (copy) =>
      changeSharedLayer(copy, (rule) =>
        rule.walkDecls('z-index', (decl) => {
          decl.important = false;
        }),
      ),
  },
];

// Mutation anchors identify the five original rules, independently of the
// checker's expected occurrence table. All edits stay inside the supplied Map.
const mainRuleSelectors = [
  ['html body .sun-corona', 'html body .solar-corona'],
  ['html body .sun-corona', 'html body .solar-corona'],
  ['html body:has(.sun-corona)', 'html body:has(.solar-corona)'],
  ['html body .sun-corona', 'html body .solar-corona'],
  ['html body .sun-widget', 'html body .solar-widget'],
];

function changeMainRules(sources, change) {
  const root = postcss.parse(sources.get(mainStyleFile));
  const rules = [];
  root.walkRules((rule) => {
    if (mainRuleSelectors.flat().some((selector) => rule.selectors.includes(selector))) {
      rules.push(rule);
    }
  });
  assert.deepEqual(
    rules.map((rule) => rule.selectors),
    mainRuleSelectors,
  );
  change(rules, root);
  sources.set(mainStyleFile, root.toString());
}

const mainLegacyMutations = [
  ['main old sun badge', '.three-globe-sun-badge { width:64px }'],
  [
    'main mobile corona',
    '@media (max-width: 600px) { html body .moon-solar-corona { overflow:hidden } }',
  ],
  [
    'main mobile has corona',
    '@media (max-width: 600px) { html body:has(.moon-solar-corona) { overflow-x:hidden } }',
  ],
  ['main exact moon solar', 'html body .moon-solar { contain:paint }'],
].map(([name, source]) => ({
  name,
  prefix: 'F10_LEGACY_SELECTOR',
  diagnostic: /src\/styles\/main\.css:\d+/,
  mutate: append(mainStyleFile, source),
}));

const mainSharedMutations = [
  ...mainRuleSelectors.map((_, index) => ({
    name: `main R${index + 1} whole rule removed`,
    change: (rules) => rules[index].remove(),
  })),
  ...mainRuleSelectors.flatMap((selectors, index) =>
    selectors.map((selector) => ({
      name: `main R${index + 1} branch removed ${selector}`,
      change: (rules) => {
        rules[index].selectors = rules[index].selectors.filter((branch) => branch !== selector);
      },
    })),
  ),
  ...[
    [0, 'max-width', '35vw'],
    [1, 'clip-path', 'none'],
    [2, 'overflow-x', 'visible'],
    [3, 'contain', 'none'],
    [4, 'max-width', '33vw'],
  ].map(([index, prop, value]) => ({
    name: `main R${index + 1} ${prop} changed to ${value}`,
    change: (rules) =>
      rules[index].walkDecls(prop, (decl) => {
        decl.value = value;
      }),
  })),
  {
    name: 'main R2 right declaration removed',
    change: (rules) => rules[1].walkDecls('right', (decl) => decl.remove()),
  },
  {
    name: 'main R3 important removed',
    change: (rules) =>
      rules[2].walkDecls((decl) => {
        decl.important = false;
      }),
  },
  {
    name: 'main R4 width height order swapped',
    change: (rules) => {
      const [width, height] = rules[3].nodes;
      height.remove();
      rules[3].insertBefore(width, height);
    },
  },
  {
    name: 'main R3 moved out of media',
    change: (rules, root) => {
      rules[2].remove();
      root.append(rules[2]);
    },
  },
  {
    name: 'main R2 R3 media changed to 601px',
    change: (rules) => {
      rules[1].parent.params = '(max-width: 601px)';
    },
  },
  {
    name: 'main R1 R2 occurrence order swapped',
    change: (rules) => {
      const first = rules[0].clone();
      rules[0].replaceWith(rules[1].clone());
      rules[1].replaceWith(first);
    },
  },
  { name: 'main R1 duplicated', change: (rules) => rules[0].cloneAfter() },
  {
    name: 'main R3 has changed to descendant',
    change: (rules) => {
      rules[2].selectors = ['html body .sun-corona', 'html body:has(.solar-corona)'];
    },
  },
].map(({ name, change }) => ({
  name,
  prefix: 'F10_MAIN_SHARED_BRANCH_LOST',
  mutate: (copy) => changeMainRules(copy, change),
}));
mainSharedMutations.push({
  name: 'main file removed from source collection',
  prefix: 'F10_MAIN_SHARED_BRANCH_LOST',
  mutate: (copy) => copy.delete(mainStyleFile),
});

const mainFormatControls = [
  {
    name: 'main selector list whitespace',
    change: (rules) =>
      rules.forEach((rule) => {
        rule.selector = rule.selectors
          .map((selector) => selector.replaceAll(' ', '  \t'))
          .join(' ,\n  ');
      }),
  },
  {
    name: 'main shared rules split into adjacent equivalent rules',
    change: (rules) =>
      rules.forEach((rule) => {
        const [first, second] = rule.selectors;
        rule.cloneAfter({ selector: second });
        rule.selector = first;
      }),
  },
];

const overviewMutations = [
  {
    name: 'summary call removed',
    prefix: 'F10_OVERVIEW_STATS',
    mutate: (copy) =>
      replaceOnce(copy, overviewFile, 'const summary = summarizeMoonPanel(rows);', ''),
  },
  {
    name: 'summary given empty rows',
    prefix: 'F10_OVERVIEW_STATS',
    mutate: (copy) =>
      replaceOnce(
        copy,
        overviewFile,
        'const summary = summarizeMoonPanel(rows);',
        'const summary = summarizeMoonPanel([]);',
      ),
  },
  {
    name: 'monthly cost KPI removed',
    prefix: 'F10_OVERVIEW_COST:total',
    mutate: (copy) =>
      replaceOnce(
        copy,
        overviewFile,
        '<div class="kpi-item"><span>${t(\'monthlyTotalCost\')}</span><strong>${toDisplay(summary.cost.monthlyActual)}</strong></div>',
        '',
      ),
  },
  {
    name: 'region summary removed',
    prefix: 'F10_OVERVIEW_COST:region',
    mutate: removeOverviewSection("${t('monthlyByRegion')}"),
  },
  {
    name: 'provider summary removed',
    prefix: 'F10_OVERVIEW_COST:provider',
    mutate: removeOverviewSection("${t('monthlyByProvider')}"),
  },
  {
    name: 'expiry summary removed',
    prefix: 'F10_OVERVIEW_ALERTS:expiry',
    mutate: removeOverviewSection('data-panel="expiry"'),
  },
  {
    name: 'abnormal summary removed',
    prefix: 'F10_OVERVIEW_ALERTS:abnormal',
    mutate: removeOverviewSection('data-panel="abnormal"'),
  },
  {
    name: 'dead DOM merged into live renderer',
    prefix: 'F10_RENDERED_LEGACY_DOM',
    mutate: (copy) =>
      replaceOnce(
        copy,
        overviewFile,
        '<section class="public-overview-page',
        '<div id="globeSunMount"></div><div class="globe-moon-root" id="globeMoonRoot"><div id="globeMoonPanel"></div></div><section class="public-overview-page',
      ),
  },
  {
    name: 'legacy class in live renderer',
    prefix: 'F10_RENDERED_LEGACY_DOM',
    mutate: (copy) =>
      replaceOnce(
        copy,
        overviewFile,
        '<section class="public-overview-page',
        '<span class="moon-stat"></span><section class="public-overview-page',
      ),
  },
].map((mutation) => ({ ...mutation, check: assertOverviewPreserved }));

describe('F-10 legacy sun/moon DOM removal', () => {
  it('removes even an empty legacy entry module', () => {
    assert.equal(
      existsSync(new URL('../../src/ui/sunMoonEntry.js', import.meta.url)),
      false,
      'F10_LEGACY_FILE_EXISTS',
    );
  });

  it('checks every production JS/JSX/MJS and CSS source without changing the Map', () => {
    const before = [...files];
    assertLegacySunMoonRemoval({ files });
    assert.deepEqual([...files], before);
  });

  it('keeps real overview statistics, costs and alerts with the fixed three-node fixture', () => {
    const html = assertOverviewPreserved({ files });
    assert.match(panelByData(html, 'expiry'), /<span>2 overviewExpiryIn<\/span>/);
  });

  it.each([
    ...staticMutations,
    ...mainLegacyMutations,
    ...mainSharedMutations,
    ...overviewMutations,
  ])('$name: PASS -> $prefix -> PASS', verifyMutation);

  it.each(mainFormatControls)('$name: PASS -> format PASS -> PASS', ({ name, change }) => {
    const copy = new Map(files);
    assertLegacySunMoonRemoval({ files: copy });
    try {
      changeMainRules(copy, change);
      assert.notEqual(copy.get(mainStyleFile), files.get(mainStyleFile));
      assertLegacySunMoonRemoval({ files: copy });
    } finally {
      copy.clear();
      for (const entry of files) copy.set(...entry);
      assertLegacySunMoonRemoval({ files: copy });
    }
    console.log(`F10_FORMAT | ${name} | original=PASS | formatted=PASS | restored=PASS`);
  });

  it('ignores comments, non-source files and similarly named live APIs/classes', () => {
    const copy = new Map(files);
    append(
      'src/allowed.jsx',
      `
      // function renderMoonPanel() {} <div id="globeMoonRoot"></div>
      const label = 'renderSunBadge';
      function summarizeMoonPanel() { return <div className="public-overview-panel" />; }
      function renderMoonPanelPreview() {}
      renderMoonPanel(); // References belong to F-03, not this definition scan.
    `,
    )(copy);
    append(
      overviewFile,
      '// <div id="globeSunMount"></div>\nconst nearId = "globeMoonRootPreview";',
    )(copy);
    append(
      'src/allowed.css',
      `
      /* .globe-moon-root { opacity: 0; } */
      .moon-statistics, .three-globe-sunrise, #globeMoonRootPreview,
      .three-globe-host, .solar-system-hit, .public-overview-panel,
      [data-example=".moon-stat,#globeMoonRoot"] { content: '.globe-moon-root'; }
    `,
    )(copy);
    copy.set('docs/example.js', 'function renderMoonPanel() {}');
    copy.set('evidence/example.css', '.moon-stat { opacity: 0; }');
    copy.set('test/fixture.js', 'function renderSunBadge() {}');
    assertLegacySunMoonRemoval({ files: copy });
  });

  it('allows shared selector branches to be formatted or split into separate rules', () => {
    const copy = new Map(files);
    changeSharedLayer(copy, (rule) => {
      rule.selector = '.globe-hint ,\n  .globe-focus-badge';
    });
    assertLegacySunMoonRemoval({ files: copy });
    changeSharedLayer(copy, (rule) => {
      rule.cloneAfter({ selector: '.globe-focus-badge' });
      rule.selector = '.globe-hint';
    });
    assertLegacySunMoonRemoval({ files: copy });
  });

  it('matches only actual rendered legacy id/class attributes', () => {
    assert.deepEqual(
      legacyTokensInRenderedHtml(`
      <!-- <div id="globeMoonRoot"></div> -->
      <div data-id="globeSunMount" data-class="moon-stat" class="moon-statistics solar-system-hit"></div>
      <div id="globeMoonRootPreview">globeMoonPanel</div>
    `),
      [],
    );
    assert.deepEqual(
      legacyTokensInRenderedHtml('<div id=globeMoonToggle class="current moon-solar-core"></div>'),
      ['globeMoonToggle', 'moon-solar-core'],
    );
  });
});
