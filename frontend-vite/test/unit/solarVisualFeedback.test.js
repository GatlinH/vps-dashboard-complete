import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';
import { createEphemerisProvider } from '../../src/components/solar/EphemerisProvider.js';
import { advanceSimulationTime } from '../../src/components/solar/SolarEphemerisRuntime.js';
import { DustTailManager } from '../../src/components/solar/DustTailManager.js';
import { DustTailRenderer } from '../../src/components/solar/DustTailRenderer.js';
import { runWorkerJob } from '../../src/components/solar/DustTailWorker.js';
import { createContinuousEphemerisProviders } from '../../src/components/solar/TwoBodyEphemeris.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const halleyData = JSON.parse(read('../../public/assets/solar/p1/halley.json'));
const marsData = JSON.parse(read('../../public/assets/solar/p1/mars.json'));
const [start, end] = halleyData.jd_tdb_range;
const cleanup = [];

afterEach(() => {
  cleanup.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

// Real scene objects, published ephemerides and production worker computation.
// Only DOM painting, WebGL submission and worker delivery are replaced.
function makeSystem() {
  const gradient = { addColorStop() {} };
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({
        createLinearGradient: () => gradient,
        createRadialGradient: () => gradient,
        fillRect() {},
      }),
    }),
  });
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );

  const requests = [];
  const worker = {
    postMessage(request, transfer) {
      requests.push(structuredClone(request, { transfer }));
    },
    finish() {
      expect(requests.length).toBeGreaterThan(0);
      const { response, transfer } = runWorkerJob(requests.shift());
      worker.onmessage({ data: structuredClone(response, { transfer }) });
    },
    terminate() {},
  };
  const system = Object.assign(Object.create(SolarSystem.prototype), {
    scene: new THREE.Scene(),
    disposables: [],
    simulationTime: start,
    simulationDaysPerSecond: 12,
    ephemerides: {
      range: [start, end],
      providers: createContinuousEphemerisProviders({
        halley: createEphemerisProvider(halleyData),
        mars: createEphemerisProvider(marsData),
      }),
    },
    ephemerisStatus: { targets: { halley: {}, mars: {} } },
    bodies: [],
    sun: new THREE.Object3D(),
    sunLight: new THREE.Object3D(),
    running: true,
    disposed: false,
    clock: { getDelta: () => 0 },
    orbitState: { isDragging: false, motionState: 'running', spherical: new THREE.Spherical() },
    camera: new THREE.PerspectiveCamera(),
    cameraTarget: new THREE.Vector3(),
    debug: {},
    renderer: { render: vi.fn(), setSize: vi.fn() },
    _stepCameraTween: vi.fn(),
    _syncHitButtons: vi.fn(),
  });
  system._buildHalleyComet();
  system.ephemerisTargets = { mars: new THREE.Object3D(), halley: system.halley.group };
  system.dustTailRenderer = new DustTailRenderer({ scene: system.scene, physicalToDisplay });
  system.dustTailManager = new DustTailManager({
    halleyProvider: system.ephemerides.providers.halley,
    renderer: system.dustTailRenderer,
    workerFactory: () => worker,
    range: [start, end],
  });
  cleanup.push(() => {
    system.dustTailManager.dispose();
    system.dustTailRenderer.dispose();
    system.disposables.forEach((item) => item.dispose?.());
  });
  return { system, worker, requests };
}

function directionalOutputs(system) {
  const paths = [];
  system.halley.group.traverseVisible((object) => {
    if ((object.isMesh && object !== system.halley.nucleus) || object.isPoints || object.isLine) {
      paths.push(object);
    }
    if (object.isSprite && (object.scale.x !== object.scale.y || object.position.length() > 0)) {
      paths.push(object);
    }
  });
  const dust = system.dustTailRenderer;
  if (dust.points.parent && dust.points.visible && dust.geometry.drawRange.count > 0) {
    paths.push(dust.points);
  }
  return paths;
}

function assertValidFrame(system, expectedJd) {
  expect(system.simulationTime).toBeCloseTo(expectedJd, 8);
  for (const name of ['halley', 'mars']) {
    expect(system.ephemerisTargets[name].visible, name).toBe(true);
    expect(system.ephemerisStatus.targets[name]).toMatchObject({ ok: true, lastJd: expectedJd });
    const sample = system.ephemerides.providers[name].sample(expectedJd);
    expect(system.ephemerisTargets[name].position.toArray()).toEqual(
      Object.values(physicalToDisplay(sample.position)),
    );
  }
  expect(['ready', 'computing', 'paused']).toContain(system.dustTailManager.status);
  expect(system.dustTailRenderer.geometry.drawRange.count).toBeGreaterThan(0);
}

describe('Solar visual feedback: one tail authority', () => {
  it('renders exactly one directional tail and makes the dust draw range its only output', () => {
    const { system, worker } = makeSystem();
    system.simulationTime = start + 1;
    system._tick();
    worker.finish();
    expect(directionalOutputs(system).map((object) => object.uuid)).toEqual([
      system.dustTailRenderer.points.uuid,
    ]);
    expect(system.halley.flame.scale.x).toBe(system.halley.flame.scale.y);
    expect(system.halley.flame.position.toArray()).toEqual([0, 0, 0]);
    expect(system.dustTailRenderer.geometry.drawRange).toEqual({ start: 0, count: 804 });
    expect(system.dustTailRenderer.visibleCount).toBe(804);
    system.dustTailRenderer.clear();
    expect(directionalOutputs(system)).toEqual([]);
  });
});

