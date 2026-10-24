// P2 dust-tail bounded worker pipeline tests.
//
// These tests import the real production modules and assert their actual return
// values and observable state. Physical fidelity is proven against closed-form
// analytic truth: a circular orbit of radius r and speed sqrt(mu/r) must return
// to its start after one period T = 2*pi*sqrt(r^3/mu). No hand-written
// propagator is trusted as a reference, and step-size self-consistency is
// checked directly on the production integrator.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  MU_SUN_AU3_DAY2,
  MAX_RK4_STEPS,
  MAX_ACCELERATION_EVALUATIONS,
  acceleration,
  integrateStateFloat64,
  computeDustPositions,
  runWorkerJob,
} from '../../src/components/solar/DustTailWorker.js';
import { DustTailRenderer } from '../../src/components/solar/DustTailRenderer.js';
import { DustTailManager } from '../../src/components/solar/DustTailManager.js';

const INPUT_BYTES = 9648; // 201 * 6 * 8
const OUTPUT_BYTES = 12060; // 201 * 5 * 3 * 4

function makeValidRequest(overrides = {}) {
  const inputBuffer = new ArrayBuffer(INPUT_BYTES);
  const outputBuffer = new ArrayBuffer(OUTPUT_BYTES);
  const validReleaseCount = overrides.validReleaseCount ?? 3;
  const inView = new Float64Array(inputBuffer);
  // Fill only the used region with a stable, finite non-degenerate state.
  for (let i = 0; i < validReleaseCount; i += 1) {
    const o = i * 6;
    inView[o] = 1.2 + i * 0.01;
    inView[o + 1] = -0.3 + i * 0.02;
    inView[o + 2] = 0.05;
    inView[o + 3] = -0.004;
    inView[o + 4] = 0.017;
    inView[o + 5] = 0.001;
  }
  return {
    type: 'COMPUTE_DUST',
    generation: 1,
    requestId: 1,
    tObs: 2451545.0,
    validReleaseCount,
    stepDays: 0.1,
    betas: [0.0, 0.2, 0.5, 0.8, 1.0],
    inputBuffer,
    outputBuffer,
    ...overrides,
  };
}

