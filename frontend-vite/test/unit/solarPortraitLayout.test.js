import { readFileSync } from 'node:fs';
import postcss from 'postcss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimeControls } from '../../src/components/solar/TimeControls.js';

const css = postcss.parse(
  readFileSync(new URL('../../src/styles/starfleet-theme.css', import.meta.url), 'utf8'),
);
const selector = '#solar-system-container[data-solar-viewport]';
const variables = {
  '--solar-tc-top': 'auto',
  '--solar-tc-bottom': '12px',
  '--solar-tc-left': '50%',
  '--solar-tc-transform': 'translateX(-50%)',
  '--solar-tc-width': 'max-content',
};

const ownedSelector = `${selector}[data-solar-mobile-nav]`;
const portraitMedia = '(max-width: 720px) and (orientation: portrait)';
const ownedVariables = {
  '--solar-tc-bottom': 'max(12px, calc(64px + env(safe-area-inset-bottom, 0px) - (100svh - 100%)))',
  '--solar-tc-max-height': 'min(156px, calc(100% - var(--solar-tc-bottom) - 272px))',
  '--solar-tc-overflow-y': 'auto',
};

describe('Solar portrait CSS-source contracts (not native/browser acceptance)', () => {
  it('uses an applicable scoped portrait media rule with joint width/height sizing', () => {
    const media = css.nodes.find(
      (node) =>
        node.type === 'atrule' &&
        node.name === 'media' &&
        node.params === '(max-width: 720px) and (orientation: portrait)',
    );
    expect(media).toBeDefined();
    const rule = media.nodes.find((node) => node.type === 'rule' && node.selector === selector);
    expect(rule).toBeDefined();
    const declarations = Object.fromEntries(rule.nodes.map((node) => [node.prop, node.value]));
    expect(declarations).toMatchObject({
      position: 'relative',
      inset: 'auto',
      width: 'min(100%, calc(100svh * (9 / 16)))',
      height: 'auto',
      'aspect-ratio': '9 / 16',
      'margin-inline': 'auto',
      overflow: 'visible',
      ...variables,
    });
    rule.walkDecls((declaration) => expect(declaration.important).toBeFalsy());
    css.walkRules(selector, (candidate) => {
      if (candidate.parent.type !== 'atrule' || candidate.parent.name !== 'media') return;
      candidate.walkDecls(/^(min|max)-height$/, (declaration) => {
        expect(['0', 'none']).toContain(declaration.value);
      });
    });
  });

  it('declares each control variable only on the owned host inside portrait media', () => {
    for (const [name, value] of Object.entries(variables)) {
      const declarations = [];
      css.walkDecls(name, (declaration) => {
        if (declaration.parent.selector === selector) declarations.push(declaration);
      });
      expect(declarations).toHaveLength(1);
      const declaration = declarations[0];
      expect(declaration.value).toBe(value);
      expect(declaration.important).toBeFalsy();
      expect(declaration.parent.selector).toBe(selector);
      expect(declaration.parent.parent.params).toBe(
        '(max-width: 720px) and (orientation: portrait)',
      );
    }
    css.walkRules((rule) => {
      if (rule.selector.includes('.time-control-panel')) {
        expect(rule.selector).toBe(`${ownedSelector} > .time-control-panel`);
        expect(rule.parent.params).toBe(portraitMedia);
      }
    });
  });

  it('binds dock clearance variables to the exact owning portrait host, not inherited root', () => {
    for (const [name, value] of Object.entries(ownedVariables)) {
      const declarations = [];
      css.walkDecls(name, (declaration) => {
        if (declaration.parent.selector !== selector) declarations.push(declaration);
      });
      expect(declarations).toHaveLength(1);
      expect(declarations[0].value).toBe(value);
      expect(declarations[0].parent.selector).toBe(ownedSelector);
      expect(declarations[0].parent.parent.params).toBe(portraitMedia);
      expect(declarations[0].important).toBeFalsy();
    }
    const controls = [];
    css.walkRules(`${ownedSelector} > .time-control-panel`, (rule) => controls.push(rule));
    expect(controls).toHaveLength(1);
    expect(Object.fromEntries(controls[0].nodes.map((node) => [node.prop, node.value]))).toEqual({
      'overscroll-behavior': 'contain',
      'box-sizing': 'border-box',
    });
    expect(controls[0].parent.params).toBe(portraitMedia);
  });
});

class ControlElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.style = { cssText: '' };
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.listeners = new Map();
  }
  setAttribute(name, value) {
    this.attributes.set(name, value);
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(callback);
  }
  dispatch(name, event = {}) {
    this.listeners.get(name)?.forEach((callback) => callback(event));
  }
  remove() {
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
}

describe('TimeControls behavior with an external DOM boundary', () => {
  let container;
  let controls;
  let onRate;

  beforeEach(() => {
    vi.stubGlobal('document', { createElement: (tagName) => new ControlElement(tagName) });
    container = new ControlElement('div');
    onRate = vi.fn();
    controls = new TimeControls(container, onRate);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('keeps direct-child ownership and original desktop/landscape style fallbacks', () => {
    expect(container.children).toEqual([controls.element]);
    expect(controls.element.parentElement).toBe(container);
    const styles = Object.fromEntries(
      controls.element.style.cssText
        .split(';')
        .filter(Boolean)
        .map((declaration) => declaration.split(/:(.*)/s).slice(0, 2)),
    );
    expect(styles).toEqual({
      position: 'absolute',
      left: 'var(--solar-tc-left,12px)',
      top: 'var(--solar-tc-top,12px)',
      bottom: 'var(--solar-tc-bottom,auto)',
      transform: 'var(--solar-tc-transform,none)',
      width: 'var(--solar-tc-width,auto)',
      'max-height': 'var(--solar-tc-max-height,none)',
      'overflow-y': 'var(--solar-tc-overflow-y,visible)',
      'z-index': '20',
      'max-width': 'calc(100% - 24px)',
      padding: '8px',
      background: 'rgba(5,12,25,.9)',
      color: '#fff',
      font: '12px/1.5 sans-serif',
      'pointer-events': 'auto',
      'border-radius': '6px',
    });
  });

  it('retains every rate and realtime callback, details/summary and stopEvent without preventDefault', () => {
    controls.buttons.forEach((button) => button.dispatch('click'));
    const toolbar = controls.element.children.find(
      (child) => child.attributes.get('role') === 'toolbar',
    );
    toolbar.children.find((child) => child.dataset.action === 'return-realtime').dispatch('click');
    expect(onRate.mock.calls).toEqual([[1], [60], [3600], [86400], [1]]);
    expect(controls.source.tagName).toBe('details');
    expect(controls.source.children[0].tagName).toBe('summary');
    expect(controls.source.children[0].textContent).toBe('数据来源 / 中心 / 时间假设');
    expect(controls.source.children[0].listeners.size).toBe(0);
    for (const name of [
      'pointerdown',
      'pointerup',
      'click',
      'dblclick',
      'wheel',
      'touchstart',
      'touchmove',
      'touchend',
    ]) {
      const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
      expect(controls.element.listeners.get(name)).toEqual([controls.stopEvent]);
      controls.element.dispatch(name, event);
      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
  });

  it('retains status/rate updates and removes only its own nav on disposal', () => {
    const unrelated = container.appendChild(new ControlElement('div'));
    controls.update(
      { utcMs: 0, rate: 60, jdTdb: 2451545, mode: 'manual' },
      { status: 'ready', lastAppliedJd: 2451545, lastAppliedUtcMs: 0 },
    );
    expect(controls.time.textContent).toBe('2451545.000000000 JD TDB (LSK extrapolated) ');
    expect(controls.mode.dataset.mode).toBe('manual');
    expect(controls.buttons.map((button) => button.attributes.get('aria-pressed'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);
    expect(controls.element.dataset.status).toBe('ready');
    controls.dispose();
    expect(container.children).toEqual([unrelated]);
  });
});
