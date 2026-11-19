import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { parse } from 'acorn';
import { build } from 'vite';
import { beforeAll, expect, it } from 'vitest';

const marker = "#pageRoot[data-theme-style='lcars']";
const css = () =>
  postcss.parse(
    readFileSync(new URL('../../src/styles/overview-lcars.css', import.meta.url), 'utf8'),
  );

it('parses actual scoped cold HUD tokens without added important declarations', () => {
  const tokens = new Map();
  css().walkRules((rule) => {
    expect(
      rule.selectors.every(
        (selector) =>
          selector.startsWith(marker) ||
          selector.startsWith(`html:has(${marker})`) ||
          selector.startsWith(`html[data-theme='light']:has(${marker})`),
      ),
    ).toBe(true);
    rule.walkDecls((declaration) => {
      expect(declaration.important).toBeFalsy();
      expect(declaration.value).not.toMatch(/#(?:ff9900|9999ff|ff9966|ffcc66)\b/i);
      if (rule.selector === marker) tokens.set(declaration.prop, declaration.value);
    });
  });
  expect(Object.fromEntries(tokens)).toMatchObject({
    '--hud-cyan-primary': '#00e5ff',
    '--hud-cyan-dim': '#0090b0',
    '--hud-text-primary': '#e2e8f0',
    '--hud-text-muted': '#7289a5',
    '--hud-bg': '#080c14',
    '--hud-panel': 'rgba(13, 22, 38, 0.85)',
    '--hud-glow-alpha': '0.15',
    '--hud-glow': '0 0 8px rgba(0, 229, 255, 0.15)',
    '--hud-text-glow': '0 0 4px rgba(0, 229, 255, 0.4)',
  });
});

it('keeps decoration inert, controls touchable and mobile padding unified', () => {
  const declarations = [];
  css().walkDecls((declaration) => declarations.push(declaration));
  expect(
    declarations.some(
      (declaration) =>
        declaration.prop === 'pointer-events' &&
        declaration.value === 'none' &&
        /::(?:before|after)/.test(declaration.parent.selector),
    ),
  ).toBe(true);
  expect(
    declarations.some(
      (declaration) =>
        declaration.prop === 'min-height' &&
        declaration.value === '36px' &&
        declaration.parent.selector.includes('button'),
    ),
  ).toBe(true);
  expect(
    declarations
      .filter((declaration) => declaration.prop === 'padding-bottom')
      .map((declaration) => declaration.value),
  ).toEqual(['calc(52px + 16px + env(safe-area-inset-bottom, 0px))']);
});

it('isolates actual legacy important material declarations using an ancestor-aware guard', () => {
  for (const file of ['main.css', 'starfleet-theme.css', 'detail-starfleet-console.css']) {
    const legacy = postcss.parse(
      readFileSync(new URL(`../../src/styles/${file}`, import.meta.url), 'utf8'),
    );
    legacy.walkRules((rule) => {
      if (
        !rule.nodes.some(
          (declaration) =>
            declaration.important &&
            /^(background.*|border.*|box-shadow|backdrop-filter|filter|text-shadow|color|transform)$/.test(
              declaration.prop,
            ),
        )
      )
        return;
      for (const selector of rule.selectors) {
        if (
          (!/overview|starship-console-page/.test(selector) &&
            !genericMaterialSelectors.has(selector.split(':where(')[0]) &&
            !mobileControlSelectors.has(selector.split(':where(')[0])) ||
          selector.includes('.detail-page-shell')
        )
          continue;
        expect(selector).toContain('data-theme-style="lcars"');
        expect(selector).toMatch(/:where\(:not\((?:#pageRoot|:has\(#pageRoot)/);
      }
    });
  }
});

const genericMaterialSelectors = new Set([
  '.theme-toggle',
  '.currency-switch',
  '.currency-btn',
  '.currency-btn.active',
  'select',
]);
const mobileControlSelectors = new Set([
  '.public-overview-floating-topbar button',
  '.public-overview-floating-topbar select',
]);
let compiledCss;

beforeAll(async () => {
  const productionConfig = readFileSync(new URL('../../vite.config.js', import.meta.url), 'utf8');
  expect(productionConfig).not.toMatch(/\bcss(?:Minify|Target)\s*:/);
  const minify = productionConfig.match(/\bminify:\s*'([^']+)'/)[1];
  const output = await build({
    configFile: false,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    publicDir: false,
    logLevel: 'silent',
    build: {
      minify,
      write: false,
      emptyOutDir: false,
      rollupOptions: {
        input: fileURLToPath(new URL('../../src/styles/main.css', import.meta.url)),
      },
    },
  });
  const asset = output.output.find(
    (entry) => entry.type === 'asset' && entry.fileName.endsWith('.css'),
  );
  expect(asset).toBeDefined();
  compiledCss = postcss.parse(String(asset.source));
});

function normalizedSelector(selector) {
  return selector
    .replaceAll(/['"]/g, '')
    .replaceAll(/\s*>\s*/g, '>')
    .replaceAll(/::(before|after)/g, ':$1');
}

function scopedDeclarations(root, target, property, scope = marker) {
  const declarations = [];
  root.walkRules((rule) => {
    if (
      rule.selectors.some(
        (selector) => normalizedSelector(selector) === normalizedSelector(`${scope} ${target}`),
      )
    ) {
      rule.walkDecls(property, (declaration) => declarations.push(declaration));
    }
  });
  return declarations;
}

function overviewSourceLeaves() {
  const source = readFileSync(new URL('../../src/pages/overviewPage.js', import.meta.url), 'utf8');
  const functions = parse(source, { ecmaVersion: 'latest', sourceType: 'module' }).body.map(
    (entry) => entry.declaration ?? entry,
  );
  const template = (name) =>
    functions
      .find((entry) => entry.id?.name === name)
      .body.body.find((entry) => entry.type === 'ReturnStatement').argument;
  const metric = template('renderOverviewMetric');
  const card = template('renderOverviewNodeCard');
  const html = card.quasis
    .map(
      (part, index) =>
        part.value.cooked +
        (card.expressions[index]?.callee?.name === 'renderOverviewMetric'
          ? metric.quasis.map((entry) => entry.value.cooked).join('')
          : ''),
    )
    .join('');
  const stack = [{ tag: 'div', attributes: { id: 'pageRoot', 'data-theme-style': 'lcars' } }];
  const nodes = [];
  for (const match of html.matchAll(/<(\/)?([a-z][\w-]*)([^>]*)>/gi)) {
    if (match[1]) {
      stack.pop();
      continue;
    }
    const attributes = Object.fromEntries(
      [...match[3].matchAll(/([\w-]+)="([^"]*)"/g)].map((entry) => [entry[1], entry[2]]),
    );
    const node = { tag: match[2], attributes, parent: stack.at(-1) };
    nodes.push(node);
    stack.push(node);
  }
  const hasClass = (node, name) => (node?.attributes.class ?? '').split(/\s+/).includes(name);
  const metrics = nodes.filter((node) => hasClass(node, 'overview-metric-value'));
  const stats = nodes.filter(
    (node) => node.tag === 'strong' && hasClass(node.parent.parent, 'overview-card-stats'),
  );
  const title = nodes.filter(
    (node) => node.tag === 'strong' && hasClass(node.parent.parent, 'public-overview-head'),
  );
  const residual = nodes.filter((node) => hasClass(node, 'overview-residual-btn'));
  expect(metrics).toHaveLength(4);
  expect(metrics.every((node) => node.tag === 'strong')).toBe(true);
  expect(stats).toHaveLength(4);
  expect(title).toHaveLength(1);
  expect(residual).toHaveLength(1);
  return {
    title,
    numeric: [...metrics, ...stats, ...residual],
    body: nodes.filter((node) => node.tag === 'b'),
  };
}

function matchesLeaf(selector, leaf) {
  const parts = [[]];
  const combinators = [];
  for (const token of selector.nodes) {
    if (token.type === 'combinator') {
      combinators.push(token.value.trim());
      parts.push([]);
    } else parts.at(-1).push(token);
  }
  const matchesPart = (part, node) =>
    node &&
    part.every((token) => {
      if (token.type === 'tag') return token.value === node.tag;
      if (token.type === 'id') return token.value === node.attributes.id;
      if (token.type === 'class')
        return (node.attributes.class ?? '').split(/\s+/).includes(token.value);
      if (token.type === 'attribute')
        return token.operator === '=' && node.attributes[token.attribute] === token.value;
      return token.type === 'universal';
    });
  const match = (index, node) => {
    if (!matchesPart(parts[index], node)) return false;
    if (index === 0) return true;
    if (combinators[index - 1] === '>') return match(index - 1, node.parent);
    if (combinators[index - 1] !== '') return false;
    for (let parent = node.parent; parent; parent = parent.parent)
      if (match(index - 1, parent)) return true;
    return false;
  };
  return match(parts.length - 1, leaf);
}

function leafDeclarations(root, leaf, property) {
  const candidates = [];
  root.walkRules((rule) => {
    for (const text of rule.selectors) {
      if (!normalizedSelector(text).startsWith(normalizedSelector(marker))) continue;
      const selector = selectorParser().astSync(text).first;
      if (!matchesLeaf(selector, leaf)) continue;
      const specificity = ['id', 'class', 'tag'].map(
        (type) =>
          selector.nodes.filter(
            (token) => token.type === type || (type === 'class' && token.type === 'attribute'),
          ).length,
      );
      rule.walkDecls(property, (declaration) =>
        candidates.push({ declaration, specificity, order: candidates.length }),
      );
    }
  });
  return candidates.sort(
    (first, second) =>
      Number(first.declaration.important) - Number(second.declaration.important) ||
      first.specificity[0] - second.specificity[0] ||
      first.specificity[1] - second.specificity[1] ||
      first.specificity[2] - second.specificity[2] ||
      first.order - second.order,
  );
}

function assertOverviewLeafCascade(root, leaves) {
  for (const leaf of [...leaves.title, ...leaves.numeric]) {
    for (const [property, value] of [
      ['color', 'var(--hud-cyan-primary)'],
      ['text-shadow', 'var(--hud-text-glow)'],
    ]) {
      const candidates = leafDeclarations(root, leaf, property);
      expect(candidates.length, `${leaf.tag}: positive matching declaration count`).toBeGreaterThan(
        0,
      );
      expect(
        candidates.some((entry) => entry.declaration.value === value),
        `${leaf.tag}: positive cyan/glow count`,
      ).toBe(true);
      expect(candidates.at(-1).declaration.value, `${leaf.tag}: actual cascade winner`).toBe(value);
      expect(candidates.at(-1).declaration.important).toBeFalsy();
    }
  }
  for (const leaf of leaves.numeric) {
    expect(leafDeclarations(root, leaf, 'font-variant-numeric').at(-1)?.declaration.value).toBe(
      'tabular-nums',
    );
    expect(leafDeclarations(root, leaf, 'font-family').at(-1)?.declaration.value).toContain(
      'monospace',
    );
  }
  expect(leaves.body.length).toBeGreaterThan(0);
  for (const leaf of leaves.body) {
    expect(leafDeclarations(root, leaf, 'color').at(-1)?.declaration.value).toBe(
      'var(--hud-text-primary)',
    );
    expect(leafDeclarations(root, leaf, 'text-shadow').at(-1)?.declaration.value).toBe('none');
  }
}

it('binds actual source DOM titles and numeric STRONG leaves to winning source and compiled cyan rules', () => {
  const leaves = overviewSourceLeaves();
  for (const root of [css(), compiledCss]) assertOverviewLeafCascade(root, leaves);
});

it('rejects restored weak metric and nonexistent title/stats selectors in source and compiled CSS', () => {
  const leaves = overviewSourceLeaves();
  for (const root of [css(), compiledCss]) {
    assertOverviewLeafCascade(root, leaves);
    for (const [target, old] of [
      ['.overview-metric strong.overview-metric-value', '.overview-metric-value'],
      ['.public-overview-head>div>strong', '.public-overview-name'],
      ['.overview-card-stats strong', '.overview-card-stats b'],
      ['.overview-card-stats .overview-residual-btn', '.overview-nonexistent-residual-btn'],
    ]) {
      const mutated = root.clone();
      let count = 0;
      mutated.walkRules((rule) => {
        rule.selectors = rule.selectors.map((selector) => {
          if (normalizedSelector(selector) !== normalizedSelector(`${marker} ${target}`))
            return selector;
          count += 1;
          return `${marker} ${old}`;
        });
      });
      expect(count, `${target}: positive mutation count`).toBeGreaterThan(0);
      expect(
        () => assertOverviewLeafCascade(mutated, leaves),
        `${target}: mutation must fail`,
      ).toThrow();
    }
  }
});

it('keeps group-count leaf text inheriting the compliant button foreground after real compilation', () => {
  for (const root of [compiledCss, css()]) {
    const declarations = scopedDeclarations(root, '.overview-group-tab > b', 'color');
    expect(
      declarations.length,
      'the scoped count-leaf override must survive compilation',
    ).toBeGreaterThan(0);
    expect(declarations.at(-1).value).toBe('inherit');
    expect(declarations.at(-1).important).toBeFalsy();
  }
  for (const target of ['.overview-group-tab b', '.overview-group-tab.is-active b']) {
    const declarations = [];
    compiledCss.walkRules((rule) => {
      if (rule.selectors.some((selector) => normalizedSelector(selector) === target)) {
        rule.walkDecls('color', (declaration) => declarations.push(declaration));
      }
    });
    expect(
      declarations.length,
      `${target}: the actual legacy leaf color remains present`,
    ).toBeGreaterThan(0);
    expect(declarations.every((declaration) => declaration.value !== 'inherit')).toBe(true);
  }
});

it('keeps standard AND prefixed material branches in the actual Vite-minified CSS', () => {
  for (const target of [
    '.overview-summary-card',
    '.public-overview-card.is-v2-card',
    '.overview-ping',
    'button',
    'select',
  ]) {
    for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
      const declarations = scopedDeclarations(compiledCss, target, property);
      console.info(
        `HUD_MINIFIED_MATERIAL ${target} ${property}=${declarations.map((entry) => entry.value).join(',')}`,
      );
      expect(
        declarations.length,
        `${target}: ${property} must survive the production minifier`,
      ).toBeGreaterThan(0);
      const expected = target.includes('card') ? 'blur(12px)' : 'none';
      expect(declarations.every((entry) => entry.value === expected && !entry.important)).toBe(
        true,
      );
    }
  }
  for (const property of ['backdrop-filter', '-webkit-backdrop-filter']) {
    const declarations = scopedDeclarations(
      compiledCss,
      '.mobile-bottom-nav',
      property,
      `html:has(${marker})`,
    );
    expect(declarations.length, `Dock ${property} must survive compilation`).toBeGreaterThan(0);
    expect(declarations.every((entry) => entry.value === 'blur(12px)' && !entry.important)).toBe(
      true,
    );
  }
});

it('excludes generic important materials after real compilation; removing any ancestor guard fails', () => {
  const found = new Set();
  compiledCss.walkRules((rule) => {
    if (!rule.nodes.some((entry) => entry.type === 'decl' && entry.important)) return;
    for (const selector of rule.selectors) {
      const target = selector.split(':where(')[0];
      if (!genericMaterialSelectors.has(target)) continue;
      found.add(target);
      expect(normalizedSelector(selector)).toContain(
        ':where(:not(#pageRoot[data-theme-style=lcars] *))',
      );
    }
  });
  expect(found).toEqual(genericMaterialSelectors);
});

it('isolates the old 34px mobile important geometry; restoring either overview branch fails', () => {
  for (const root of [
    postcss.parse(readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8')),
    compiledCss,
  ]) {
    const found = new Set();
    root.walkRules((rule) => {
      if (
        !rule.nodes.some(
          (entry) => entry.prop === 'min-height' && entry.important && entry.value === '34px',
        )
      )
        return;
      for (const selector of rule.selectors) {
        const target = selector.split(':where(')[0];
        if (!mobileControlSelectors.has(target)) continue;
        found.add(target);
        expect(normalizedSelector(selector)).toContain(
          ':where(:not(#pageRoot[data-theme-style=lcars] *))',
        );
      }
    });
    expect(found).toEqual(mobileControlSelectors);
  }
  for (const target of ['button', 'select']) {
    expect(
      scopedDeclarations(compiledCss, target, 'min-height').map((entry) => entry.value),
    ).toEqual(['36px']);
  }
});

it('restores symmetric compact grids without a fabricated height budget', () => {
  for (const root of [css(), compiledCss]) {
    for (const target of ['.overview-summary-grid', '.overview-v2-list']) {
      expect(scopedDeclarations(root, target, 'gap').map((entry) => entry.value)).toEqual(
        target.includes('summary') ? ['16px', '12px'] : ['16px'],
      );
      const columns = scopedDeclarations(root, target, 'grid-template-columns');
      expect(columns.map((entry) => entry.value.replaceAll(/\s/g, ''))).toEqual(
        target.includes('summary')
          ? ['repeat(4,minmax(0,1fr))', 'repeat(2,minmax(0,1fr))']
          : ['repeat(4,minmax(0,1fr))', 'repeat(2,minmax(0,1fr))', '1fr'],
      );
      expect(columns[1].parent.parent.params).toMatch(/(?:width\s*<\s*1280px|max-width:\s*1279px)/);
      expect(scopedDeclarations(root, target, 'row-gap')).toEqual([]);
    }
    expect(
      scopedDeclarations(root, '.lcars-theme-applied', 'padding').map((entry) => entry.value),
    ).toEqual(['12px 24px 0', '12px 12px 0']);
    for (const [property, value] of [
      ['width', '100%'],
      ['max-width', '1440px'],
      ['margin', '0 auto'],
    ]) {
      expect(
        scopedDeclarations(root, '.lcars-theme-applied', property).map((entry) => entry.value),
      ).toEqual([value]);
    }
    for (const key of ['cost', 'expiry']) {
      expect(
        scopedDeclarations(root, `[data-overview-summary='${key}']`, 'grid-column').map(
          (entry) => entry.value,
        ),
      ).toEqual(['span 2']);
    }
  }
  expect(scopedDeclarations(css(), '.overview-summary-card', 'height')).toEqual([]);
  expect(scopedDeclarations(css(), '.overview-summary-card', 'max-height')).toEqual([]);
  expect(scopedDeclarations(css(), '.overview-summary-card', 'overflow')).toEqual([]);
});

function luminance(hex) {
  const expanded =
    hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}` : hex;
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(expanded.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function themeTokens(root, daylight = false) {
  const selector = daylight ? `${marker}:where(html[data-theme='light'] *)` : marker;
  const tokens = new Map();
  root.walkRules((rule) => {
    if (normalizedSelector(rule.selector) !== normalizedSelector(selector)) return;
    rule.walkDecls((entry) => tokens.set(entry.prop, entry.value));
  });
  for (const token of [
    'bg',
    'panel',
    'text-primary',
    'text-muted',
    'cyan-primary',
    'cyan-dim',
    'decor',
    'focus',
    'active',
  ]) {
    expect(tokens.get(`--hud-${token}`), `${selector}: missing HUD ${token}`).toBeTruthy();
  }
  return tokens;
}

it('uses symmetric inert brackets, tabular cyan data and native focus without clipping', () => {
  for (const root of [css(), compiledCss]) {
    let found = 0;
    root.walkRules((rule) => {
      if (
        !rule.selectors.some(
          (selector) =>
            normalizedSelector(selector).startsWith(normalizedSelector(marker)) ||
            /^html(?:\[data-theme=light\])?:has\(#pageRoot\[data-theme-style=lcars\]\)/.test(
              normalizedSelector(selector),
            ),
        )
      )
        return;
      found += 1;
      expect(rule.selector).not.toMatch(/\.lcars-(?:frame|elbow|beam|rail|endcap)/);
      rule.walkDecls((entry) => {
        expect(entry.prop).not.toMatch(/^(?:clip-path|animation.*)$/);
        if (/^overflow/.test(entry.prop)) expect(entry.value).not.toMatch(/hidden|clip/);
      });
    });
    expect(found).toBeGreaterThan(0);
    for (const target of ['.overview-summary-card', '.public-overview-card.is-v2-card']) {
      expect(scopedDeclarations(root, target, 'border-radius').map((entry) => entry.value)).toEqual(
        ['4px'],
      );
      expect(scopedDeclarations(root, target, 'box-shadow').map((entry) => entry.value)).toEqual([
        'var(--hud-glow)',
      ]);
      for (const pseudo of ['::before', '::after']) {
        expect(
          scopedDeclarations(root, `${target}${pseudo}`, 'pointer-events').map(
            (entry) => entry.value,
          ),
        ).toEqual(['none']);
        expect(scopedDeclarations(root, `${target}${pseudo}`, 'content').length).toBeGreaterThan(0);
      }
    }
    for (const target of [
      '.overview-summary-value',
      '.overview-metric strong.overview-metric-value',
    ]) {
      expect(
        scopedDeclarations(root, target, 'font-variant-numeric').map((entry) => entry.value),
      ).toEqual(['tabular-nums']);
      expect(scopedDeclarations(root, target, 'color').at(-1)?.value).toBe(
        'var(--hud-cyan-primary)',
      );
      expect(scopedDeclarations(root, target, 'text-shadow').at(-1)?.value).toBe(
        'var(--hud-text-glow)',
      );
    }
    for (const target of ['button', 'select', '.overview-summary-details > summary']) {
      for (const property of ['min-height', 'min-width']) {
        expect(scopedDeclarations(root, target, property).map((entry) => entry.value)).toEqual([
          '36px',
        ]);
      }
    }
    expect(
      scopedDeclarations(root, ':focus-visible', 'outline').map((entry) => entry.value),
    ).toEqual(['2px solid var(--hud-focus)']);
    expect(
      scopedDeclarations(root, ':focus-visible', 'outline-offset').map((entry) => entry.value),
    ).toEqual(['2px']);
  }
});

it.each(['source', 'compiled'])(
  '%s currency wrapper keeps native focus visible over the unchanged baseline',
  (mode) => {
    const root = mode === 'source' ? css() : compiledCss;
    const baselineRoot =
      mode === 'source'
        ? postcss.parse(
            readFileSync(new URL('../../src/styles/dashboard.css', import.meta.url), 'utf8'),
          )
        : compiledCss;
    const visible = scopedDeclarations(root, '.detail-currency-switch', 'overflow');
    expect(
      visible,
      'missing scoped HUD currency wrapper overflow-visible override',
    ).not.toHaveLength(0);
    expect(visible.map((entry) => entry.value)).toEqual(['visible']);
    expect(visible.every((entry) => !entry.important)).toBe(true);
    const hidden = [];
    baselineRoot.walkRules((rule) => {
      if (rule.selectors.some((selector) => normalizedSelector(selector) === '.currency-switch')) {
        rule.walkDecls('overflow', (entry) => hidden.push(entry));
      }
    });
    expect(hidden).not.toHaveLength(0);
    expect(hidden.map((entry) => entry.value)).toEqual(['hidden']);
    expect(hidden.every((entry) => !entry.important)).toBe(true);
    const wrapper = {
      tag: 'div',
      attributes: { class: 'currency-switch detail-currency-switch' },
      parent: { tag: 'div', attributes: { id: 'pageRoot', 'data-theme-style': 'lcars' } },
    };
    const specificity = (entry) => {
      const selector = selectorParser().astSync(
        entry.parent.selectors.find((text) =>
          matchesLeaf(selectorParser().astSync(text).first, wrapper),
        ),
      ).first;
      return ['id', 'class', 'tag'].map(
        (type) =>
          selector.nodes.filter(
            (token) => token.type === type || (type === 'class' && token.type === 'attribute'),
          ).length,
      );
    };
    const compare = (first, second) => {
      const firstScore = specificity(first);
      const secondScore = specificity(second);
      return (
        firstScore[0] - secondScore[0] ||
        firstScore[1] - secondScore[1] ||
        firstScore[2] - secondScore[2]
      );
    };
    for (const baseline of hidden) expect(compare(visible[0], baseline)).toBeGreaterThan(0);
    expect([...visible, ...hidden].sort(compare).at(-1).value).toBe('visible');
  },
);

it('meets AA for actual composited dark/day body, muted and selected-control tokens', () => {
  const composite = (rgba, background) => {
    if (/^#[\da-f]{6}$/i.test(rgba)) return rgba;
    const channels = rgba.match(/[\d.]+/g).map(Number);
    expect(channels).toHaveLength(4);
    return `#${channels
      .slice(0, 3)
      .map((channel, index) =>
        Math.round(
          channel * channels[3] +
            parseInt(background.slice(index * 2 + 1, index * 2 + 3), 16) * (1 - channels[3]),
        )
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')}`;
  };
  expect(Object.fromEntries(themeTokens(css(), true))).toMatchObject({
    '--hud-bg': '#ecf2f8',
    '--hud-panel': '#ffffff',
    '--hud-text-primary': '#0f172a',
    '--hud-text-muted': '#334155',
    '--hud-cyan-primary': '#0b6b82',
    '--hud-decor': '#0891b2',
  });
  for (const daylight of [false, true]) {
    const tokens = themeTokens(css(), daylight);
    const panel = composite(tokens.get('--hud-panel'), tokens.get('--hud-bg'));
    const active = composite(tokens.get('--hud-active'), panel);
    for (const foreground of ['text-primary', 'text-muted', 'cyan-primary', 'cyan-dim']) {
      for (const background of [
        tokens.get('--hud-bg'),
        panel,
        ...(foreground === 'cyan-primary' ? [active] : []),
      ]) {
        const first = luminance(tokens.get(`--hud-${foreground}`));
        const second = luminance(background);
        expect(
          (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
        ).toBeGreaterThanOrEqual(foreground === 'text-primary' && !daylight ? 7 : 4.5);
      }
    }
  }
});
