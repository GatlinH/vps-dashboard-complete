import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHitFixture } from '../helpers/solarHitFixture.js';
import { probesAt } from '../helpers/solarHitGeometry.js';

const css = postcss.parse(
  readFileSync(new URL('../../src/styles/starfleet-theme.css', import.meta.url), 'utf8'),
);
function declarations(selector) {
  const result = {};
  css.walkRules((rule) => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls((decl) => (result[decl.prop] = decl.value.replace(/\s+/g, ' ')));
    }
  });
  return result;
}
afterEach(() => vi.unstubAllGlobals());

describe('circular hit CSS contract (not native browser measurement)', () => {
  it('(a) applies a border-box circle(50%) to all three real button builders', () => {
    const { system } = createHitFixture(probesAt(2.14, 0, { x: 195, y: 100 }, 30));
    expect(system.hitButtons).toHaveLength(3);
    for (const { el } of system.hitButtons) expect(el.className).toBe('solar-system-hit');
    const base = declarations('.solar-system-hit');
    expect(base['clip-path']).toBe('circle(50%)');
    expect(base['box-sizing']).toBe('border-box');
    expect(base.padding).toBe('0');
    expect(base.border).toBe('0');
  });

  it('(b) has a 24 by 24 CSS fallback matching runtime BOX=24', () => {
    const base = declarations('.solar-system-hit');
    expect([base.width, base.height]).toEqual(['24px', '24px']);
    const { system } = createHitFixture(probesAt(2.14, 0, { x: 195, y: 100 }, 30));
    for (const { el } of system.hitButtons)
      expect([el.style.width, el.style.height]).toEqual(['24px', '24px']);
  });

  it('(c) gives keyboard focus and hover the internal black-white-black ring', () => {
    for (const selector of ['.solar-system-hit:hover', '.solar-system-hit:focus-visible']) {
      const active = declarations(selector);
      expect(active.outline).toBe('none');
      expect(active['box-shadow']).toBe(
        'inset 0 0 0 2px #000, inset 0 0 0 4px #fff, inset 0 0 0 6px #000',
      );
      expect(active['forced-color-adjust']).toBe('none');
      expect(active['outline-offset']).toBeUndefined();
    }
    const base = declarations('.solar-system-hit');
    expect(base.outline).toBe('none');
    expect(base['box-shadow']).toBe('none');
  });
});
