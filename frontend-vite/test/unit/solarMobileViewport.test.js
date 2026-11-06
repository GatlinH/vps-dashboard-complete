import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    WebGLRenderer: class {
      constructor(parameters) {
        this.parameters = parameters;
        this.domElement = document.createElement('canvas');
        this.pixelRatio = 1;
        this.info = { render: { frame: 0 }, programs: [] };
        this.materialProperties = new Map();
        this.properties = { get: (material) => this.materialProperties.get(material) || {} };
        this.gl = {
          NO_ERROR: 0,
          LINK_STATUS: 35714,
          getError: () => 0,
          isContextLost: () => false,
          getProgramParameter: () => true,
          getParameter: () => [1, 64],
        };
        this.render = vi.fn((scene) => {
          scene.updateMatrixWorld(true);
          scene.traverse((object) => {
            if (object.material?.isShaderMaterial) {
              const currentProgram = { program: {}, diagnostics: { runnable: true } };
              this.materialProperties.set(object.material, { currentProgram });
              this.info.programs.push(currentProgram);
            }
          });
          this.info.render.frame += 1;
        });
        this.setPixelRatio = vi.fn((ratio) => {
          this.pixelRatio = ratio;
        });
        this.setSize = vi.fn((width, height) => {
          this.domElement.width = Math.floor(width * this.pixelRatio);
          this.domElement.height = Math.floor(height * this.pixelRatio);
        });
        this.dispose = vi.fn();
      }
      getContext() {
        return this.gl;
      }
      getPixelRatio() {
        return this.pixelRatio;
      }
      getDrawingBufferSize(target) {
        return target.set(this.domElement.width, this.domElement.height);
      }
    },
  };
});

class EventSource {
  listeners = new Map();
  addEventListener(name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name).add(callback);
  }
  removeEventListener(name, callback) {
    this.listeners.get(name)?.delete(callback);
  }
  emit(name) {
    [...(this.listeners.get(name) || [])].forEach((callback) => callback({ type: name }));
  }
  listenerCount(name) {
    return this.listeners.get(name)?.size || 0;
  }
}

function rect(width, height, left = 0, top = 0) {
  return { width, height, left, top, right: left + width, bottom: top + height };
}

class Element extends EventSource {
  constructor(tagName, solarLayout = false) {
    super();
    this.tagName = tagName;
    this.solarLayout = solarLayout;
    const declarations = new Map();
    this.style = {
      position: '',
      visibility: '',
      pointerEvents: '',
      getPropertyValue: (name) => declarations.get(name)?.value || '',
      getPropertyPriority: (name) => declarations.get(name)?.priority || '',
      setProperty: (name, value, priority = '') => declarations.set(name, { value, priority }),
      removeProperty: (name) => declarations.delete(name),
    };
    this.dataset = {};
    this.attributes = new Map();
    this.children = [];
    this.tabIndex = 0;
    this.disabled = false;
    this.inert = false;
  }
  get parentElement() {
    return this.parentNode;
  }
  get clientWidth() {
    return this.getBoundingClientRect().width;
  }
  get clientHeight() {
    return this.getBoundingClientRect().height;
  }
  appendChild(child) {
    child.remove();
    this.children.push(child);
    child.parentNode = this;
    return child;
  }
  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }
  removeChild(child) {
    this.children = this.children.filter((entry) => entry !== child);
    child.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  getBoundingClientRect() {
    if (this.tagName === 'canvas' && this.parentNode)
      return this.parentNode.getBoundingClientRect();
    if (this.getAttribute('data-solar-mobile-landscape') === 'true') {
      return rect(
        parseFloat(this.style.getPropertyValue('--solar-viewport-width')),
        parseFloat(this.style.getPropertyValue('--solar-viewport-height')),
        parseFloat(this.style.getPropertyValue('--solar-viewport-left')),
        parseFloat(this.style.getPropertyValue('--solar-viewport-top')),
      );
    }
    if (this.solarLayout) {
      return rect(
        window.innerWidth,
        window.innerWidth * (window.innerWidth <= 720 ? 9 / 16 : 1 / 2),
      );
    }
    return rect(960, 540);
  }
  getContext() {
    return new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'createImageData') {
            return (width, height) => ({ data: new Uint8ClampedArray(width * height * 4) });
          }
          if (property === 'createLinearGradient' || property === 'createRadialGradient') {
            return () => ({ addColorStop() {} });
          }
          return () => {};
        },
      },
    );
  }
}

