import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { updateEphemerisTargets } from '../../src/components/solar/SolarEphemerisRuntime.js';
import { TimeControls } from '../../src/components/solar/TimeControls.js';
import { DustTailManager } from '../../src/components/solar/DustTailManager.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function startProduction(options = {}) {
  vi.stubGlobal('window', { __DBG__: {}, innerWidth: 1000 });
  vi.stubGlobal('document', { getElementById: () => ({}) });
  for (const method of [
    '_buildRenderer',
    '_buildScene',
    '_buildSun',
    '_buildPlanets',
    '_buildMoon',
    '_buildHitButtons',
    '_buildTimeControls',
    '_bindEvents',
    '_loadEphemerides',
    '_loadPlanetaryTextures',
    'resume',
  ]) {
    vi.spyOn(SolarSystem.prototype, method).mockImplementation(() => {});
  }
  return new SolarSystem({}, options);
}

describe('production realtime regression', () => {
  it('[MUT-FAIL-M1] cold start and reload use current wall clock, never the fixed P1 epoch', () => {
    const now = Date.now();
    const solar = startProduction();
    expect(Math.abs(solar.simulationTime - (now / 86400000 + 2440587.5))).toBeLessThan(0.001);
    const later = now + 7200000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const reload = new SolarSystem({});
    expect(Math.abs(reload.simulationTime - (later / 86400000 + 2440587.5))).toBeLessThan(0.001);
  });

  it('[MUT-FAIL-M1] dragging and background recovery sample absolute current time, independent of frame delta', () => {
    const solar = startProduction();
    solar.sun = { position: new THREE.Vector3() };
    solar.sunLight = { position: new THREE.Vector3() };
    solar._advanceBodies(0);
    const later = Date.now() + 3600000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    solar._advanceBodies(0);
    expect(Math.abs(solar.simulationTime - (later / 86400000 + 2440587.5))).toBeLessThan(0.001);
  });

  it('[MUT-FAIL-M7] public geocentric Moon vector is not reduced by Earth a second time', () => {
    const moon = { visible: false };
    const statuses = { moon: {} };
    const applyPosition = vi.fn();
    updateEphemerisTargets({
      simulationTime: 2460000,
      providers: {
        moon: { sample: () => ({ ok: true, position: [0.002384, 0, 0], center: 'geocentric' }) },
        earth: { sample: () => ({ ok: true, position: [1, 0, 0] }) },
      },
      targets: { moon },
      statuses,
      applyPosition,
      applyTail: vi.fn(),
    });
    expect(applyPosition.mock.calls[0][1]).toEqual([0.002384, 0, 0]);
  });

  it('[MUT-FAIL-STORAGE] native reload ignores historical URL/storage and programmatic acceleration', () => {
    const getItem = vi.fn(() => '2446078.5');
    vi.stubGlobal('localStorage', { getItem });
    vi.stubGlobal('sessionStorage', { getItem });
    const solar = startProduction({ simulationDaysPerSecond: 12, rate: 86400 });
    window.location = { search: '?epoch=2446078.5&rate=86400' };
    const reload = new SolarSystem({}, { rate: 60 });
    expect(solar.realTimeClock.rate).toBe(1);
    expect(reload.realTimeClock.rate).toBe(1);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('[MUT-FAIL-M4] cold start hides unverified coordinates until precision is ready', () => {
    startProduction();
    const target = new THREE.Object3D();
    vi.spyOn(SolarSystem.prototype, '_buildPlanets').mockImplementation(function () {
      this.ephemerisTargets.mars = target;
    });
    const solar = new SolarSystem({});
    expect(target.visible).toBe(false);
    expect(solar.ephemerisStatus.status).not.toBe('ready');
    expect(solar.ephemerisStatus.lastAppliedJd).toBe(null);
  });

  it('[MUT-FAIL-M5] out-of-order completion cannot clear current error or overwrite applied epoch', async () => {
    const solar = startProduction();
    const resolves = [];
    solar.ephemerides = {
      getEpochKey: String,
      ensureEpoch: () => new Promise((resolve) => resolves.push(resolve)),
    };
    solar._requestEphemerisEpoch(2461000);
    solar._requestEphemerisEpoch(2462000);
    resolves[1]();
    await Promise.resolve();
    solar.ephemerisStatus.error = 'new current error';
    solar.ephemerisStatus.lastAppliedJd = 2462000;
    resolves[0]();
    await Promise.resolve();
    expect(solar.ephemerisStatus.error).toBe('new current error');
    expect(solar.ephemerisStatus.lastAppliedJd).toBe(2462000);
  });

  it('[MUT-FAIL-M1] real render tick continues scientific time during dragging, camera pause and long frame gaps', () => {
    const solar = startProduction();
    solar.sun = new THREE.Object3D();
    solar.sunLight = new THREE.Object3D();
    solar.running = true;
    solar.renderer = { render: vi.fn() };
    solar.camera = new THREE.PerspectiveCamera();
    solar.cameraTarget = new THREE.Vector3();
    solar._syncHitButtons = vi.fn();
    solar._stepCameraTween = vi.fn();
    solar.clock = { getDelta: () => 5000 };
    solar.orbitState.isDragging = true;
    solar.orbitState.motionState = 'paused';
    const later = Date.now() + 5000000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    solar._tick();
    expect(solar.timeSample.utcMs).toBe(later);
    expect(solar.renderer.render).toHaveBeenCalledOnce();
  });

  it('[MUT-FAIL-HOLD] unloaded epoch holds last applied transforms with an explicit non-ready status', () => {
    const solar = startProduction();
    solar.sun = new THREE.Object3D();
    solar.sunLight = new THREE.Object3D();
    const target = new THREE.Object3D();
    target.position.set(2, 3, 4);
    solar.ephemerisTargets.mars = target;
    solar.ephemerisStatus.lastAppliedJd = 2461000;
    solar.ephemerisStatus.lastAppliedUtcMs = Date.now() - 1000;
    solar.ephemerides = {
      isEpochReady: () => false,
      getEpochKey: String,
      ensureEpoch: () => new Promise(() => {}),
    };
    solar._advanceBodies(0);
    expect(target.position.toArray()).toEqual([2, 3, 4]);
    expect(solar.ephemerisStatus.status).not.toBe('ready');
    expect(solar.ephemerisStatus.lastAppliedJd).toBe(2461000);
  });
});

class NativeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.attributes = {};
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  appendChild(child) {
    this.children.push(child);
    child.parent = this;
  }
  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }
  addEventListener(event, handler) {
    (this.listeners[event] ??= []).push(handler);
  }
  dispatch(event) {
    for (const listener of this.listeners[event.type] ?? []) listener(event);
    if (!event.stopped) this.parent?.dispatch(event);
  }
  remove() {
    this.parent.children = this.parent.children.filter((child) => child !== this);
  }
}

