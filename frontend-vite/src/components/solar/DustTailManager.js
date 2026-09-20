// Bounded single-in-flight dust-tail worker manager.
//
// Owns a 2+2 ArrayBuffer pool allocated once at construction (backing-store
// allocations frozen at 4). Dispatches at most one job at a time; while the
// worker is busy, tick() only records the latest pending metadata and never
// samples the ephemeris. Every failure path (malformed response, controlled
// worker error, synchronous postMessage throw, worker crash, dispose) is
// fail-soft and never throws into the host rAF loop.

const INPUT_BYTES = 9648; // 201 * 6 * 8
const OUTPUT_BYTES = 12060; // 201 * 5 * 3 * 4
const BETAS = [0.0, 0.2, 0.5, 0.8, 1.0];
const STEP_DAYS = 0.1;
const RELEASE_INTERVAL_DAYS = 0.5;
const MAX_RELEASES = 201;
const QUANTIZE_TOLERANCE = 0.05;

export class DustTailManager {
  constructor({ halleyProvider, renderer, workerFactory, range }) {
    this.halleyProvider = halleyProvider;
    this.renderer = renderer;
    this.range = range;

    this.status = 'idle';
    this.errorLatched = false;
    this.disposed = false;
    this.inFlight = false;
    this.currentGeneration = 1;
    this.nextRequestId = 1;
    this.displayTObs = null;
    this.requestedTObs = null;
    this.lastWorkerDiagnostics = null;

    this.workerBusyJob = null;
    this.latestPending = null;
    this._isPaused = false;

    // Observability counters.
    this._postedJobs = 0;
    this._acceptedJobs = 0;
    this._staleJobs = 0;
    this._controlledErrors = 0;
    this._fatalErrors = 0;
    this._backingStoreAllocations = 0;

    // Bounded 2+2 pool. These four ArrayBuffers are the only backing stores this
    // manager ever allocates; the counter is frozen at 4 for the lifetime of the
    // pipeline (transfers reuse these same stores, never allocating new ones).
    this.inputPool = [new ArrayBuffer(INPUT_BYTES), new ArrayBuffer(INPUT_BYTES)];
    this.outputPool = [new ArrayBuffer(OUTPUT_BYTES), new ArrayBuffer(OUTPUT_BYTES)];
    this._backingStoreAllocations = 4;

    try {
      this.worker = typeof workerFactory === 'function'
        ? workerFactory()
        : new Worker(new URL('./DustTailWorker.js', import.meta.url), { type: 'module' });
      this._bindWorker();
    } catch (err) {
      this.worker = null;
      this.status = 'error';
      this.errorLatched = true;
      this._controlledErrors += 1;
    }
  }

  _bindWorker() {
    if (!this.worker) return;
    this.worker.onmessage = (e) => this._onWorkerMessage(e && 'data' in e ? e.data : e);
    this.worker.onerror = (e) => this._onWorkerFatal(e);
    this.worker.onmessageerror = (e) => this._onWorkerFatal(e);
  }

  // Fatal crash / deserialization failure / uncaught worker exception. The
  // transferred buffers are already detached on the main-thread side; we must
  // not pretend to reclaim them. Permanently deactivate the pipeline.
  _onWorkerFatal() {
    if (this.disposed) return;
    this._fatalErrors += 1;
    this.status = 'error';
    this.errorLatched = true;
    this.inFlight = false;
    this.workerBusyJob = null;
    this.latestPending = null;
    this.inputPool.length = 0;
    this.outputPool.length = 0;
    if (this.renderer) this.renderer.clear();
    if (this.worker && typeof this.worker.terminate === 'function') {
      this.worker.terminate();
    }
    this.worker = null;
  }

  // Return buffers to the pool, guarding against double-reclaim and overflow.
  _reclaimBuffers(inBuf, outBuf) {
    if (inBuf instanceof ArrayBuffer && inBuf.byteLength === INPUT_BYTES &&
        !this.inputPool.includes(inBuf) && this.inputPool.length < 2) {
      this.inputPool.push(inBuf);
    }
    if (outBuf instanceof ArrayBuffer && outBuf.byteLength === OUTPUT_BYTES &&
        !this.outputPool.includes(outBuf) && this.outputPool.length < 2) {
      this.outputPool.push(outBuf);
    }
  }

