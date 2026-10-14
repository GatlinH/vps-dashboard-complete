// Finson–Probstein dust tail worker: stateless absolute-epoch RK4 recomputation.
//
// Every job recomputes each dust particle from its release-time boundary state
// sampled by the main thread from the P1 ephemeris. No cross-frame state, no
// history iterator: identical (tObs, boundary states) always yield bit-identical
// Float64 output regardless of render cadence.
//
// Units are strictly AU and AU/day; time is JD (TDB) days.

// Heliocentric gravitational parameter, frozen as the square of the Gaussian
// gravitational constant k = 0.01720209895 (AU^3 / day^2). Read-only module
// export so tests can import and assert the exact value. This is a physical
// constant used inside the worker; it is deliberately NOT part of the request
// message contract.
export const MU_SUN_AU3_DAY2 = 2.9591220828559115e-4;

// Static work-unit upper bounds (see design section 2.2). 201 release points,
// 5 betas, oldest particle integrates 100d at 0.1d => 1000 steps.
export const MAX_RK4_STEPS = 502500;
export const MAX_ACCELERATION_EVALUATIONS = 2010000;

const EXPECTED_BETAS = [0.0, 0.2, 0.5, 0.8, 1.0];
const INPUT_BYTES = 9648; // 201 * 6 * 8
const OUTPUT_BYTES = 12060; // 201 * 5 * 3 * 4

// Solar gravity minus radiation pressure: a = -mu*(1-beta)/r^3 * r_vec.
// beta=0 is pure two-body gravity; beta=1 exactly cancels gravity (straight line).
export function acceleration(position, beta) {
  const x = position[0], y = position[1], z = position[2];
  const r2 = x * x + y * y + z * z;
  const r = Math.sqrt(r2);
  if (r < 1e-12) return [0, 0, 0];
  const k = -(MU_SUN_AU3_DAY2 * (1 - beta)) / (r * r2);
  return [k * x, k * y, k * z];
}