describe('Solar visual feedback: shared time boundary', () => {
  it('keeps start, end-epsilon, exact end and end-plus-dt valid without rollback', () => {
    const { system, worker, requests } = makeSystem();
    const clear = vi.spyOn(system.dustTailRenderer, 'clear');
    for (const [time, dt, expectedJd] of [
      [start, 0, start],
      [end - 0.001, 0, end - 0.001],
      [end, 0, end],
      [end, 0.025, end + 0.3],
    ]) {
      system.simulationTime = time;
      system.clock.getDelta = () => dt;
      system._tick();
      // After a wrap even the frame before the worker reply must have an output.
      if (time === end) assertValidFrame(system, expectedJd);
      while (requests.length) worker.finish();
      assertValidFrame(system, expectedJd);
      expect(clear).not.toHaveBeenCalled();
      expect(system.dustTailManager.errorLatched).toBe(false);
    }
  });

  it('coalesces a pre-boundary worker result into the continuous post-boundary frame', () => {
    const { system, worker, requests } = makeSystem();
    system._tick();
    worker.finish();
    system.simulationTime = end - 0.001;
    system._tick();
    const generation = system.dustTailManager.currentGeneration;
    expect(requests).toHaveLength(1);

    system.simulationTime = end;
    system.clock.getDelta = () => 0.025;
    system._tick();
    expect(system.simulationTime).toBeCloseTo(end + 0.3, 8);
    expect(system.dustTailManager.currentGeneration).toBe(generation);
    worker.finish();
    worker.finish();
    assertValidFrame(system, end + 0.3);
    expect(system.dustTailManager.displayTObs).toBeCloseTo(end + 0.3, 8);
    expect(system.dustTailManager.getDiagnostics().backingStoreAllocations).toBe(4);
  });

  it('keeps an exact-end seek unchanged while motion is paused', () => {
    const { system, worker, requests } = makeSystem();
    system._tick();
    worker.finish();
    system.simulationTime = end;
    system.orbitState.motionState = 'paused';
    system._tick();
    assertValidFrame(system, end);
    expect(system.dustTailManager.status).toBe('paused');
    expect(requests).toHaveLength(0);
  });

  it('rejects non-finite manager inputs without clamping them to a sample', () => {
    for (const jd of [NaN, Infinity]) {
      const { system, requests } = makeSystem();
      const sample = vi.spyOn(system.ephemerides.providers.halley, 'sample');
      system.dustTailManager.tick(jd);
      expect(system.dustTailManager.status).toBe('out_of_range');
      expect(system.dustTailRenderer.visibleCount).toBe(0);
      expect(sample).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    }
  });

  it.each([
    ['failed', { ok: false, error: 'invalid_ephemeris' }],
    ['non-finite', { ok: true, position: [NaN, 1, 2], velocity: [0, 0, 0] }],
  ])(
    'hides the body and clears dust for a %s sample even at an already drawn time',
    (_label, sample) => {
      const { system, worker } = makeSystem();
      system._tick();
      worker.finish();
      system.ephemerides.providers.halley.sample = () => sample;
      system._tick();
      expect(system.halley.group.visible).toBe(false);
      expect(system.ephemerisStatus.targets.halley.ok).toBe(false);
      expect(system.dustTailManager.status).toBe('error');
      expect(system.dustTailRenderer.geometry.drawRange.count).toBe(0);
      expect(system.ephemerisTargets.mars.visible).toBe(true);
    },
  );

  it('does not fabricate a valid clock time for an invalid published range', () => {
    for (const range of [
      [start, start],
      [end, start],
      [NaN, end],
      [start, Infinity],
    ]) {
      expect(advanceSimulationTime(start, 0, 12, range)).toBeNaN();
    }
  });
});

describe('Solar visual feedback: mobile viewport', () => {
  it('marks only the SolarSystem host and gives it a mobile 16:9 content box', () => {
    const table = read('../../src/modules/serverTable.js');
    const css = read('../../src/styles/starfleet-theme.css');
    expect(table).toMatch(/id="solar-system-container"[^>]*data-solar-viewport/);
    expect(table).not.toMatch(/id="globe-container"[^>]*data-solar-viewport/);
    expect(table).toContain("new SolarSystem('#solar-system-container'");
    const rule = css.match(
      /@media\s*\(max-width:\s*720px\)\s*\{\s*#solar-system-container\[data-solar-viewport\]\s*\{([^}]+)\}/,
    );
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/aspect-ratio:\s*16\s*\/\s*9\s*;/);
    expect(rule[1]).toMatch(/width:\s*100%\s*;/);
    expect(rule[1]).toMatch(/height:\s*auto\s*;/);
    expect(rule[1]).toMatch(/min-height:\s*0\s*;/);
    expect(rule[1]).toMatch(/position:\s*relative\s*;/);
    expect(rule[1]).toMatch(/overflow:\s*visible\s*;/);
  });

  it('sizes WebGL and the camera from the fractional 16:9 content box at 390px and 480px', () => {
    const { system } = makeSystem();
    system._fitHomeCamera = () => new THREE.Vector3();
    for (const width of [390, 480]) {
      const height = (width * 9) / 16;
      system.container = { getBoundingClientRect: () => ({ width, height }) };
      system.resize();
      expect(system.renderer.setSize).toHaveBeenLastCalledWith(width, height, false);
      expect(system.camera.aspect).toBeCloseTo(16 / 9, 10);
    }
  });
});
