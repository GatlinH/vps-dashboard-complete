import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';

vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    WebGLRenderer: class {
      constructor() {
        this.domElement = document.createElement('canvas');
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
      }
      getContext() {
        return this.gl;
      }
      getDrawingBufferSize(target) {
        return target.set(960, 540);
      }
      setSize() {}
      setPixelRatio() {}
      dispose() {}
    },
  };
});

const slots = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'moon',
  'earth_clouds',
  'saturn_ring',
];
const systems = [];
let monotonic;
let wall;

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.style = { position: '', visibility: '', pointerEvents: '' };
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.children = [];
    this.clientWidth = 960;
    this.clientHeight = 540;
    this.tabIndex = 0;
    this.disabled = false;
    this.inert = false;
  }
  get parentElement() {
    return this.parentNode;
  }
  get textContent() {
    return this._textContent ?? this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this._textContent = value;
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
  addEventListener(name, callback) {
    this.listeners.set(name, callback);
  }
  removeEventListener(name) {
    this.listeners.delete(name);
  }
  click() {
    if (!this.disabled && !this.inert) this.listeners.get('click')?.({ stopPropagation() {} });
  }
  getBoundingClientRect() {
    return { width: 960, height: 540, left: 0, top: 0 };
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

beforeEach(() => {
  monotonic = 100;
  wall = Date.UTC(2026, 10, 3, 9);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
  vi.stubGlobal('window', {
    __DBG__: {},
    innerWidth: 960,
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal('document', {
    createElement: (tag) => new Element(tag),
    addEventListener() {},
    removeEventListener() {},
    visibilityState: 'visible',
    body: new Element('body'),
  });
  vi.stubGlobal('getComputedStyle', (element) => ({
    position: element.style.position || 'static',
  }));
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 7),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  systems.splice(0).forEach((solar) => {
    if (!solar.disposed) solar.destroy();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function start({ manifest, manifestPending = false, scienceError = false } = {}) {
  const requests = [];
  const images = new Map();
  let releaseScience;
  let releaseManifest;
  let failing = scienceError;
  const scienceGate = new Promise((resolve) => {
    releaseScience = resolve;
  });
  const manifestGate = new Promise((resolve) => {
    releaseManifest = resolve;
  });
  const manifestData =
    manifest ??
    JSON.parse(
      readFileSync(
        new URL('../../public/assets/solar/textures-v1/manifest.json', import.meta.url),
        'utf8',
      ),
    );
  const fetchImpl = vi.fn(async (url, options) => {
    requests.push({ url, signal: options?.signal });
    if (url.includes('textures-v1/manifest')) {
      if (manifestPending) await manifestGate;
      return new Response(JSON.stringify(manifestData));
    }
    await scienceGate;
    if (failing) return new Response('unavailable', { status: 503 });
    return new Response(readFileSync(new URL(`../../public${url}`, import.meta.url)));
  });
  vi.stubGlobal('fetch', fetchImpl);
  vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation(
    (url, onLoad, _progress, onError) => {
      const texture = new THREE.Texture();
      const dispose = vi.spyOn(texture, 'dispose');
      images.set(url, {
        texture,
        dispose,
        success: () => onLoad(texture),
        failure: () => onError?.(new Error('404')),
      });
      return texture;
    },
  );
  const container = new Element('div');
  const solar = new SolarSystem(container, { fetchImpl });
  systems.push(solar);
  return {
    solar,
    container,
    images,
    requests,
    releaseScience,
    releaseManifest,
    recover: () => {
      failing = false;
    },
    background: () => images.get('/globe/backgrounds/heic1509a-bg.jpg'),
    finishImages: () => images.forEach((image) => image.success()),
  };
}

async function drain() {
  for (let iteration = 0; iteration < 40; iteration += 1) await Promise.resolve();
}

async function scienceReady(fixture) {
  fixture.releaseScience();
  for (let iteration = 0; iteration < 40; iteration += 1) {
    await drain();
    fixture.solar._tick();
    if (fixture.solar.ephemerisStatus.status === 'ready') return;
  }
  expect(fixture.solar.ephemerisStatus).toMatchObject({ status: 'ready', error: null });
}

function deadline() {
  monotonic = 4100;
  wall += 4000;
}

describe('atomic production startup', () => {
  it('hides the measured canvas and disables body buttons before any successful real sample', async () => {
    const fixture = start();
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    expect(fixture.solar.canvas.style.display).toBe('block');
    expect(fixture.solar.canvas.getBoundingClientRect()).toMatchObject({ width: 960, height: 540 });
    expect(
      fixture.solar.hitButtons.every(({ el }) => el.disabled && el.inert && el.tabIndex === -1),
    ).toBe(true);
    expect(
      fixture.container.children.some((element) => element.textContent?.includes('LOADING')),
    ).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    await drain();
    expect(fixture.requests.every(({ signal }) => signal instanceof AbortSignal)).toBe(true);
  });

  it('commits exactly eleven terminal choices including missing slots, malformed tiers and absent targets', async () => {
    const fixture = start({
      manifest: {
        textures: {
          mercury: { tiers: { desktop: { file: 'mercury.jpg' } }, color_space: 'srgb' },
          venus: { tiers: {} },
          earth_clouds: { tiers: { desktop: { file: 'clouds.jpg' } } },
        },
      },
    });
    fixture.solar.earthCloudMesh = null;
    await drain();
    fixture.finishImages();
    await fixture.solar.textureLoadPromise;
    const state = fixture.solar._startupSnapshot();
    expect(Object.keys(state.slots)).toEqual(slots);
    expect(state.slots.mercury.state).toBe('SUCCESS');
    for (const name of slots.filter((name) => name !== 'mercury')) {
      expect(state.slots[name]).toMatchObject({
        state: 'COMMITTED_FALLBACK',
        owner: state.activeMountId,
      });
      expect(state.slots[name].reason).toBeTruthy();
      expect(state.slots[name].resource).not.toBeUndefined();
    }
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
  });

  it('settles never-called loaders at the fixed visual deadline without publishing unready science', async () => {
    const fixture = start();
    await drain();
    deadline();
    vi.advanceTimersByTime(4000);
    await fixture.solar.textureLoadPromise;
    const state = fixture.solar._startupSnapshot();
    expect(Object.values(state.slots).every((slot) => slot.state === 'COMMITTED_FALLBACK')).toBe(
      true,
    );
    expect(state.background).toMatchObject({
      state: 'READY',
      kind: 'FALLBACK',
      owner: state.activeMountId,
    });
    expect(state.phase).toBe('LOADING');
    expect(state.firstFrame).toBe(null);
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
  }, 1500);

  it('checks the deadline in callbacks even when the timer has not run and rejects late manifests', async () => {
    const fixture = start({ manifestPending: true });
    deadline();
    fixture.background().success();
    fixture.releaseManifest();
    await drain();
    expect(fixture.solar.scene.background.isColor).toBe(true);
    expect(fixture.background().dispose).toHaveBeenCalledTimes(1);
    expect(fixture.images.size).toBe(1);
    await fixture.solar.textureLoadPromise;
    expect(
      Object.values(fixture.solar._startupSnapshot().slots).every(
        (slot) => slot.state === 'COMMITTED_FALLBACK',
      ),
    ).toBe(true);
  });

  it('does not treat the initial background color as owned readiness; an explicit 404 fallback unlocks it', async () => {
    const fixture = start();
    await drain();
    fixture.images.forEach((image, url) => {
      if (!url.includes('backgrounds')) image.success();
    });
    await scienceReady(fixture);
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    expect(fixture.solar._startupSnapshot().background.state).toBe('PENDING');
    fixture.background().failure();
    fixture.solar._tick();
    expect(fixture.solar._startupSnapshot()).toMatchObject({
      phase: 'FIRST_VISIBLE',
      background: { state: 'READY', kind: 'FALLBACK' },
    });
    expect(fixture.solar.canvas.style.visibility).toBe('');
  });

  it.each([1, 60, 3600, 86400])(
    'publishes only a successful current Sun frame with ten applied real targets at %ix',
    async (rate) => {
      const fixture = start();
      fixture.solar.realTimeClock.setRate(rate);
      const anchorUtc = wall;
      monotonic += 20;
      wall += 60000;
      await drain();
      fixture.finishImages();
      await scienceReady(fixture);
      const state = fixture.solar._startupSnapshot();
      expect(state.phase).toBe('FIRST_VISIBLE');
      expect(state.firstFrame.renderFrame).toBeGreaterThan(0);
      expect(state.firstFrame.sample.rate).toBe(rate);
      expect(state.firstFrame.sample.utcMs).toBe(rate === 1 ? wall : anchorUtc + 20 * rate);
      if (rate === 1)
        expect(
          Math.abs(state.firstFrame.sample.utcMs - state.firstFrame.entryUtcMs),
        ).toBeLessThanOrEqual(16.7);
      expect(Object.keys(state.firstFrame.targets)).toHaveLength(10);
      for (const [name, target] of Object.entries(state.firstFrame.targets)) {
        expect(target.ok).toBe(true);
        expect(target.lastJd).toBe(state.firstFrame.sample.jdTdb);
        expect(target.lastAppliedUtcMs).toBe(state.firstFrame.sample.utcMs);
        expect(target.position.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...target.lastPhysicalPosition)).toBeGreaterThan(0);
        const expected =
          name === 'moon'
            ? fixture.solar.earth.position
                .clone()
                .add(
                  new THREE.Vector3(
                    target.lastPhysicalPosition[0],
                    target.lastPhysicalPosition[2],
                    -target.lastPhysicalPosition[1],
                  ).multiplyScalar(1089.68),
                )
            : physicalToDisplay(target.lastPhysicalPosition);
        expect(fixture.solar.ephemerisTargets[name].position.distanceTo(expected)).toBeLessThan(
          1e-8,
        );
      }
      expect(
        fixture.solar.hitButtons.every(({ el }) => !el.disabled && !el.inert && el.tabIndex === 0),
      ).toBe(true);
    },
  );

  it('keeps an otherwise ready real frame hidden until the final staggered texture commits explicit failure', async () => {
    const fixture = start();
    await drain();
    const last = [...fixture.images.entries()].find(([url]) => url.includes('mercury'))[1];
    fixture.images.forEach((image) => {
      if (image !== last) image.success();
    });
    await scienceReady(fixture);
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    expect(fixture.solar._startupSnapshot().slots.mercury.state).toBe('PENDING');
    last.failure();
    fixture.solar._tick();
    expect(fixture.solar.canvas.style.visibility).toBe('');
    expect(fixture.solar._startupSnapshot().slots.mercury).toMatchObject({
      state: 'COMMITTED_FALLBACK',
    });
    expect(last.dispose).toHaveBeenCalledTimes(1);
  });

  it('rejects a stale entry/sample pair and publishes the next genuine fresh production sample instead', async () => {
    const fixture = start();
    await drain();
    fixture.images.forEach((image, url) => {
      if (!url.includes('backgrounds')) image.success();
    });
    await scienceReady(fixture);
    fixture.background().success();
    vi.mocked(Date.now)
      .mockReturnValueOnce(wall)
      .mockReturnValueOnce(wall + 100)
      .mockReturnValue(wall + 100);
    fixture.solar._tick();
    expect(fixture.solar.ephemerisStatus.status).toBe('ready');
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    expect(fixture.solar._startupSnapshot().firstFrame).toBe(null);
    fixture.solar._tick();
    expect(fixture.solar.canvas.style.visibility).toBe('');
    const frame = fixture.solar._startupSnapshot().firstFrame;
    expect(frame.entryUtcMs).toBe(frame.sample.utcMs);
  });

  it('turns a malformed manifest into eleven explicit owned fallbacks without launching image jobs', async () => {
    const fixture = start({ manifest: { textures: null } });
    await drain();
    await fixture.solar.textureLoadPromise;
    expect(fixture.images.size).toBe(1);
    const state = fixture.solar._startupSnapshot();
    expect(Object.keys(state.slots)).toHaveLength(11);
    for (const slot of Object.values(state.slots)) {
      expect(slot).toMatchObject({ state: 'COMMITTED_FALLBACK', owner: state.activeMountId });
      expect(slot.reason).toContain('manifest failure');
    }
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
  });

  it('keeps the barrier closed for render failure, unhealthy GL and an absent current Sun program', async () => {
    const fixture = start();
    await drain();
    fixture.finishImages();
    const render = fixture.solar.renderer.render.getMockImplementation();
    fixture.solar.renderer.render.mockImplementation(() => {});
    await scienceReady(fixture);
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    fixture.solar.renderer.render.mockImplementation(render);
    fixture.solar.renderer.gl.getError = () => 1282;
    fixture.solar._tick();
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    fixture.solar.renderer.gl.getError = () => 0;
    fixture.solar.renderer.render.mockImplementation(() => {
      throw new Error('GPU failure');
    });
    expect(() => fixture.solar._tick()).not.toThrow();
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    fixture.solar.renderer.render.mockImplementation(render);
    fixture.solar._tick();
    expect(fixture.solar.canvas.style.visibility).toBe('');
  });

  it('retains fallback resources after publication and disposes exclusively owned late decodes', async () => {
    const fixture = start();
    await drain();
    const original = fixture.solar.earth.material.map;
    deadline();
    vi.advanceTimersByTime(4000);
    await scienceReady(fixture);
    const published = fixture.solar._startupSnapshot?.();
    fixture.finishImages();
    fixture.finishImages();
    expect(fixture.solar.earth.material.map).toBe(original);
    expect(fixture.solar.scene.background.isColor).toBe(true);
    fixture.images.forEach((image) => expect(image.dispose).toHaveBeenCalledTimes(1));
    expect(fixture.solar._startupSnapshot()).toEqual(published);
  });

  it('shows DATA_ERROR with a working retry without resetting committed visual choices', async () => {
    const fixture = start({ scienceError: true });
    await drain();
    fixture.finishImages();
    fixture.releaseScience();
    await drain();
    fixture.solar._tick();
    expect(fixture.solar.canvas.style.visibility).toBe('hidden');
    expect(fixture.solar._startupSnapshot().phase).toBe('DATA_ERROR');
    const retry = fixture.container.children
      .flatMap((element) => element.children)
      .find((element) => element.textContent?.includes('RETRY'));
    expect(retry).toBeTruthy();
    fixture.recover();
    retry.click();
    expect(fixture.solar._startupSnapshot().phase).toBe('RETRY');
    await scienceReady(fixture);
    expect(fixture.solar.canvas.style.visibility).toBe('');
    expect(fixture.requests.filter(({ url }) => url.includes('textures-v1/manifest'))).toHaveLength(
      1,
    );
  });

  it('aborts destroy-before-load, drains actual stale callbacks and never resurrects rAF or another mount', async () => {
    const fixture = start({ manifestPending: true });
    const canvas = fixture.solar.canvas;
    fixture.solar.destroy();
    const frameCalls = requestAnimationFrame.mock.calls.length;
    const replacement = start();
    const replacementBackground = replacement.solar.scene.background;
    fixture.releaseManifest();
    fixture.releaseScience();
    fixture.background().success();
    await drain();
    vi.advanceTimersByTime(4000);
    fixture.solar._tick();
    expect(fixture.requests.every(({ signal }) => signal?.aborted)).toBe(true);
    expect(fixture.solar.scene.background.isTexture).not.toBe(true);
    expect(replacement.solar.scene.background).toBe(replacementBackground);
    expect(fixture.background().dispose).toHaveBeenCalledTimes(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(frameCalls + 1);
    expect(canvas.parentNode).toBe(null);
    expect(fixture.container.style.position).toBe('');
    await fixture.solar.textureLoadPromise;
  });

  it('disposes all pending planetary resources on destroy and ignores decodes even during the active renderer call', async () => {
    const fixture = start();
    await drain();
    expect(fixture.images.size).toBe(12);
    const frameCalls = requestAnimationFrame.mock.calls.length;
    fixture.solar.renderer.render.mockImplementation(() => fixture.solar.destroy());
    fixture.solar._tick();
    fixture.releaseScience();
    fixture.finishImages();
    fixture.finishImages();
    await drain();
    expect(fixture.solar.disposables).toHaveLength(0);
    expect(fixture.solar.scene.children).toHaveLength(0);
    fixture.images.forEach((image) => expect(image.dispose).toHaveBeenCalledTimes(1));
    expect(fixture.solar._startupSnapshot()).toMatchObject({
      active: false,
      phase: 'DISPOSED',
      firstFrame: null,
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(frameCalls);
    await fixture.solar.textureLoadPromise;
  });
});