const systems = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 7),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(() => new THREE.Texture());
});

afterEach(() => {
  systems.splice(0).forEach((solar) => {
    if (!solar.disposed) solar.destroy();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function environment({
  width = 844,
  height = 390,
  dpr = 3,
  pointer = 'coarse',
  hover = 'none',
  visual = true,
} = {}) {
  const media = new Map();
  const input = { pointer, hover };
  const view = Object.assign(new EventSource(), {
    __DBG__: {},
    innerWidth: width,
    innerHeight: height,
    devicePixelRatio: dpr,
  });
  const visualViewport = visual
    ? Object.assign(new EventSource(), {
        width,
        height,
        offsetLeft: 0,
        offsetTop: 0,
        scale: 1,
      })
    : undefined;
  view.visualViewport = visualViewport;
  view.matchMedia = (query) => {
    if (!media.has(query)) {
      const matches = () =>
        query.split(',').some((branch) =>
          branch
            .trim()
            .split(/\s+and\s+/)
            .every((condition) => {
              const size = condition.match(/^\(max-(width|height):\s*(\d+)px\)$/);
              if (size)
                return view[size[1] === 'width' ? 'innerWidth' : 'innerHeight'] <= Number(size[2]);
              if (condition === '(pointer: coarse)') return input.pointer === 'coarse';
              if (condition === '(hover: none)') return input.hover === 'none';
              if (condition === '(orientation: landscape)')
                return view.innerWidth > view.innerHeight;
              throw new Error(`Unsupported media condition: ${condition}`);
            }),
        );
      const source = new EventSource();
      Object.defineProperty(source, 'matches', { get: matches });
      source.previousMatches = matches();
      media.set(query, source);
    }
    return media.get(query);
  };
  vi.stubGlobal('window', view);
  vi.stubGlobal('navigator', { maxTouchPoints: 5 });
  vi.stubGlobal('document', {
    createElement: (tag) => new Element(tag),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    body: new Element('body'),
    documentElement: new Element('html'),
  });
  vi.stubGlobal('getComputedStyle', (element) => ({
    position:
      element.style.position ||
      (element.getAttribute('data-solar-mobile-landscape') === 'true' ? 'fixed' : 'static'),
  }));
  const notifyMedia = () =>
    media.forEach((source) => {
      if (source.matches !== source.previousMatches) {
        source.previousMatches = source.matches;
        source.emit('change');
      }
    });
  return {
    view,
    visualViewport,
    media,
    input,
    notifyMedia,
    mount(container = new Element('div', true)) {
      container.setAttribute('data-solar-viewport', '');
      const solar = new SolarSystem(container, { fetchImpl: () => new Promise(() => {}) });
      systems.push(solar);
      return solar;
    },
    rotate(nextWidth, nextHeight) {
      view.innerWidth = nextWidth;
      view.innerHeight = nextHeight;
      if (visualViewport)
        Object.assign(visualViewport, {
          width: nextWidth,
          height: nextHeight,
          offsetLeft: 0,
          offsetTop: 0,
        });
      notifyMedia();
      view.emit('resize');
    },
  };
}

function expectContentBox(solar, width, height, dpr, left = 0, top = 0) {
  const actual = solar.container.getBoundingClientRect();
  const overflow = Math.max(
    0,
    actual.right - (left + width),
    actual.bottom - (top + height),
    left - actual.left,
    top - actual.top,
  );
  expect(overflow).toBe(0);
  expect(actual).toEqual(rect(width, height, left, top));
  expect(solar.canvas.getBoundingClientRect()).toEqual(actual);
  expect(solar.camera.aspect).toBeCloseTo(width / height, 12);
  expect(solar.camera.fov).toBe(52);
  expect(solar.renderer.getPixelRatio()).toBe(dpr);
  expect(solar.renderer.getDrawingBufferSize(new THREE.Vector2()).toArray()).toEqual([
    Math.floor(width * dpr),
    Math.floor(height * dpr),
  ]);
}

describe('SolarSystem owned mobile viewport and DPR budget', () => {
  it.each([
    [1, 1],
    [3, 1.5],
  ])('classifies cold touch landscape at device DPR %s without upsampling', (dpr, expected) => {
    const fixture = environment({ dpr });
    const solar = fixture.mount();
    expect(solar.isMobile).toBe(true);
    expect(solar.renderer.parameters.antialias).toBe(false);
    expect(solar.renderer.getPixelRatio()).toBe(expected);
  });

  it('fits the cold touch landscape content box with zero viewport overflow', () => {
    expectContentBox(environment().mount(), 844, 390, 1.5);
  });

  it.each([1, 3])('uses the same box and budget across both rotations at DPR %s', (dpr) => {
    const fixture = environment({ width: 390, height: 844, dpr });
    const solar = fixture.mount();
    const renderer = solar.renderer;
    const expected = Math.min(dpr, 1.5);
    expectContentBox(solar, 390, 219.375, expected);
    fixture.rotate(844, 390);
    expect(solar.isMobile).toBe(true);
    expectContentBox(solar, 844, 390, expected);
    fixture.rotate(390, 844);
    expectContentBox(solar, 390, 219.375, expected);
    expect(solar.container.getAttribute('data-solar-mobile-landscape')).toBe('false');
    expect(solar.container.style.getPropertyValue('--solar-viewport-height')).toBe('');
    expect(solar.renderer).toBe(renderer);
    expect(renderer.dispose).not.toHaveBeenCalled();
  });

  it.each([
    ['fine', 'hover'],
    ['coarse', 'hover'],
    ['fine', 'none'],
  ])(
    'keeps %s/%s desktop input out of the new touch branch even with touch points',
    (pointer, hover) => {
      const solar = environment({ pointer, hover }).mount();
      expect(solar.isMobile).toBe(false);
      expect(solar.renderer.getPixelRatio()).toBe(2);
      expect(solar.renderer.parameters.antialias).toBe(true);
    },
  );

  it('preserves desktop 1280x900 and device DPR1', () => {
    const solar = environment({
      width: 1280,
      height: 900,
      dpr: 1,
      pointer: 'fine',
      hover: 'hover',
    }).mount();
    expect(solar.isMobile).toBe(false);
    expectContentBox(solar, 1280, 640, 1);
  });

  it('preserves the old narrow non-touch portrait layout and budget', () => {
    const solar = environment({ width: 390, height: 844, pointer: 'fine', hover: 'hover' }).mount();
    expect(solar.isMobile).toBe(true);
    expectContentBox(solar, 390, 219.375, 1.5);
  });

  it('uses the AGY 500px layout-height boundary rather than a measured overflow threshold', () => {
    const fixture = environment({ width: 844, height: 500 });
    const solar = fixture.mount();
    expect(solar.isMobile).toBe(true);
    expectContentBox(solar, 844, 500, 1.5);
    fixture.rotate(844, 501);
    expect(solar.isMobile).toBe(false);
    expect(solar.renderer.getPixelRatio()).toBe(2);
    expect(solar.container.getAttribute('data-solar-mobile-landscape')).toBe('false');
  });

  it('refreshes mobile budget on media changes without a window resize', () => {
    const fixture = environment({ pointer: 'fine', hover: 'hover' });
    const solar = fixture.mount();
    fixture.input.pointer = 'coarse';
    fixture.input.hover = 'none';
    fixture.notifyMedia();
    expect(solar.isMobile).toBe(true);
    expectContentBox(solar, 844, 390, 1.5);
    fixture.input.pointer = 'fine';
    fixture.input.hover = 'hover';
    fixture.notifyMedia();
    expect(solar.isMobile).toBe(false);
    expect(solar.renderer.getPixelRatio()).toBe(2);
  });

  it('tracks available visualViewport dimensions and layout-relative offsets without scaling DPR', () => {
    const fixture = environment();
    const solar = fixture.mount();
    Object.assign(fixture.visualViewport, {
      width: 812,
      height: 350,
      offsetLeft: 12,
      offsetTop: 20,
    });
    fixture.visualViewport.emit('resize');
    expectContentBox(solar, 812, 350, 1.5, 12, 20);
    Object.assign(fixture.visualViewport, {
      width: 422,
      height: 195,
      offsetLeft: 120,
      offsetTop: 30,
      scale: 2,
    });
    fixture.visualViewport.emit('scroll');
    expectContentBox(solar, 422, 195, 1.5, 120, 30);
  });

  it('does not turn a keyboard-reduced portrait visual viewport into landscape', () => {
    const fixture = environment({ width: 390, height: 844 });
    const solar = fixture.mount();
    fixture.visualViewport.height = 300;
    fixture.visualViewport.emit('resize');
    expectContentBox(solar, 390, 219.375, 1.5);
    expect(solar.container.getAttribute('data-solar-mobile-landscape')).toBe('false');
  });

  it('falls back to layout viewport dimensions when visualViewport is absent', () => {
    expectContentBox(environment({ visual: false }).mount(), 844, 390, 1.5);
  });

  it('refreshes the device DPR on resize while retaining the mobile cap', () => {
    const fixture = environment({ width: 390, height: 844 });
    const solar = fixture.mount();
    fixture.view.devicePixelRatio = 1;
    fixture.view.emit('resize');
    expectContentBox(solar, 390, 219.375, 1);
  });

  it('owns only its container and restores previous attributes, CSS values, priorities and listeners', () => {
    const fixture = environment();
    const container = new Element('div', true);
    container.setAttribute('data-solar-mobile-landscape', 'previous');
    container.style.setProperty('--solar-viewport-width', '77px', 'important');
    const unrelated = new Element('div');
    const solar = fixture.mount(container);
    expectContentBox(solar, 844, 390, 1.5);
    expect(unrelated.getAttribute('data-solar-mobile-landscape')).toBeNull();
    expect(document.documentElement.getAttribute('data-solar-mobile-landscape')).toBeNull();
    expect(
      [...fixture.media.values()].every((source) => source.listenerCount('change') === 1),
    ).toBe(true);
    expect(fixture.visualViewport.listenerCount('resize')).toBe(1);
    expect(fixture.visualViewport.listenerCount('scroll')).toBe(1);
    solar.destroy();
    expect(container.getAttribute('data-solar-mobile-landscape')).toBe('previous');
    expect(container.getAttribute('data-solar-viewport')).toBe('');
    expect(container.style.getPropertyValue('--solar-viewport-width')).toBe('77px');
    expect(container.style.getPropertyPriority('--solar-viewport-width')).toBe('important');
    expect(container.style.getPropertyValue('--solar-viewport-height')).toBe('');
    expect(
      [...fixture.media.values()].every((source) => source.listenerCount('change') === 0),
    ).toBe(true);
    expect(fixture.visualViewport.listenerCount('resize')).toBe(0);
    expect(fixture.visualViewport.listenerCount('scroll')).toBe(0);
    expect(fixture.view.listenerCount('resize')).toBe(0);
    const calls = solar.renderer.setSize.mock.calls.length;
    fixture.rotate(390, 844);
    fixture.visualViewport.emit('scroll');
    solar.resize();
    expect(solar.renderer.setSize).toHaveBeenCalledTimes(calls);
    expect(solar.running).toBe(false);
    expect(solar.frameId).toBe(0);
  });

  it('releases one instance without removing another container ownership or subscriptions', () => {
    const fixture = environment();
    const first = fixture.mount();
    const second = fixture.mount();
    first.destroy();
    expect(first.container.getAttribute('data-solar-mobile-landscape')).toBeNull();
    expect(second.container.getAttribute('data-solar-mobile-landscape')).toBe('true');
    expect(fixture.visualViewport.listenerCount('resize')).toBe(1);
    expect(
      [...fixture.media.values()].every((source) => source.listenerCount('change') === 1),
    ).toBe(true);
    fixture.rotate(390, 844);
    expectContentBox(second, 390, 219.375, 1.5);
    expect(second.renderer.dispose).not.toHaveBeenCalled();
  });

  it('connects the scoped CSS content box and canvas to owned viewport parameters (static, not browser geometry)', () => {
    const css = readFileSync(
      new URL('../../src/styles/starfleet-theme.css', import.meta.url),
      'utf8',
    );
    const containerRule =
      css.match(/\[data-solar-mobile-landscape="true"\]\s*\{([^}]+)\}/)?.[1] || '';
    const canvasRule =
      css.match(/\[data-solar-mobile-landscape="true"\]\s*>\s*canvas\s*\{([^}]+)\}/)?.[1] || '';
    expect(containerRule).toContain('position: fixed !important');
    expect(containerRule).toContain('width: var(--solar-viewport-width)');
    expect(containerRule).toContain('height: var(--solar-viewport-height)');
    expect(containerRule).toContain('left: var(--solar-viewport-left)');
    expect(containerRule).toContain('top: var(--solar-viewport-top)');
    expect(containerRule).toContain('min-height: 0');
    expect(containerRule).toContain('aspect-ratio: auto');
    expect(canvasRule).toContain('position: absolute');
    expect(canvasRule).toContain('inset: 0');
    expect(canvasRule).toContain('aspect-ratio: auto');
  });
});
