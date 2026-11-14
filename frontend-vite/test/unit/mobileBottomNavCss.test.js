import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { transform } from 'lightningcss';
import { describe, expect, it } from 'vitest';

const dashboard = postcss.parse(
  readFileSync(new URL('../../src/styles/dashboard.css', import.meta.url), 'utf8'),
);
const owned = postcss.parse(
  readFileSync(new URL('../../src/styles/starfleet-theme.css', import.meta.url), 'utf8'),
);
const portraitMedia = '(max-width: 720px) and (orientation: portrait)';

function declarations(rule) {
  return Object.fromEntries(
    rule.nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]),
  );
}

function portraitRule(selector) {
  const matches = [];
  owned.walkRules((rule) => {
    if (
      rule.selector === selector &&
      rule.parent.type === 'atrule' &&
      rule.parent.name === 'media' &&
      rule.parent.params === portraitMedia
    ) {
      matches.push(rule);
    }
  });
  expect(matches).toHaveLength(1);
  return matches[0];
}

function dockRule() {
  const matches = [];
  owned.walkRules((rule) => {
    if (
      rule.selector.endsWith('.mobile-bottom-nav') &&
      rule.parent.type === 'atrule' &&
      rule.parent.name === 'media' &&
      rule.parent.params === portraitMedia
    ) {
      matches.push(rule);
    }
  });
  expect(matches).toHaveLength(1);
  return matches[0];
}

function specificity(selector) {
  const identifiers = selector.match(/#[\w-]+/g) ?? [];
  const classes = selector.match(/\.[\w-]+|\[[^\]]+\]/g) ?? [];
  const remainder = selector.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]/g, '');
  expect(remainder).toMatch(/^[\w\s>*-]*$/);
  const types = remainder.match(/[a-z][\w-]*/gi) ?? [];
  return [identifiers.length, classes.length, types.length];
}