  _onWorkerMessage(response) {
    if (this.disposed || this.status === 'disposed') return;

    // Defensive first line: malformed response (null, non-object, wrong type)
    // is fail-soft; never dereference response.error.
    if (!response || typeof response !== 'object' || response.type !== 'DUST_COMPUTED') {
      this._controlledErrors += 1;
      this.status = 'error';
      this.errorLatched = true;
      this.inFlight = false;
      this.workerBusyJob = null;
      this.latestPending = null;
      if (this.renderer) this.renderer.clear();
      if (response && typeof response === 'object' &&
          response.inputBuffer instanceof ArrayBuffer && response.inputBuffer.byteLength === INPUT_BYTES &&
          response.outputBuffer instanceof ArrayBuffer && response.outputBuffer.byteLength === OUTPUT_BYTES) {
        this._reclaimBuffers(response.inputBuffer, response.outputBuffer);
      }
      return;
    }

    // Late / already-cleared job: never count as accepted, only safe-reclaim.
    if (!this.workerBusyJob) {
      this._reclaimBuffers(response.inputBuffer, response.outputBuffer);
      return;
    }

    // Branch 1: controlled worker error.
    if (response.error !== null) {
      this._controlledErrors += 1;
      this.status = 'error';
      this.errorLatched = true;
      this.inFlight = false;
      if (this.renderer) this.renderer.clear();
      this._reclaimBuffers(response.inputBuffer, response.outputBuffer);
      this.workerBusyJob = null;
      this.latestPending = null;
      return;
    }

    // Unique acceptance predicate.
    const isAccepted =
      !this.errorLatched &&
      response.generation === this.workerBusyJob.generation &&
      response.generation === this.currentGeneration &&
      response.requestId === this.workerBusyJob.requestId &&
      this.workerBusyJob.stale === false;

    if (!isAccepted) {
      // Branch 2: stale result. Never read coordinates or touch the renderer.
      this._staleJobs += 1;
      this._reclaimBuffers(response.inputBuffer, response.outputBuffer);
      this.workerBusyJob = null;
      this.inFlight = false;
      this._maybeDispatchPending();
      return;
    }

    // Branch 3: accepted result.
    this._acceptedJobs += 1;
    this.lastWorkerDiagnostics = {
      rk4Steps: response.rk4Steps,
      accelerationEvaluations: response.accelerationEvaluations
    };

    // Step 1: synchronously map + copy into the GPU buffer before reclaiming.
    const physicalArray = new Float32Array(response.outputBuffer);
    if (this.renderer) this.renderer.update(physicalArray, response.validReleaseCount);
    this.displayTObs = response.tObs;

    // If a result lands during pause, hold 'paused' rather than flipping to 'ready'.
    this.status = this._isPaused ? 'paused' : 'ready';

    // Step 2: reclaim only after the synchronous copy completed.
    this._reclaimBuffers(response.inputBuffer, response.outputBuffer);
    this.workerBusyJob = null;
    this.inFlight = false;

    // Step 3: dispatch pending (never while paused).
    this._maybeDispatchPending();
  }

  _maybeDispatchPending() {
    if (this._isPaused || this.errorLatched) return;
    if (this.latestPending && this.latestPending.generation === this.currentGeneration) {
      const pending = this.latestPending;
      this.latestPending = null;
      this._dispatchJob(pending.tObs, pending.validReleaseCount);
    }
  }

  tick(simulationTime, { paused } = {}) {
    if (this.disposed || this.status === 'disposed') return;

    if (this.errorLatched) {
      this.status = 'error';
      return;
    }

    this._isPaused = Boolean(paused);

    if (this._isPaused) {
      // Never dispatch, never overwrite pending, never bump, keep the picture.
      if (this.status !== 'error') this.status = 'paused';
      return;
    }

    const [rangeStart, rangeEnd] = this.range;
    if (simulationTime < rangeStart - QUANTIZE_TOLERANCE || simulationTime > rangeEnd + QUANTIZE_TOLERANCE) {
      this.status = 'out_of_range';
      if (this.renderer) this.renderer.clear();
      return;
    }

    // Stable anchor quantization with strict double-ended clamp.
    const tObsRaw = rangeStart + Math.round((simulationTime - rangeStart) / STEP_DAYS) * STEP_DAYS;
    const tObs = Math.min(rangeEnd, Math.max(rangeStart, tObsRaw));
    this.requestedTObs = tObs;

    if (tObs === this.displayTObs && !this.latestPending) {
      // Already drawn this quantized instant; avoid redundant dispatch.
      if (this.status !== 'computing') this.status = 'ready';
      return;
    }

    // Compute the valid release count with history truncation at range start.
    let validReleaseCount = MAX_RELEASES;
    for (let i = 0; i < MAX_RELEASES; i += 1) {
      const tRelease = tObs - i * RELEASE_INTERVAL_DAYS;
      if (tRelease < rangeStart) {
        validReleaseCount = i;
        break;
      }
    }

    if (validReleaseCount === 0) {
      if (this.renderer) this.renderer.clear();
      return;
    }

    if (this.workerBusyJob !== null) {
      this.latestPending = { generation: this.currentGeneration, tObs, validReleaseCount };
      return;
    }

    this._dispatchJob(tObs, validReleaseCount);
  }