function vecNorm(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

describe('DustTailWorker constants and acceleration', () => {
  it('exposes the frozen physical constants', () => {
    expect(MU_SUN_AU3_DAY2).toBeCloseTo(0.01720209895 ** 2, 18);
    expect(MAX_RK4_STEPS).toBe(502500);
    expect(MAX_ACCELERATION_EVALUATIONS).toBe(2010000);
  });

  it('acceleration points toward the Sun for beta=0 and vanishes at beta=1', () => {
    const pos = [2, 0, 0];
    const a0 = acceleration(pos, 0);
    expect(a0[0]).toBeLessThan(0);
    // y=z=0 yields signed zero (-0) from k*0; assert magnitude, not sign bit.
    expect(a0[1]).toBeCloseTo(0, 20);
    expect(a0[2]).toBeCloseTo(0, 20);
    expect(Math.abs(a0[0])).toBeCloseTo(MU_SUN_AU3_DAY2 / 4, 15);
    const a1 = acceleration(pos, 1);
    // beta=1 cancels gravity exactly; components are zero (possibly signed -0).
    expect(a1[0]).toBeCloseTo(0, 20);
    expect(a1[1]).toBeCloseTo(0, 20);
    expect(a1[2]).toBeCloseTo(0, 20);
  });

  it('acceleration is linear in (1-beta)', () => {
    const pos = [1.3, -0.4, 0.2];
    const full = acceleration(pos, 0);
    for (const beta of [0.2, 0.5, 0.8]) {
      const scaled = acceleration(pos, beta);
      for (let k = 0; k < 3; k += 1) {
        expect(scaled[k]).toBeCloseTo(full[k] * (1 - beta), 15);
      }
    }
  });

  it('acceleration returns zero inside the singularity guard', () => {
    expect(acceleration([0, 0, 0], 0)).toEqual([0, 0, 0]);
    expect(acceleration([1e-13, 0, 0], 0)).toEqual([0, 0, 0]);
  });
});

describe('integrateStateFloat64 physical fidelity', () => {
  const r0 = [1.2, -0.3, 0.05];
  const v0 = [-0.004, 0.017, 0.001];

  it('beta=1 is exact uniform straight-line motion', () => {
    const dt = 20;
    const res = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 1,
      durationDays: dt,
      stepDays: 0.1,
    });
    const expected = [r0[0] + v0[0] * dt, r0[1] + v0[1] * dt, r0[2] + v0[2] * dt];
    expect(vecNorm(res.position, expected)).toBeLessThan(1e-12);
    expect(vecNorm(res.velocity, v0)).toBeLessThan(1e-12);
  });

  it('beta=0 closes a circular orbit after one analytic period', () => {
    // Analytic truth: a body on a circular orbit of radius 1 AU with speed
    // sqrt(mu/r) returns exactly to its start after one period
    // T = 2*pi*sqrt(r^3/mu). A correct 4th-order integrator must close this
    // loop to sub-nanometer precision with no hand-written propagator involved.
    const rAU = 1.0;
    const speed = Math.sqrt(MU_SUN_AU3_DAY2 / rAU);
    const start = [rAU, 0, 0];
    const startVel = [0, speed, 0];
    const period = 2 * Math.PI * Math.sqrt((rAU * rAU * rAU) / MU_SUN_AU3_DAY2);
    const res = integrateStateFloat64({
      position: start,
      velocity: startVel,
      beta: 0,
      durationDays: period,
      stepDays: 0.1,
    });
    expect(vecNorm(res.position, start)).toBeLessThan(1e-9);
    const speedOut = Math.hypot(res.velocity[0], res.velocity[1], res.velocity[2]);
    expect(Math.abs(speedOut - speed)).toBeLessThan(1e-12);
  });

  it('intermediate beta closes a circular orbit under the rescaled mu*(1-beta)', () => {
    // Radiation pressure only rescales the central force, so the effective
    // gravitational parameter is mu*(1-beta). A circular orbit constructed for
    // that effective mu must close over its own period, band by band.
    const rAU = 1.0;
    for (const beta of [0.2, 0.5, 0.8]) {
      const muEff = MU_SUN_AU3_DAY2 * (1 - beta);
      const speed = Math.sqrt(muEff / rAU);
      const start = [rAU, 0, 0];
      const startVel = [0, speed, 0];
      const period = 2 * Math.PI * Math.sqrt((rAU * rAU * rAU) / muEff);
      const res = integrateStateFloat64({
        position: start,
        velocity: startVel,
        beta,
        durationDays: period,
        stepDays: 0.1,
      });
      expect(vecNorm(res.position, start)).toBeLessThan(1e-9);
      const speedOut = Math.hypot(res.velocity[0], res.velocity[1], res.velocity[2]);
      expect(Math.abs(speedOut - speed)).toBeLessThan(1e-12);
    }
  });

  it('is step-size self-consistent on the fixture state (h=0.1 vs h=0.01)', () => {
    // Direct self-consistency on the same non-degenerate fixture: the frozen
    // production step h=0.1 already agrees with a ten-times-finer h=0.01 run to
    // sub-nanometer precision. At dt=15 the integrator is accurate enough that
    // the two endpoints coincide to well within 1e-9 AU. (Convergence *order*
    // is asserted separately over coarser steps where the signal is above the
    // floating-point floor.)
    const dt = 15;
    const p100 = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0,
      durationDays: dt,
      stepDays: 0.1,
    }).position;
    const p010 = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0,
      durationDays: dt,
      stepDays: 0.01,
    }).position;
    expect(vecNorm(p100, p010)).toBeLessThan(1e-9);
  });

  it('RK4 exhibits ~4th order convergence under step halving', () => {
    const dt = 12;
    const coarse = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0,
      durationDays: dt,
      stepDays: 0.4,
    }).position;
    const mid = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0,
      durationDays: dt,
      stepDays: 0.2,
    }).position;
    const fine = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0,
      durationDays: dt,
      stepDays: 0.1,
    }).position;
    const d1 = vecNorm(coarse, mid);
    const d2 = vecNorm(mid, fine);
    expect(d2).toBeLessThan(d1);
    expect(d1 / d2).toBeGreaterThan(8);
  });

  it('reports exactly 4 acceleration evaluations per step', () => {
    const diag = { rk4Steps: 0, accelerationEvaluations: 0 };
    const res = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0.5,
      durationDays: 1.0,
      stepDays: 0.1,
      diagnostics: diag,
    });
    expect(res.rk4Steps).toBe(10);
    expect(res.accelerationEvaluations).toBe(40);
    expect(diag.rk4Steps).toBe(10);
    expect(diag.accelerationEvaluations).toBe(40);
  });

  it('does not step past a zero-duration release (age 0)', () => {
    const res = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 0.2,
      durationDays: 0,
      stepDays: 0.1,
    });
    expect(res.rk4Steps).toBe(0);
    expect(res.position).toEqual(r0);
    expect(res.velocity).toEqual(v0);
  });

  it('uses an exact integer step count with no floating-point overshoot', () => {
    // The step count must come from an integer count, not a `t += h` float
    // accumulator whose residue would sneak one extra step past the frozen
    // maximum-job budget. The oldest particle integrates 100d at 0.1d.
    expect(
      integrateStateFloat64({
        position: r0,
        velocity: v0,
        beta: 0,
        durationDays: 100,
        stepDays: 0.1,
      }).rk4Steps,
    ).toBe(1000);
    // A duration that is not a whole multiple of the step gets one final,
    // clamped partial step (0.2 + 0.05) rather than being truncated short.
    expect(
      integrateStateFloat64({
        position: r0,
        velocity: v0,
        beta: 0,
        durationDays: 0.25,
        stepDays: 0.1,
      }).rk4Steps,
    ).toBe(3);
  });

  it('lands exactly on the requested duration under beta=1 straight-line motion', () => {
    // beta=1 is exact uniform motion, so the endpoint is an analytic function of
    // the total integrated time. A duration that is not a step multiple (0.25 at
    // step 0.1) must still integrate the full 0.25d, not stop short at 0.2d.
    const dt = 0.25;
    const res = integrateStateFloat64({
      position: r0,
      velocity: v0,
      beta: 1,
      durationDays: dt,
      stepDays: 0.1,
    });
    const expected = [r0[0] + v0[0] * dt, r0[1] + v0[1] * dt, r0[2] + v0[2] * dt];
    expect(vecNorm(res.position, expected)).toBeLessThan(1e-12);
    expect(res.rk4Steps).toBe(3);
  });
});