describe('Mobile dock CSS-source/cascade contracts (not native/browser acceptance)', () => {
  it('retains both compiled blur declarations at the shared app boundary', () => {
    const compiled = transform({
      filename: 'starfleet-theme.css',
      code: Buffer.from(owned.toString()),
      minify: true,
    }).code.toString();
    expect(compiled).toMatch(
      /#app>nav\.mobile-bottom-nav\{[^}]*-webkit-backdrop-filter:blur\(16px\)/,
    );
    expect(compiled).toMatch(
      /@supports\s*\(backdrop-filter:blur\(16px\)\)\{#app>nav\.mobile-bottom-nav\{backdrop-filter:blur\(16px\)/,
    );
  });

  it('includes the real generic nav and dark/mobile declarations that caused the cascade failure', () => {
    const base = [];
    const mobile = [];
    const dark = [];
    dashboard.walkRules('nav', (rule) => {
      if (rule.parent.type === 'root') base.push(rule);
      if (
        rule.parent.type === 'atrule' &&
        rule.parent.name === 'media' &&
        rule.parent.params === '(max-width: 768px)'
      ) {
        mobile.push(rule);
      }
    });
    dashboard.walkRules('[data-theme="dark"] nav', (rule) => dark.push(rule));
    expect(base).toHaveLength(1);
    expect(mobile).toHaveLength(1);
    expect(dark).toHaveLength(1);
    expect(declarations(base[0])).toMatchObject({
      'align-items': 'center',
      'justify-content': 'space-between',
      padding: '0 40px',
      height: '70px',
    });
    expect(declarations(mobile[0])).toMatchObject({
      'flex-direction': 'column',
      gap: '15px',
      padding: '15px',
      height: 'auto',
    });
    expect(declarations(dark[0]).background).toBe('rgba(15, 23, 42, 0.75)');
  });

  it('explicitly resets the dock to a horizontal zero-gap row with stretched equal-width buttons', () => {
    expect(declarations(dockRule())).toMatchObject({
      display: 'flex',
      'flex-direction': 'row',
      'align-items': 'stretch',
      'justify-content': 'center',
      gap: '0',
      padding: '0 0 env(safe-area-inset-bottom, 0px)',
    });
    expect(declarations(portraitRule('.mobile-bottom-nav > button'))).toMatchObject({
      flex: '1 1 0',
      'min-width': '0',
      'min-height': '48px',
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'center',
      'justify-content': 'center',
      padding: '0',
      font: '11px/1.2 sans-serif',
    });
  });

  it('owns the native nav with higher specificity than every real generic nav selector, including dark', () => {
    const dock = dockRule();
    expect(dock.selector).toBe('#app > nav.mobile-bottom-nav');
    const generic = [];
    dashboard.walkRules((rule) => {
      for (const selector of rule.selectors) {
        if (selector === 'nav' || selector.endsWith(' nav')) generic.push(selector);
      }
    });
    expect(generic.length).toBeGreaterThan(0);
    expect(generic).toContain('[data-theme="dark"] nav');
    const ownedSpecificity = specificity(dock.selector);
    for (const selector of generic) {
      const genericSpecificity = specificity(selector);
      const difference = ownedSpecificity.findIndex(
        (value, index) => value !== genericSpecificity[index],
      );
      expect(difference).toBeGreaterThanOrEqual(0);
      expect(ownedSpecificity[difference]).toBeGreaterThan(genericSpecificity[difference]);
    }
    dock.walkDecls((declaration) => expect(declaration.important).toBeFalsy());
  });

  it('preserves the exact safe-area height and both source blur declarations with the agreed material', () => {
    const dock = dockRule();
    expect(declarations(dock)).toMatchObject({
      position: 'fixed',
      inset: 'auto 0 0',
      height: 'calc(52px + env(safe-area-inset-bottom, 0px))',
      'box-sizing': 'border-box',
      'z-index': '30',
      background: 'rgba(255,245,248,.78)',
      'backdrop-filter': 'blur(16px)',
      '-webkit-backdrop-filter': 'blur(16px)',
      'border-top': '1px solid rgba(255,182,193,.35)',
    });
    const safeAreaPadding = [];
    dock.walkDecls(/^padding(?:-.+)?$/, (declaration) => {
      if (declaration.value.includes('safe-area-inset-bottom')) safeAreaPadding.push(declaration);
    });
    expect(safeAreaPadding).toHaveLength(1);
    expect(safeAreaPadding[0].prop).toBe('padding');
  });

  it('preserves standard blur in an exact owned portrait supports branch without important', () => {
    const branches = [];
    owned.walkAtRules('supports', (branch) => {
      if (
        branch.params === '(backdrop-filter: blur(16px))' &&
        branch.parent.type === 'atrule' &&
        branch.parent.name === 'media' &&
        branch.parent.params === portraitMedia
      ) {
        branches.push(branch);
      }
    });
    expect(branches).toHaveLength(1);
    expect(branches[0].nodes).toHaveLength(1);
    const rule = branches[0].nodes[0];
    expect(rule.type).toBe('rule');
    expect(rule.selector).toBe('#app > nav.mobile-bottom-nav');
    expect(rule.nodes).toHaveLength(1);
    const declaration = rule.nodes[0];
    expect(declaration.type).toBe('decl');
    expect(declaration.prop).toBe('backdrop-filter');
    expect(declaration.value).toBe('blur(16px)');
    expect(declaration.important).toBeFalsy();
  });

  it('keeps the dock hidden outside owned portrait media and preserves icons, colors and visible focus', () => {
    const hidden = [];
    owned.walkRules((rule) => {
      if (rule.parent.type === 'root' && rule.selectors.includes('.mobile-bottom-nav')) {
        hidden.push(rule);
      }
    });
    expect(hidden).toHaveLength(1);
    expect(declarations(hidden[0]).display).toBe('none');
    expect(declarations(portraitRule('.mobile-bottom-nav-icon'))).toMatchObject({
      width: '22px',
      height: '22px',
    });
    expect(declarations(portraitRule('.mobile-bottom-nav > button')).color).toBe('#6b7280');
    expect(
      declarations(portraitRule('.mobile-bottom-nav > button[aria-pressed="true"]')).color,
    ).toBe('#ff3b77');
    expect(declarations(portraitRule('.mobile-bottom-nav > button:focus-visible'))).toMatchObject({
      outline: '2px solid #ff3b77',
      'outline-offset': '-2px',
    });
  });
});