describe('independent native time controls', () => {
  it('[MUT-FAIL-RANGE] dust source-range and loading states do not latch a fabricated sample error on returning Now', () => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() };
    const manager = new DustTailManager({
      halleyProvider: { sample: () => ({ ok: true, position: [1, 0, 0], velocity: [0, 0.01, 0] }) },
      renderer: { clear: vi.fn() },
      workerFactory: () => worker,
      range: [2461000, 2462000],
    });
    try {
      manager.tick(2462001, { bodyValid: false });
      expect(manager.status).toBe('out_of_range');
      expect(manager.errorLatched).toBe(false);
      manager.tick(2461000, { epochReady: false, bodyValid: false });
      expect(manager.status).toBe('loading');
      expect(manager.errorLatched).toBe(false);
      manager.tick(2461000, { epochReady: true, bodyValid: true });
      expect(worker.postMessage).toHaveBeenCalledOnce();
      expect(manager.errorLatched).toBe(false);
    } finally {
      manager.dispose();
    }
  });
  it('[MUT-FAIL-M10] ordinary buttons stop scene bubbling and preserve toolbar semantics and rate actions', () => {
    vi.stubGlobal('document', { createElement: (tag) => new NativeElement(tag) });
    const host = new NativeElement('div');
    const sceneClick = vi.fn();
    host.addEventListener('click', sceneClick);
    const sceneEscape = vi.fn();
    host.addEventListener('keydown', sceneEscape);
    const onRate = vi.fn();
    const controls = new TimeControls(host, onRate);
    expect(controls.element.className).toBe('time-control-panel');
    expect(controls.element.attributes['aria-label']).toBe('星历时间控制器');
    for (const button of controls.buttons) {
      expect(button.tagName).toBe('BUTTON');
      expect(button.type).toBe('button');
      button.dispatch({
        type: 'click',
        stopPropagation() {
          this.stopped = true;
        },
      });
    }
    expect(onRate.mock.calls.map(([rate]) => rate)).toEqual([1, 60, 3600, 86400]);
    expect(sceneClick).not.toHaveBeenCalled();
    controls.buttons[0].dispatch({
      type: 'keydown',
      key: 'Escape',
      stopPropagation() {
        this.stopped = true;
      },
    });
    expect(sceneEscape).toHaveBeenCalledOnce();
    const toolbar = controls.element.children[2];
    toolbar.children.at(-1).dispatch({
      type: 'click',
      stopPropagation() {
        this.stopped = true;
      },
    });
    expect(onRate).toHaveBeenLastCalledWith(1);
    controls.update(
      { utcMs: Date.now(), rate: 1, mode: 'realtime', jdTdb: 2461000 },
      { status: 'loading', lastAppliedJd: null, lastAppliedUtcMs: null },
    );
    expect(controls.status.textContent).toContain('actual applied epoch: none');
    expect(controls.buttons[0].attributes['aria-pressed']).toBe('true');
    controls.dispose();
    expect(host.children).toHaveLength(0);
  });
});