describe('computeDustPositions request-contract validation', () => {
  it('accepts a well-formed request and returns DUST_COMPUTED', () => {
    const req = makeValidRequest();
    const res = computeDustPositions(req);
    expect(res.type).toBe('DUST_COMPUTED');
    expect(res.error).toBeNull();
    expect(res.generation).toBe(1);
    expect(res.requestId).toBe(1);
    expect(res.validReleaseCount).toBe(3);
    expect(res.physicalCount).toBe(15);
    // Same backing stores returned for pooled reuse.
    expect(res.inputBuffer).toBe(req.inputBuffer);
    expect(res.outputBuffer).toBe(req.outputBuffer);
    expect(res.rk4Steps).toBeGreaterThan(0);
    expect(res.accelerationEvaluations).toBe(res.rk4Steps * 4);
  });

  it('rejects an illegal message type', () => {
    expect(() => computeDustPositions(makeValidRequest({ type: 'NOPE' }))).toThrow(/type/);
    expect(() => computeDustPositions(null)).toThrow(/object/);
  });

  it('rejects negative or non-integer generation and requestId', () => {
    expect(() => computeDustPositions(makeValidRequest({ generation: -1 }))).toThrow(/generation/);
    expect(() => computeDustPositions(makeValidRequest({ generation: 1.5 }))).toThrow(/generation/);
    expect(() => computeDustPositions(makeValidRequest({ requestId: -3 }))).toThrow(/requestId/);
    expect(() => computeDustPositions(makeValidRequest({ requestId: 2.2 }))).toThrow(/requestId/);
  });

  it('rejects a non-finite tObs', () => {
    expect(() => computeDustPositions(makeValidRequest({ tObs: NaN }))).toThrow(/tObs/);
    expect(() => computeDustPositions(makeValidRequest({ tObs: Infinity }))).toThrow(/tObs/);
    expect(() => computeDustPositions(makeValidRequest({ tObs: 'x' }))).toThrow(/tObs/);
  });

  it('enforces validReleaseCount bounds [0, 201]', () => {
    expect(() => computeDustPositions(makeValidRequest({ validReleaseCount: -1 }))).toThrow(
      /validReleaseCount/,
    );
    expect(() => computeDustPositions(makeValidRequest({ validReleaseCount: 202 }))).toThrow(
      /validReleaseCount/,
    );
    expect(() => computeDustPositions(makeValidRequest({ validReleaseCount: 3.5 }))).toThrow(
      /validReleaseCount/,
    );
    // Boundary 201 is accepted and lands exactly on the frozen work-unit
    // budget: 5 betas * sum_{r=0..200} 5r = 502500 steps, 4 evals each. This is
    // the maximum legal job and must NOT exceed MAX_RK4_STEPS / MAX_ACCEL_EVALS.
    const at201 = computeDustPositions(makeValidRequest({ validReleaseCount: 201 }));
    expect(at201.error).toBeNull();
    expect(at201.validReleaseCount).toBe(201);
    expect(at201.rk4Steps).toBe(MAX_RK4_STEPS);
    expect(at201.rk4Steps).toBe(502500);
    expect(at201.accelerationEvaluations).toBe(MAX_ACCELERATION_EVALUATIONS);
    expect(at201.accelerationEvaluations).toBe(2010000);
    // Empty release set is a legal no-op.
    const at0 = computeDustPositions(makeValidRequest({ validReleaseCount: 0 }));
    expect(at0.error).toBeNull();
    expect(at0.physicalCount).toBe(0);
  });

  it('rejects any stepDays other than exactly 0.1', () => {
    expect(() => computeDustPositions(makeValidRequest({ stepDays: 0.2 }))).toThrow(/stepDays/);
    expect(() => computeDustPositions(makeValidRequest({ stepDays: 0 }))).toThrow(/stepDays/);
  });

  it('rejects tampered betas (wrong values, wrong length)', () => {
    expect(() =>
      computeDustPositions(makeValidRequest({ betas: [0.0, 0.2, 0.5, 0.8, 0.9] })),
    ).toThrow(/betas/);
    expect(() => computeDustPositions(makeValidRequest({ betas: [0.0, 0.2, 0.5, 0.8] }))).toThrow(
      /betas/,
    );
    expect(() => computeDustPositions(makeValidRequest({ betas: 'nope' }))).toThrow(/betas/);
  });

  it('rejects buffers of the wrong byte length', () => {
    expect(() =>
      computeDustPositions(makeValidRequest({ inputBuffer: new ArrayBuffer(8) })),
    ).toThrow(/inputBuffer/);
    expect(() =>
      computeDustPositions(makeValidRequest({ outputBuffer: new ArrayBuffer(8) })),
    ).toThrow(/outputBuffer/);
    expect(() => computeDustPositions(makeValidRequest({ inputBuffer: null }))).toThrow(
      /inputBuffer/,
    );
  });

  it('rejects input containing NaN inside the valid region', () => {
    const req = makeValidRequest({ validReleaseCount: 2 });
    new Float64Array(req.inputBuffer)[4] = NaN;
    expect(() => computeDustPositions(req)).toThrow(/non-finite/);
  });
});