// Standard classical fourth-order Runge-Kutta for the coupled system
// dr/dt = v, dv/dt = acceleration(r, beta). Pure Float64, no shared state.
// Exactly 4 acceleration evaluations per step.
export function integrateStateFloat64({ position, velocity, beta, durationDays, stepDays, diagnostics }) {
  let x = position[0], y = position[1], z = position[2];
  let vx = velocity[0], vy = velocity[1], vz = velocity[2];
  let rk4Steps = 0;
  let accelerationEvaluations = 0;

  // Integer step count avoids floating-point residue in a running `t += h`
  // accumulator (which could add one spurious step at the frozen maximum job).
  // ceil (with a tiny tolerance to absorb float error on exact multiples like
  // 100/0.1 == 999.9999999999999) covers the full duration: a fractional tail
  // becomes one final clamped step so the trajectory lands exactly on
  // durationDays. For the frozen contract (durations that are multiples of 0.5,
  // step 0.1) this yields the exact frozen counts.
  const totalSteps = Math.max(0, Math.ceil(durationDays / stepDays - 1e-9));

  for (let i = 0; i < totalSteps; i += 1) {
    const tStart = i * stepDays;
    const h = Math.min(stepDays, durationDays - tStart);

    // Stage 1
    const a1 = acceleration([x, y, z], beta);
    const k1x = vx, k1y = vy, k1z = vz;
    const k1vx = a1[0], k1vy = a1[1], k1vz = a1[2];

    // Stage 2 (midpoint using stage 1 slopes)
    const a2 = acceleration([x + 0.5 * h * k1x, y + 0.5 * h * k1y, z + 0.5 * h * k1z], beta);
    const k2x = vx + 0.5 * h * k1vx, k2y = vy + 0.5 * h * k1vy, k2z = vz + 0.5 * h * k1vz;
    const k2vx = a2[0], k2vy = a2[1], k2vz = a2[2];

    // Stage 3 (midpoint using stage 2 slopes)
    const a3 = acceleration([x + 0.5 * h * k2x, y + 0.5 * h * k2y, z + 0.5 * h * k2z], beta);
    const k3x = vx + 0.5 * h * k2vx, k3y = vy + 0.5 * h * k2vy, k3z = vz + 0.5 * h * k2vz;
    const k3vx = a3[0], k3vy = a3[1], k3vz = a3[2];

    // Stage 4 (endpoint using stage 3 slopes)
    const a4 = acceleration([x + h * k3x, y + h * k3y, z + h * k3z], beta);
    const k4x = vx + h * k3vx, k4y = vy + h * k3vy, k4z = vz + h * k3vz;
    const k4vx = a4[0], k4vy = a4[1], k4vz = a4[2];

    x += (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    y += (h / 6) * (k1y + 2 * k2y + 2 * k3y + k4y);
    z += (h / 6) * (k1z + 2 * k2z + 2 * k3z + k4z);
    vx += (h / 6) * (k1vx + 2 * k2vx + 2 * k3vx + k4vx);
    vy += (h / 6) * (k1vy + 2 * k2vy + 2 * k3vy + k4vy);
    vz += (h / 6) * (k1vz + 2 * k2vz + 2 * k3vz + k4vz);

    rk4Steps += 1;
    accelerationEvaluations += 4;
  }

  if (diagnostics) {
    diagnostics.rk4Steps = (diagnostics.rk4Steps || 0) + rk4Steps;
    diagnostics.accelerationEvaluations = (diagnostics.accelerationEvaluations || 0) + accelerationEvaluations;
  }

  return { position: [x, y, z], velocity: [vx, vy, vz], rk4Steps, accelerationEvaluations };
}

// Production runtime entry. Validates the frozen request contract strictly, then
// integrates every (release, beta) pair into the Float32 output buffer.
export function computeDustPositions(request) {
  if (!request || typeof request !== 'object') {
    throw new Error('Invalid request: request must be an object');
  }
  if (request.type !== 'COMPUTE_DUST') {
    throw new Error('Invalid request type: must be COMPUTE_DUST');
  }
  if (!Number.isInteger(request.generation) || request.generation < 0) {
    throw new Error('Invalid generation: must be a non-negative integer');
  }
  if (!Number.isInteger(request.requestId) || request.requestId < 0) {
    throw new Error('Invalid requestId: must be a non-negative integer');
  }
  if (typeof request.tObs !== 'number' || !Number.isFinite(request.tObs)) {
    throw new Error('Invalid tObs: must be a finite number');
  }
  if (!Number.isInteger(request.validReleaseCount) || request.validReleaseCount < 0 || request.validReleaseCount > 201) {
    throw new Error('Invalid validReleaseCount: must be an integer between 0 and 201');
  }
  if (request.stepDays !== 0.1) {
    throw new Error('Invalid stepDays contract: must be strictly 0.1');
  }
  if (!Array.isArray(request.betas) || request.betas.length !== 5 ||
      !request.betas.every((b, idx) => b === EXPECTED_BETAS[idx])) {
    throw new Error('Invalid betas contract: must match [0.0, 0.2, 0.5, 0.8, 1.0]');
  }
  if (!request.inputBuffer || !(request.inputBuffer instanceof ArrayBuffer) || request.inputBuffer.byteLength !== INPUT_BYTES) {
    throw new Error('Invalid inputBuffer: must be an ArrayBuffer of exactly 9648 bytes');
  }
  if (!request.outputBuffer || !(request.outputBuffer instanceof ArrayBuffer) || request.outputBuffer.byteLength !== OUTPUT_BYTES) {
    throw new Error('Invalid outputBuffer: must be an ArrayBuffer of exactly 12060 bytes');
  }

  const { generation, requestId, tObs, validReleaseCount, inputBuffer, outputBuffer } = request;
  const inView = new Float64Array(inputBuffer);
  const outView = new Float32Array(outputBuffer);

  const totalInFloats = validReleaseCount * 6;
  for (let idx = 0; idx < totalInFloats; idx += 1) {
    if (!Number.isFinite(inView[idx])) {
      throw new Error(`Invalid inputBuffer: element at index ${idx} is non-finite`);
    }
  }

  const diag = { rk4Steps: 0, accelerationEvaluations: 0 };

  for (let betaIdx = 0; betaIdx < 5; betaIdx += 1) {
    const beta = EXPECTED_BETAS[betaIdx];
    for (let r = 0; r < validReleaseCount; r += 1) {
      const inOffset = r * 6;
      const initialPos = [inView[inOffset], inView[inOffset + 1], inView[inOffset + 2]];
      const initialVel = [inView[inOffset + 3], inView[inOffset + 4], inView[inOffset + 5]];
      const durationDays = r * 0.5; // release age: particle i was shed i*0.5d ago

      const state = integrateStateFloat64({
        position: initialPos,
        velocity: initialVel,
        beta,
        durationDays,
        stepDays: 0.1,
        diagnostics: diag
      });

      const outIndex = (betaIdx * validReleaseCount + r) * 3;
      outView[outIndex] = state.position[0];
      outView[outIndex + 1] = state.position[1];
      outView[outIndex + 2] = state.position[2];
    }
  }

  const totalRk4Steps = diag.rk4Steps;
  const totalAccEvals = diag.accelerationEvaluations;

  if (totalRk4Steps > MAX_RK4_STEPS || totalAccEvals > MAX_ACCELERATION_EVALUATIONS) {
    throw new Error('Work-unit budget exceeded');
  }

  return {
    type: 'DUST_COMPUTED',
    generation,
    requestId,
    tObs,
    validReleaseCount,
    physicalCount: validReleaseCount * 5,
    rk4Steps: totalRk4Steps,
    accelerationEvaluations: totalAccEvals,
    inputBuffer,
    outputBuffer,
    error: null
  };
}

// Single message-handling seam shared by the real Worker scope and unit tests.
// Returns the response object plus the exact transfer list. On any thrown error
// it returns a controlled error response and, only when the two original buffers
// are still valid ArrayBuffers of the right size, transfers them straight back.
export function runWorkerJob(req) {
  try {
    const res = computeDustPositions(req);
    return { response: res, transfer: [res.inputBuffer, res.outputBuffer] };
  } catch (err) {
    const canTransfer =
      req &&
      req.inputBuffer instanceof ArrayBuffer && req.inputBuffer.byteLength === INPUT_BYTES &&
      req.outputBuffer instanceof ArrayBuffer && req.outputBuffer.byteLength === OUTPUT_BYTES;

    const errResponse = {
      type: 'DUST_COMPUTED',
      generation: (req && typeof req.generation === 'number') ? req.generation : 0,
      requestId: (req && typeof req.requestId === 'number') ? req.requestId : 0,
      tObs: (req && typeof req.tObs === 'number') ? req.tObs : 0,
      validReleaseCount: 0,
      physicalCount: 0,
      rk4Steps: 0,
      accelerationEvaluations: 0,
      inputBuffer: canTransfer ? req.inputBuffer : null,
      outputBuffer: canTransfer ? req.outputBuffer : null,
      error: err ? (err.message || String(err)) : 'Worker execution failure'
    };

    return { response: errResponse, transfer: canTransfer ? [req.inputBuffer, req.outputBuffer] : [] };
  }
}

// Worker top-level message pump. Only installed in a real Worker scope; unit
// tests import the pure functions above directly and never trigger this branch.
if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (e) => {
    const { response, transfer } = runWorkerJob(e.data);
    self.postMessage(response, transfer);
  };
}
