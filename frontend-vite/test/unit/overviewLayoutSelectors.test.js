import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { expect, it } from 'vitest';

const main = postcss.parse(
  readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8'),
);
const theme = postcss.parse(
  readFileSync(new URL('../../src/styles/starfleet-theme.css', import.meta.url), 'utf8'),
);
const sharedConsole = postcss.parse(
  readFileSync(new URL('../../src/styles/detail-starfleet-console.css', import.meta.url), 'utf8'),
);

it('excludes v2 from the actual legacy left padding while preserving overview and detail', () => {
  const declarations = [];
  theme.walkDecls('padding-left', (declaration) => {
    if (declaration.value === 'max(28px, 3.2vw)' && declaration.important) {
      declarations.push(declaration);
    }
  });
  expect(declarations).toHaveLength(1);
  expect(declarations[0].parent.selector.split(',').map((selector) => selector.trim())).toEqual([
    '.public-overview-page:not(.overview-layout-v2)',
    '.detail-page-shell',
  ]);
});

it('excludes v2 from all actual legacy root padding overrides and retains normal mobile 12px', () => {
  const declarations = [];
  for (const stylesheet of [main, sharedConsole]) {
    stylesheet.walkRules((rule) => {
      const roots = rule.selector
        .split(',')
        .filter((selector) => /^\s*\.public-overview-page[^\s]*\s*$/.test(selector));
      if (!roots.length) return;
      rule.walkDecls((declaration) => {
        if (
          !declaration.important ||
          !/^padding(?:-left|-right|-top|-bottom)?$/.test(declaration.prop)
        )
          return;
        declarations.push(declaration);
        expect(roots.every((selector) => selector.includes(':not(.overview-layout-v2)'))).toBe(
          true,
        );
      });
    });
  }
  expect(declarations.length).toBeGreaterThan(0);
  expect(declarations.some((declaration) => declaration.value === '8px')).toBe(true);
  const padding = [];
  theme.walkAtRules('media', (media) => {
    if (media.params !== '(width < 768px)') return;
    media.walkRules((rule) => {
      if (rule.selector !== '.public-overview-page.overview-layout-v2') return;
      rule.walkDecls('padding', (declaration) => padding.push(declaration));
    });
  });
  expect(padding).toHaveLength(1);
  expect(padding[0].value).toBe('12px 12px 0');
  expect(padding[0].important).toBeFalsy();
});

it('excludes v2 from the real shared-console mobile 8px override without changing its value', () => {
  const declarations = [];
  sharedConsole.walkDecls('padding', (declaration) => {
    if (
      declaration.important &&
      declaration.value === '8px' &&
      declaration.parent.selector.includes('.public-overview-page.starship-console-page')
    )
      declarations.push(declaration);
  });
  expect(declarations).toHaveLength(1);
  expect(declarations[0].parent.selector).toBe(
    '.public-overview-page.starship-console-page:not(.overview-layout-v2)',
  );
  expect(declarations[0].parent.parent.params).toBe('(max-width: 768px)');
});

it('excludes v2 from every real important node grid override, including the bare mixed branch', () => {
  const declarations = [];
  main.walkDecls('grid-template-columns', (declaration) => {
    if (declaration.important && declaration.parent.selector.includes('.public-overview-list'))
      declarations.push(declaration);
  });
  expect(declarations).toHaveLength(5);
  expect(declarations.map((declaration) => declaration.value)).toEqual([
    'repeat(auto-fit, minmax(300px, 1fr))',
    'repeat(4, minmax(0, 1fr))',
    'repeat(2, minmax(0, 1fr))',
    '1fr',
    '1fr',
  ]);
  expect(declarations[0].parent.selector).toBe(
    '.public-overview-page .public-overview-list:not(.overview-v2-list)',
  );
  for (const declaration of declarations.slice(1, 4)) {
    expect(declaration.parent.selector).toBe(
      '.public-overview-page:not(.overview-layout-v2) .public-overview-list',
    );
  }
  expect(declarations.slice(1).map((declaration) => declaration.parent.parent.params)).toEqual([
    undefined,
    '(max-width: 900px)',
    '(max-width: 760px)',
    '(max-width: 900px)',
  ]);
  expect(declarations[4].parent.selector.split(',').map((selector) => selector.trim())).toEqual([
    '.public-overview-stats',
    '.public-overview-expiry',
    '.public-overview-costs',
    '.public-overview-metrics',
    '.public-overview-list:where(:not(.overview-layout-v2 .public-overview-list))',
    '.overview-card-grid',
  ]);
});

function gridColumns(selector, width) {
  let columns;
  theme.walkRules((rule) => {
    if (rule.selector !== selector) return;
    if (rule.parent.type === 'atrule') {
      const limit = rule.parent.params.match(/^\(width < (\d+)px\)$/);
      expect(limit).not.toBeNull();
      if (width >= Number(limit[1])) return;
    }
    rule.walkDecls('grid-template-columns', (declaration) => {
      columns = declaration.value;
    });
  });
  return columns;
}

it.each([768, 1023, 1024, 1200, 1279, 1280, 1440])(
  'aligns tablet summary and node columns at %i',
  (width) => {
    const expected = `repeat(${width < 1280 ? 2 : 4}, minmax(0, 1fr))`;
    expect(
      gridColumns('.public-overview-page.overview-layout-v2 .overview-summary-grid', width),
    ).toBe(expected);
    expect(
      gridColumns(
        '.public-overview-page.overview-layout-v2 .public-overview-list.overview-v2-list',
        width,
      ),
    ).toBe(expected);
  },
);

it('preserves mobile summary columns, final full-width cards and single-column nodes', () => {
  expect(gridColumns('.public-overview-page.overview-layout-v2 .overview-summary-grid', 390)).toBe(
    'repeat(2, minmax(0, 1fr))',
  );
  expect(
    gridColumns(
      '.public-overview-page.overview-layout-v2 .public-overview-list.overview-v2-list',
      390,
    ),
  ).toBe('minmax(0, 1fr)');
  const spans = [];
  theme.walkDecls('grid-column', (declaration) => {
    if (declaration.parent.selector.includes('.overview-summary-card[data-overview-summary='))
      spans.push(declaration);
  });
  expect(spans).toHaveLength(1);
  expect(spans[0].parent.selector).toContain('[data-overview-summary="cost"]');
  expect(spans[0].parent.selector).toContain('[data-overview-summary="expiry"]');
  expect(spans[0].value).toBe('span 2');
});