describe('runWorkerJob controlled-error seam', () => {
  it('returns a valid response and transfers both buffers on success', () => {
    const req = makeValidRequest();
    const { response, transfer } = runWorkerJob(req);
    expect(response.error).toBeNull();
    expect(transfer).toEqual([req.inputBuffer, req.outputBuffer]);
  });

  it('converts a thrown validation error into a controlled error response', () => {
    const req = makeValidRequest({ stepDays: 0.5 });
    const { response, transfer } = runWorkerJob(req);
    expect(response.type).toBe('DUST_COMPUTED');
    expect(response.error).toMatch(/stepDays/);
    expect(response.validReleaseCount).toBe(0);
    // Buffers are still valid so they are transferred back for reclamation.
    expect(transfer).toEqual([req.inputBuffer, req.outputBuffer]);
  });

  it('omits transfer when the buffers are unusable', () => {
    const req = makeValidRequest({ inputBuffer: new ArrayBuffer(8) });
    const { response, transfer } = runWorkerJob(req);
    expect(response.error).toMatch(/inputBuffer/);
    expect(response.inputBuffer).toBeNull();
    expect(response.outputBuffer).toBeNull();
    expect(transfer).toEqual([]);
  });
});

describe('DustTailRenderer display buffer', () => {
  function makeRenderer() {
    const scene = new THREE.Scene();
    // Identity mapping keeps physical == display so we can assert sentinels.
    const physicalToDisplay = ({ x, y, z }) => ({ x, y, z });
    return { renderer: new DustTailRenderer({ scene, physicalToDisplay }), scene };
  }

  it('drives visibleCount and drawRange from validReleaseCount * 4', () => {
    const { renderer } = makeRenderer();
    expect(renderer.visibleCount).toBe(0);
    const releases = 3;
    const physical = new Float32Array(releases * 5 * 3);
    renderer.update(physical, releases);
    expect(renderer.visibleCount).toBe(releases * 4);
    const diag = renderer.getDiagnostics();
    expect(diag.drawRangeCount).toBe(releases * 4);
    expect(diag.attributeCount).toBe(804);
  });

  it('never copies the beta=0 gravity band into the display buffer', () => {
    const { renderer } = makeRenderer();
    const releases = 4;
    const physical = new Float32Array(releases * 5 * 3);
    const SENTINEL = 999.0;
    // Band 0 (beta=0) filled with the sentinel; bands 1..4 with a marker.
    for (let r = 0; r < releases; r += 1) {
      const o = (0 * releases + r) * 3;
      physical[o] = SENTINEL;
      physical[o + 1] = SENTINEL;
      physical[o + 2] = SENTINEL;
    }
    for (let b = 1; b <= 4; b += 1) {
      for (let r = 0; r < releases; r += 1) {
        const o = (b * releases + r) * 3;
        physical[o] = b + r * 0.01;
        physical[o + 1] = 0;
        physical[o + 2] = 0;
      }
    }
    renderer.update(physical, releases);
    const visible = renderer.copyVisiblePositions();
    expect(visible.length).toBe(releases * 4 * 3);
    for (const v of visible) {
      expect(v).not.toBe(SENTINEL);
    }
  });

  it('clear() resets visibleCount and drawRange to zero', () => {
    const { renderer } = makeRenderer();
    renderer.update(new Float32Array(2 * 5 * 3), 2);
    renderer.clear();
    expect(renderer.visibleCount).toBe(0);
    expect(renderer.getDiagnostics().drawRangeCount).toBe(0);
  });

  it('dispose() is idempotent and does not throw when called twice', () => {
    const { renderer } = makeRenderer();
    expect(() => {
      renderer.dispose();
      renderer.dispose();
    }).not.toThrow();
  });
});