  _dispatchJob(tObs, validReleaseCount) {
    if (this.inputPool.length === 0 || this.outputPool.length === 0 || !this.worker) return;

    const inputBuffer = this.inputPool.pop();
    const inView = new Float64Array(inputBuffer);

    // On-demand sampling with strict fail-closed validation.
    for (let i = 0; i < validReleaseCount; i += 1) {
      const tRelease = tObs - i * RELEASE_INTERVAL_DAYS;
      let sample;
      try {
        sample = this.halleyProvider.sample(tRelease);
      } catch (err) {
        sample = { ok: false };
      }

      const isValid = sample && sample.ok === true &&
        Array.isArray(sample.position) && sample.position.length === 3 && sample.position.every(Number.isFinite) &&
        Array.isArray(sample.velocity) && sample.velocity.length === 3 && sample.velocity.every(Number.isFinite);

      if (!isValid) {
        this.inputPool.push(inputBuffer);
        this.status = 'error';
        this.errorLatched = true;
        this._controlledErrors += 1;
        this.latestPending = null;
        if (this.renderer) this.renderer.clear();
        return;
      }

      const inOffset = i * 6;
      inView[inOffset] = sample.position[0];
      inView[inOffset + 1] = sample.position[1];
      inView[inOffset + 2] = sample.position[2];
      inView[inOffset + 3] = sample.velocity[0];
      inView[inOffset + 4] = sample.velocity[1];
      inView[inOffset + 5] = sample.velocity[2];
    }

    const outputBuffer = this.outputPool.pop();
    const requestId = this.nextRequestId++;

    const req = {
      type: 'COMPUTE_DUST',
      generation: this.currentGeneration,
      requestId,
      tObs,
      validReleaseCount,
      stepDays: STEP_DAYS,
      betas: [BETAS[0], BETAS[1], BETAS[2], BETAS[3], BETAS[4]],
      inputBuffer,
      outputBuffer
    };

    // postMessage wrapped in try/catch BEFORE mutating busyJob / posted counters.
    try {
      this.worker.postMessage(req, [req.inputBuffer, req.outputBuffer]);
    } catch (syncError) {
      if (inputBuffer.byteLength === INPUT_BYTES && outputBuffer.byteLength === OUTPUT_BYTES) {
        // Transfer never happened: buffers still owned, return to pool.
        this.inputPool.push(inputBuffer);
        this.outputPool.push(outputBuffer);
        this.workerBusyJob = null;
        this.inFlight = false;
        this.status = 'error';
        this.errorLatched = true;
        this._controlledErrors += 1;
        this.latestPending = null;
        if (this.renderer) this.renderer.clear();
      } else {
        // Transfer happened or indeterminate (detached): treat as fatal.
        this.inputPool.length = 0;
        this.outputPool.length = 0;
        this.workerBusyJob = null;
        this.latestPending = null;
        this.inFlight = false;
        this.status = 'error';
        this.errorLatched = true;
        this._fatalErrors += 1;
        if (this.renderer) this.renderer.clear();
        if (this.worker && typeof this.worker.terminate === 'function') {
          this.worker.terminate();
        }
        this.worker = null;
      }
      return;
    }

    this.workerBusyJob = { generation: this.currentGeneration, requestId, tObs, stale: false };
    this.inFlight = true;
    this.status = 'computing';
    this._postedJobs += 1;
  }

  // Time discontinuity (jump / seek / loop wrap): bump generation, mark the
  // in-flight job stale, clear the picture, drop pending.
  notifyTimeDiscontinuity() {
    if (this.disposed || this.errorLatched) return;
    this.currentGeneration += 1;
    if (this.workerBusyJob) this.workerBusyJob.stale = true;
    this.latestPending = null;
    if (this.renderer) this.renderer.clear();
  }

  getDiagnostics() {
    return {
      status: this.status,
      visibleCount: this.renderer ? this.renderer.visibleCount : 0,
      inFlight: this.inFlight,
      currentGeneration: this.currentGeneration,
      displayTObs: this.displayTObs,
      requestedTObs: this.requestedTObs,
      pending: this.latestPending !== null,
      inputPoolAvailable: this.inputPool.length,
      outputPoolAvailable: this.outputPool.length,
      postedJobs: this._postedJobs,
      acceptedJobs: this._acceptedJobs,
      staleJobs: this._staleJobs,
      controlledErrors: this._controlledErrors,
      fatalErrors: this._fatalErrors,
      backingStoreAllocations: this._backingStoreAllocations,
      lastWorkerDiagnostics: this.lastWorkerDiagnostics
    };
  }

  dispose() {
    this.disposed = true;
    this.status = 'disposed';
    this.inFlight = false;
    this.workerBusyJob = null;
    this.latestPending = null;
    if (this.worker && typeof this.worker.terminate === 'function') {
      this.worker.terminate();
    }
    this.worker = null;
    this.inputPool.length = 0;
    this.outputPool.length = 0;
  }
}
