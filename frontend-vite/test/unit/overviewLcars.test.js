import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { build } from 'vite';
import { beforeAll, expect, it } from 'vitest';

const marker = "#pageRoot[data-theme-style='lcars']";
const css = () =>
  postcss.parse(
    readFileSync(new URL('../../src/styles/overview-lcars.css', import.meta.url), 'utf8'),
  );

it('parses actual scoped LCARS tokens without glass or added important declarations', () => {
  const tokens = new Map();
  css().walkRules((rule) => {
    expect(
      rule.selectors.every(
        (selector) => selector.startsWith(marker) || selector.startsWith(`html:has(${marker})`),
      ),
    ).toBe(true);
    rule.walkDecls((declaration) => {
      expect(declaration.important).toBeFalsy();
      expect(declaration.value).not.toMatch(/blur\(|rgba?\(|gradient\(/);
      if (rule.selector === marker) tokens.set(declaration.prop, declaration.value);
    });
  });
  expect(Object.fromEntries(tokens)).toMatchObject({
    '--lcars-primary': '#ff9900',
    '--lcars-secondary': '#9999ff',
    '--lcars-peach': '#ff9966',
    '--lcars-pale': '#ffcc66',
    '--lcars-bg': '#000',
    '--lcars-panel': '#05050a',
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
        declaration.parent.selector.includes('.lcars-frame'),
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
  return selector.replaceAll(/['"]/g, '').replaceAll(/\s*>\s*/g, '>');
}

function scopedDeclarations(root, target, property) {
  const declarations = [];
  root.walkRules((rule) => {
    if (
      rule.selectors.some(
        (selector) => normalizedSelector(selector) === normalizedSelector(`${marker} ${target}`),
      )
    ) {
      rule.walkDecls(property, (declaration) => declarations.push(declaration));
    }
  });
  return declarations;
}

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

it('keeps standard AND prefixed resets in the actual Vite-minified CSS; reverting reset order fails', () => {
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
        `LCARS_MINIFIED_RESET ${target} ${property}=${declarations.map((entry) => entry.value).join(',')}`,
      );
      expect(
        declarations.length,
        `${target}: ${property} must survive the production minifier`,
      ).toBeGreaterThan(0);
      expect(declarations.every((entry) => entry.value === 'none' && !entry.important)).toBe(true);
    }
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

it('fits the observed desktop 436px budget using only compiled row spacing; reverting the gap fails', () => {
  const declarations = scopedDeclarations(compiledCss, '.overview-summary-grid', 'row-gap');
  expect(declarations.map((entry) => entry.value)).toEqual(['8px']);
  expect(declarations[0].parent.parent.type).toBe('atrule');
  expect(declarations[0].parent.parent.params).toMatch(
    /(?:width\s*>=\s*1280px|min-width:\s*1280px)/,
  );
  const observedNodeTop = 450;
  const observedRowGap = 16;
  const summaryRowCount = 3;
  const projectedNodeTop =
    observedNodeTop - (summaryRowCount - 1) * (observedRowGap - parseFloat(declarations[0].value));
  expect(projectedNodeTop).toBeLessThanOrEqual(436);
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

it('meets AA for the actual dark and daylight body, muted and selected-control token pairs', () => {
  css().walkRules((rule) => {
    if (!rule.selector.startsWith(marker) || rule.selector.includes(' .')) return;
    const tokens = new Map(
      rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
    );
    if (!tokens.has('--lcars-text')) return;
    for (const [foreground, background] of [
      ['--lcars-text', '--lcars-panel'],
      ['--lcars-muted', '--lcars-panel'],
      ['--lcars-on-accent', '--lcars-secondary'],
    ]) {
      const first = luminance(tokens.get(foreground));
      const second = luminance(tokens.get(background));
      expect(
        (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05),
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
