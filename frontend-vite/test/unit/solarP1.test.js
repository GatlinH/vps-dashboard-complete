import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { mapRadial, physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';
import { createEphemerisProvider, loadP1Ephemerides } from '../../src/components/solar/EphemerisProvider.js';
import { advanceOrbitalBodies, advanceSimulationTime, antiSolarDisplayDirection, hasGenericOrbitRing, orbitDisplayPosition, updateEphemerisTargets } from '../../src/components/solar/SolarEphemerisRuntime.js';

const asset = (name) => JSON.parse(readFileSync(new URL(`../../public/assets/solar/p1/${name}.json`, import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../public/assets/solar/p1/manifest.json', import.meta.url), 'utf8'));
const targetNames = Object.keys(manifest.targets);
const assets = Object.fromEntries(targetNames.map((name) => [name, asset(name)]));
const { mars, halley } = assets;
const planetNames = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
const requiredTargets = [...planetNames, 'moon', 'halley'];
const expected = (target) => ({ target, frame: manifest.coordinate_contract, jd_tdb_range: manifest.targets[target].jd_tdb_range, source_sha256: manifest.targets[target].files.map((file) => file.sha256) });
const publishedProviders = Object.fromEntries(targetNames.map((name) => [name, createEphemerisProvider(assets[name], expected(name))]));
const holdout = JSON.parse(readFileSync(new URL('../fixtures/p3-holdout.json', import.meta.url), 'utf8'));
const holdoutNames = ['mercury', 'venus', 'earth', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon'];
const subtract = (a, b) => a.map((value, axis) => value - b[axis]);

function samplePosition(name, jd) {
  const sample = publishedProviders[name].sample(jd);
  assert.equal(sample.ok, true, `${name} must sample JD ${jd}`);
  return sample.position;
}

function positionErrors(actual, wanted, floor) {
  const actualNorm = Math.hypot(...actual), wantedNorm = Math.hypot(...wanted);
  const cosine = actual.reduce((sum, value, axis) => sum + value * wanted[axis], 0) / (actualNorm * wantedNorm);
  return {
    relative: Math.hypot(...subtract(actual, wanted)) / Math.max(wantedNorm, floor),
    degrees: Math.acos(Math.max(-1, Math.min(1, cosine))) * 180 / Math.PI,
  };
}

function validHoldoutRows(name) {
  const data = holdout.targets[name];
  const [start, end] = assets[name].jd_tdb_range;
  const valid = data.states.filter(([jd]) => jd >= start && jd <= end);
  const skipped = data.states.filter(([jd]) => jd < start || jd > end);
  expect(data.epoch_count).toBe(1051);
  expect(data.states).toHaveLength(data.epoch_count);
  expect(end).toBe(2446643.5);
  // The independent fixture extends half a day beyond the published asset.
  expect(skipped.map(([jd]) => jd)).toEqual([2446644]);
  expect(publishedProviders[name].sample(2446644)).toEqual({ ok: false, error: 'out_of_range' });
  expect(valid).toHaveLength(1050);
  const nodeJds = new Set(assets[name].states.map(([jd]) => jd));
  expect(valid.every(([jd]) => !nodeJds.has(jd))).toBe(true);
  return valid;
}

// The callback records the actual production runtime boundary. Mutants below
// replace only this injected consumer or a provider; the runtime is never mocked.
function recordPosition(target, position) {
  target.appliedPosition = [...position];
}

function runtimeFrame(applyPosition = recordPosition) {
  return {
    targets: Object.fromEntries(targetNames.map((name) => [name, { visible: false }])),
    statuses: Object.fromEntries(targetNames.map((name) => [name, {}])),
    applyPosition: vi.fn(applyPosition),
    applyTail: vi.fn(),
  };
}

function stepFrame(frame, simulationTime, providers = publishedProviders) {
  frame.applyPosition.mockClear();
  frame.applyTail.mockClear();
  updateEphemerisTargets({ ...frame, simulationTime, providers });
}

function expectedPosition(name, jd) {
  const position = samplePosition(name, jd);
  return name === 'moon' ? subtract(position, samplePosition('earth', jd)) : position;
}

// Shared by the ordinary runtime tests and all four controls. Expectations come
// from the unwrapped published provider at the requested JD, never the candidate.
function assertRuntimeFrame(frame, jd, failedNames = []) {
  for (const name of targetNames) {
    const target = frame.targets[name], status = frame.statuses[name];
    assert.equal(status.lastJd, jd, `${name} lastJd`);
    const calls = frame.applyPosition.mock.calls.filter(([, , key]) => key === name);
    if (failedNames.includes(name)) {
      assert.equal(status.ok, false, `${name} must fail`);
      assert.equal(target.visible, false, `${name} must hide`);
      assert.equal(status.lastPhysicalPosition, null, `${name} stale position must clear`);
      assert.equal(status.lastTailDirection, null, `${name} stale tail must clear`);
      assert.ok(status.error, `${name} must expose the failure`);
      assert.equal(calls.length, 0, `${name} must not apply a failed sample`);
    } else {
      assert.equal(status.ok, true, `${name} must succeed`);
      assert.equal(target.visible, true, `${name} must show`);
      assert.equal(status.error, null, `${name} stale error must clear`);
      const wanted = expectedPosition(name, jd);
      assert.deepEqual(target.appliedPosition, wanted, `${name} applyPosition must equal provider at requested JD`);
      assert.deepEqual(status.lastPhysicalPosition, wanted, `${name} physical snapshot`);
      assert.equal(calls.length, 1, `${name} must apply once`);
      assert.equal(calls[0][0], target, `${name} mesh identity`);
      assert.deepEqual(calls[0][1], wanted, `${name} runtime callback position`);
      assert.deepEqual(calls[0][3].position, samplePosition(name, jd), `${name} raw sample`);
    }
  }
  assert.equal(frame.applyTail.mock.calls.length, failedNames.includes('halley') ? 0 : 1);
}

function assertRejected(label, gate, message) {
  // Capture a real assertion failure, including its diagnostic, as raw evidence.
  assert.throws(gate, (error) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.match(error.message, message);
    console.log(`[P3-A3 control] ${label}: rejected (${error.message.split('\n')[0]})`);
    return true;
  });
}

// Every stub starts with the complete published manifest. Unknown URLs fail
// explicitly instead of returning undefined and masking the intended failure.
function publishedFetch(overrides = {}, httpErrors = {}) {
  const values = {
    '/assets/solar/p1/manifest.json': manifest,
    ...Object.fromEntries(targetNames.map((name) => [`/assets/solar/p1/${name}.json`, assets[name]])),
    ...overrides,
  };
  return vi.fn(async (url) => {
    if (!Object.hasOwn(values, url)) throw new Error(`unexpected ephemeris URL: ${url}`);
    if (Object.hasOwn(httpErrors, url)) return { ok: false, status: httpErrors[url] };
    return { ok: true, status: 200, json: async () => values[url] };
  });
}

function rangedFetch(ranges) {
  const rangedManifest = structuredClone(manifest);
  const overrides = { '/assets/solar/p1/manifest.json': rangedManifest };
  for (const name of targetNames) {
    const [start, end] = ranges[name];
    rangedManifest.targets[name].jd_tdb_range = [start, end];
    overrides[`/assets/solar/p1/${name}.json`] = {
      ...assets[name], jd_tdb_range: [start, end],
      states: assets[name].states.map((row, i, rows) => [
        start + ((end - start) * i) / (rows.length - 1), ...row.slice(1),
      ]),
    };
  }
  return publishedFetch(overrides);
}

function independentHermite(a, b, jd) {
  const h = b[0] - a[0], t = (jd - a[0]) / h, t2 = t * t, t3 = t2 * t;
  return [0, 1, 2].map((i) => (2*t3-3*t2+1)*a[i+1] + (t3-2*t2+t)*h*a[i+4] + (-2*t3+3*t2)*b[i+1] + (t3-t2)*h*b[i+4]);
}

function assertDirection(actual, wanted) {
  for (const axis of ['x', 'y', 'z']) expect(actual[axis]).toBeCloseTo(wanted[axis], 12);
}

describe('P1 published ephemerides', () => {
  for (const [target, data] of [['mars', mars], ['halley', halley]]) it(`${target} asset and held-out interpolation`, () => {
    expect(data.states).toHaveLength(1050);
    expect(data.states.every((row, i) => i === 0 || row[0] > data.states[i - 1][0])).toBe(true);
    expect([data.states[0][0], data.states.at(-1)[0]]).toEqual(data.jd_tdb_range);
    expect(data.source_sha256).toEqual(manifest.targets[target].files.map((file) => file.sha256));
    const provider = createEphemerisProvider(data, expected(target)); expect(provider.ok).toBe(true);
    for (const [index, fraction] of [[211, 0.371], [527, 0.725]]) {
      const a = data.states[index], b = data.states[index + 1], jd = a[0] + (b[0] - a[0]) * fraction;
      const sample = provider.sample(jd); expect(sample.ok).toBe(true);
      sample.position.forEach((value, axis) => expect(value).toBeCloseTo(independentHermite(a, b, jd)[axis], 12));
    }
  });

  it.each([
    ['schema', { schema_version: 2 }, 'invalid_schema'], ['target', { target: 'venus' }, 'invalid_target'],
    ['frame', { frame: { ...mars.frame, center: 'Earth (399)' } }, 'invalid_frame'], ['time scale', { time_scale: 'UTC' }, 'invalid_time_scale'],
    ['units', { units: { ...mars.units, position: 'km' } }, 'invalid_units'], ['1049 states', { states: mars.states.slice(0, -1) }, 'invalid_states'],
    ['non-monotonic states', { states: mars.states.map((row, i) => i === 500 ? [...mars.states[499]] : row) }, 'non_monotonic'],
    ['SHA', { source_sha256: ['bad'] }, 'source_sha_mismatch']
  ])('rejects invalid %s', (_label, patch, error) => expect(createEphemerisProvider({ ...mars, ...patch }, expected('mars'))).toEqual({ ok: false, error }));

  it('returns out_of_range for valid provider boundaries', () => {
    const provider = createEphemerisProvider(mars, expected('mars')); expect(provider.ok).toBe(true);
    expect(provider.sample(mars.jd_tdb_range[0] - 1)).toEqual({ ok: false, error: 'out_of_range' });
    expect(provider.sample(mars.jd_tdb_range[1] + 1)).toEqual({ ok: false, error: 'out_of_range' });
  });

  it('freezes all ten required keys in the published manifest', () => {
    expect([...targetNames].sort()).toEqual([...requiredTargets].sort());
  });

  it('loads all ten manifest targets in order with exact URLs and common range', async () => {
    const fetchImpl = publishedFetch();
    const loaded = await loadP1Ephemerides(fetchImpl);
    expect(Object.keys(loaded.providers)).toEqual(targetNames);
    expect(Object.keys(loaded.providers).sort()).toEqual([...requiredTargets].sort());
    expect(loaded.range).toEqual([2446078.5, 2446643.5]);
    for (const name of targetNames) {
      expect(loaded.providers[name].ok).toBe(true);
      expect(loaded.providers[name].sample(2446300.125)).toEqual(publishedProviders[name].sample(2446300.125));
    }
    expect(fetchImpl.mock.calls).toEqual([
      ['/assets/solar/p1/manifest.json'],
      ...targetNames.map((name) => [`/assets/solar/p1/${name}.json`]),
    ]);
  });

  it('returns the strict intersection of all ten target ranges', async () => {
    const ranges = Object.fromEntries(targetNames.map((name, i) => [name, [10 + i, 40 - i]]));
    // Different targets constrain the two ends; a two-target loader cannot pass.
    ranges.moon = [12, 29];
    expect((await loadP1Ephemerides(rangedFetch(ranges))).range).toEqual([18, 29]);
  });

  it.each([
    ['missing targets', (value) => { delete value.targets; }, 'manifest targets missing'],
    ['empty targets', (value) => { value.targets = {}; }, 'manifest targets missing'],
    ['array targets', (value) => { value.targets = []; }, 'manifest targets missing'],
    ['missing coordinate contract', (value) => { delete value.coordinate_contract; }, 'manifest coordinate_contract missing'],
  ])('fails closed for %s', async (_label, mutate, message) => {
    const badManifest = structuredClone(manifest); mutate(badManifest);
    await expect(loadP1Ephemerides(publishedFetch({ '/assets/solar/p1/manifest.json': badManifest }))).rejects.toThrow(message);
  });

  it.each(targetNames)('fails closed for missing %s metadata', async (name) => {
    for (const [mutate, reason] of [
      [(value) => { value.targets[name] = null; }, 'missing'],
      [(value) => { delete value.targets[name].jd_tdb_range; }, 'range invalid'],
      [(value) => { delete value.targets[name].files; }, 'files invalid'],
      [(value) => { value.targets[name].files = []; }, 'files invalid'],
      [(value) => { delete value.targets[name].files[0].sha256; }, 'files invalid'],
    ]) {
      const badManifest = structuredClone(manifest); mutate(badManifest);
      await expect(loadP1Ephemerides(publishedFetch({ '/assets/solar/p1/manifest.json': badManifest }))).rejects.toThrow(`manifest target ${name} ${reason}`);
    }
  });

  it('rejects manifest HTTP errors', async () => {
    await expect(loadP1Ephemerides(publishedFetch({}, { '/assets/solar/p1/manifest.json': 503 }))).rejects.toThrow('ephemeris manifest HTTP 503');
  });

  it.each(targetNames)('rejects %s HTTP and provider validation errors', async (name) => {
    const url = `/assets/solar/p1/${name}.json`;
    await expect(loadP1Ephemerides(publishedFetch({}, { [url]: 404 }))).rejects.toThrow(`${name} ephemeris HTTP 404`);
    await expect(loadP1Ephemerides(publishedFetch({ [url]: { ...assets[name], source_sha256: ['bad'] } }))).rejects.toThrow(`${name} ephemeris source_sha_mismatch`);
  });

  it('rejects disjoint ranges across the full manifest', async () => {
    const ranges = Object.fromEntries(targetNames.map((name) => [name, [10, 40]]));
    ranges.uranus = [10, 20];
    ranges.moon = [30, 40];
    await expect(loadP1Ephemerides(rangedFetch(ranges))).rejects.toThrow('ephemeris common range invalid');
  });
});

describe('P1 coordinate and runtime math', () => {
  it('keeps the retained asteroid-style display helper prograde', () => {
    const position = (radius, angle) => orbitDisplayPosition(radius, angle);
    const ly = (a, b) => a.z * b.x - a.x * b.z;
    expect(ly(position(19, 0.2), position(19, 0.2 + 0.1))).toBeGreaterThan(0);
    expect(ly(position(2, 1.1), position(2, 1.1 + 0.1))).toBeGreaterThan(0);
    expect(ly(position(30, 2.2), position(30, 2.2 + 0.1))).toBeGreaterThan(0);
  });

  it('rejects the legacy positive-z sine generator', () => {
    const legacy = (radius, angle) => ({ x: radius * Math.cos(angle), z: radius * Math.sin(angle) });
    const ly = (a, b) => a.z * b.x - a.x * b.z;
    expect(ly(legacy(19, 0.2), legacy(19, 0.2 + 0.1))).toBeLessThan(0);
  });

  it('maps every radial node exactly and continuously', () => {
    for (const [radius, display] of [[0, 0], [.39, 9], [1, 19], [5.2, 35], [30.1, 62]]) {
      expect(mapRadial(radius)).toBe(display);
      if (radius > 0) expect(Math.abs(mapRadial(radius - 1e-9) - mapRadial(radius + 1e-9))).toBeLessThan(1e-6);
    }
    expect(mapRadial(31.1)).toBe(63.5);
  });

  it('maps physical X,Y,Z to Three X,Z,-Y', () => {
    const value = physicalToDisplay({ x: 1, y: 2, z: 3 }), scale = mapRadial(Math.sqrt(14)) / Math.sqrt(14);
    expect(value.x).toBeCloseTo(scale); expect(value.y).toBeCloseTo(3 * scale); expect(value.z).toBeCloseTo(-2 * scale);
    expect(physicalToDisplay([1, 2, 3])).toEqual(value);
  });

  it.each([
    ['+X', { x: 2, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], ['+Y', { x: 0, y: 2, z: 0 }, { x: 0, y: 0, z: -1 }],
    ['+Z', { x: 0, y: 0, z: 2 }, { x: 0, y: 1, z: 0 }], ['diagonal', { x: 1, y: 2, z: 3 }, { x: 1/Math.sqrt(14), y: 3/Math.sqrt(14), z: -2/Math.sqrt(14) }]
  ])('maps %s anti-solar direction and rejects a reversed production result', (_label, comet, wanted) => {
    const direction = antiSolarDisplayDirection(comet, { x: 0, y: 0, z: 0 });
    assertDirection(direction, wanted);
    expect(() => assertDirection({ x: -direction.x, y: -direction.y, z: -direction.z }, wanted)).toThrow();
  });

  it('advances and wraps a single simulation clock', () => {
    expect(advanceSimulationTime(10, .5, 4, [10, 20])).toBe(12);
    expect(advanceSimulationTime(19, 1, 4, [10, 20])).toBe(13);
  });

  it.each(planetNames)('omits %s from generic orbit rings', (name) => {
    expect(hasGenericOrbitRing(name[0].toUpperCase() + name.slice(1))).toBe(false);
  });

  it('only spins all planets, Moon, Sun and Earth clouds without changing orbital angles or positions', () => {
    const bodies = [...planetNames, 'moon', 'sun'].map((name, i) => ({
      name: name[0].toUpperCase() + name.slice(1), angle: 1 + i, speed: .31, orbit: 19,
      spin: .1 * (i + 1), mesh: { position: { set: vi.fn() }, rotation: { y: 2 } },
    }));
    const clouds = { rotation: { y: 3 } };
    advanceOrbitalBodies(bodies, .5, clouds);
    bodies.forEach((body, i) => {
      expect(body.angle).toBe(1 + i);
      expect(body.mesh.position.set).not.toHaveBeenCalled();
      expect(body.mesh.rotation.y).toBeCloseTo(2 + body.spin * .5, 12);
    });
    expect(clouds.rotation.y).toBeCloseTo(3 + bodies[2].spin * 1.18 * .5, 12);
    const rotations = bodies.map((body) => body.mesh.rotation.y);
    advanceOrbitalBodies(bodies, 0, clouds);
    expect(bodies.map((body) => body.mesh.rotation.y)).toEqual(rotations);
    expect(clouds.rotation.y).toBeCloseTo(3 + bodies[2].spin * 1.18 * .5, 12);
  });

  it.each([
    ['Mars failure', { mars: { ok: false, error: 'out_of_range' }, halley: { ok: true, position: [1, 2, 3] } }, false, true],
    ['Halley failure', { mars: { ok: true, position: [1, 2, 3] }, halley: { ok: false, error: 'out_of_range' } }, true, false]
  ])('isolates %s and enforces successful-target visibility', (_label, samples, marsVisible, halleyVisible) => {
    const targets = { mars: { visible: true }, halley: { visible: true } }, statuses = { mars: {}, halley: {} };
    updateEphemerisTargets({ simulationTime: 5, providers: { mars: { sample: () => samples.mars }, halley: { sample: () => samples.halley } }, targets, statuses, applyPosition: (target) => { target.updated = true; }, applyTail: () => {} });
    expect(targets.mars.visible).toBe(marsVisible); expect(targets.halley.visible).toBe(halleyVisible);
    const successful = halleyVisible ? targets.halley : targets.mars;
    expect(successful.visible).toBe(true);
  });

  it('publishes physical positions and clears stale debug state on failure', () => {
    const targets = { mars: { visible: true }, halley: { visible: true } };
    const statuses = { mars: {}, halley: {} };
    const samples = { mars: { ok: true, position: [1, 2, 3] }, halley: { ok: true, position: [4, 5, 6] } };
    updateEphemerisTargets({ simulationTime: 5, providers: { mars: { sample: () => samples.mars }, halley: { sample: () => samples.halley } }, targets, statuses, applyPosition: () => {}, applyTail: () => {} });
    expect(statuses.mars.lastPhysicalPosition).toEqual([1, 2, 3]);
    expect(statuses.halley.lastPhysicalPosition).toEqual([4, 5, 6]);
    expect(statuses.halley.lastTailDirection).toEqual(antiSolarDisplayDirection([4, 5, 6]));
    samples.halley = { ok: false, error: 'out_of_range' };
    updateEphemerisTargets({ simulationTime: 6, providers: { mars: { sample: () => samples.mars }, halley: { sample: () => samples.halley } }, targets, statuses, applyPosition: () => {}, applyTail: () => {} });
    expect(statuses.halley.ok).toBe(false);
    expect(statuses.halley.lastPhysicalPosition).toBeNull();
    expect(statuses.halley.lastTailDirection).toBeNull();
  });

  it('isolates apply failures per target and recovers on the next frame', () => {
    const targets = { mars: { visible: false }, halley: { visible: false } }, statuses = { mars: {}, halley: {} };
    let failMars = true;
    const args = { simulationTime: 5, providers: { mars: { sample: () => ({ ok: true, position: [1, 2, 3] }) }, halley: { sample: () => ({ ok: true, position: [4, 5, 6] }) } }, targets, statuses, applyPosition: (target, _position, name) => { if (name === 'mars' && failMars) throw new Error('mars apply exploded'); target.updated = (target.updated || 0) + 1; }, applyTail: (target) => { target.tailUpdated = (target.tailUpdated || 0) + 1; } };
    updateEphemerisTargets(args);
    expect(targets.mars.visible).toBe(false);
    expect(statuses.mars).toMatchObject({ ok: false, error: 'mars apply exploded', lastPhysicalPosition: null, lastTailDirection: null });
    expect(targets.halley).toMatchObject({ visible: true, updated: 1, tailUpdated: 1 });
    failMars = false;
    updateEphemerisTargets({ ...args, simulationTime: 6 });
    expect(targets.mars.visible).toBe(true);
    expect(statuses.mars).toMatchObject({ ok: true, error: null, lastPhysicalPosition: [1, 2, 3] });
    expect(targets.halley.updated).toBe(2);
  });
});

describe('P3-A independent published holdout accuracy', () => {
  it('uses the same heliocentric TDB/AU contract and all eight independent targets', () => {
    expect(holdout.coordinate_contract).toEqual(manifest.coordinate_contract);
    expect(holdout.units).toEqual({ position: 'AU', velocity: 'AU/day' });
    expect(Object.keys(holdout.targets)).toEqual(holdoutNames);
  });

  it.each(holdoutNames)('%s: verifies all 1050 in-range heliocentric holdout epochs', (name) => {
    let maxRelative = 0, maxDegrees = 0;
    for (const [jd, x, y, z] of validHoldoutRows(name)) {
      const errors = positionErrors(samplePosition(name, jd), [x, y, z], 1e-3);
      expect(errors.relative, `${name} relative error at JD ${jd}`).toBeLessThanOrEqual(1e-4);
      expect(errors.degrees, `${name} direction error at JD ${jd}`).toBeLessThanOrEqual(0.05);
      maxRelative = Math.max(maxRelative, errors.relative);
      maxDegrees = Math.max(maxDegrees, errors.degrees);
    }
    console.log(`[P3-A3 holdout] ${name}: valid=1050 skipped=2446644 maxRelative=${maxRelative} maxDegrees=${maxDegrees}`);
  });

  it('Moon minus Earth: verifies all 1050 same-JD geocentric holdout vectors', () => {
    const earthRows = new Map(validHoldoutRows('earth').map(([jd, x, y, z]) => [jd, [x, y, z]]));
    let checked = 0, maxRelative = 0, maxDegrees = 0;
    for (const [jd, x, y, z] of validHoldoutRows('moon')) {
      expect(earthRows.has(jd), `Earth holdout at Moon JD ${jd}`).toBe(true);
      const wanted = subtract([x, y, z], earthRows.get(jd));
      // Both published providers are sampled independently at exactly this JD.
      const actual = subtract(samplePosition('moon', jd), samplePosition('earth', jd));
      const errors = positionErrors(actual, wanted, 1e-4);
      expect(errors.relative, `Moon-Earth relative error at JD ${jd}`).toBeLessThanOrEqual(1e-4);
      expect(errors.degrees, `Moon-Earth direction error at JD ${jd}`).toBeLessThanOrEqual(0.05);
      maxRelative = Math.max(maxRelative, errors.relative);
      maxDegrees = Math.max(maxDegrees, errors.degrees);
      checked += 1;
    }
    expect(checked).toBe(1050);
    console.log(`[P3-A3 holdout] Moon-Earth: valid=${checked} maxRelative=${maxRelative} maxDegrees=${maxDegrees}`);
  });
});

describe('P3-A unified ephemeris runtime', () => {
  it.each([2446078.5, 2446187.375, 2446500.12345, 2446643.5])('applies all ten provider positions at the same requested JD %s', (jd) => {
    const providers = Object.fromEntries(targetNames.map((name) => [name, {
      sample: vi.fn((requested) => publishedProviders[name].sample(requested)),
    }]));
    const frame = runtimeFrame();
    stepFrame(frame, jd, providers);
    assertRuntimeFrame(frame, jd);
    for (const name of targetNames) {
      expect(providers[name].sample.mock.calls).toEqual(Array.from({ length: name === 'earth' ? 2 : 1 }, () => [jd]));
    }
  });

  it('freezes every position while paused and responds exactly to arbitrary clock jumps', () => {
    const frame = runtimeFrame();
    const jd = 2446300.125;
    stepFrame(frame, jd);
    assertRuntimeFrame(frame, jd);
    const before = structuredClone(frame.statuses);
    const pausedJd = advanceSimulationTime(jd, 0, 12, mars.jd_tdb_range);
    expect(pausedJd).toBe(jd);
    stepFrame(frame, pausedJd);
    assertRuntimeFrame(frame, pausedJd);
    expect(frame.statuses).toEqual(before);
    for (const nextJd of [2446555.875, 2446100.25]) {
      stepFrame(frame, nextJd);
      assertRuntimeFrame(frame, nextJd);
    }
  });

  it.each(targetNames.flatMap((name) => ['throws', 'returns failure'].map((mode) => [name, mode])))('isolates %s when its provider %s and recovers next frame', (name, mode) => {
    const frame = runtimeFrame();
    const jd = 2446300.125;
    stepFrame(frame, jd);
    assertRuntimeFrame(frame, jd);
    const broken = { sample: () => {
      if (mode === 'throws') throw new Error(`${name} provider exploded`);
      return publishedProviders[name].sample(assets[name].jd_tdb_range[1] + 1);
    } };
    stepFrame(frame, jd + 1, { ...publishedProviders, [name]: broken });
    // A failed Earth sample also invalidates the dependent geocentric Moon.
    const failed = name === 'earth' ? ['earth', 'moon'] : [name];
    assertRuntimeFrame(frame, jd + 1, failed);
    for (const key of failed) {
      expect(frame.statuses[key].error).toBe(mode === 'throws' ? `${name} provider exploded` : 'out_of_range');
    }
    stepFrame(frame, jd + 2);
    assertRuntimeFrame(frame, jd + 2);
  });

  it('isolates a failed Earth dependency even when Earth itself sampled successfully', () => {
    const frame = runtimeFrame();
    const jd = 2446300.125;
    stepFrame(frame, jd);
    let earthCalls = 0;
    const earth = { sample: (requested) => {
      earthCalls += 1;
      return publishedProviders.earth.sample(earthCalls === 1 ? requested : 2446644);
    } };
    stepFrame(frame, jd + 1, { ...publishedProviders, earth });
    expect(earthCalls).toBe(2);
    assertRuntimeFrame(frame, jd + 1, ['moon']);
    expect(frame.statuses.moon.error).toBe('out_of_range');
    stepFrame(frame, jd + 2);
    assertRuntimeFrame(frame, jd + 2);
  });

  it('runs the real SolarSystem frame and display callbacks through pause and clock jumps', () => {
    // Use real Three objects without constructing a WebGL renderer or DOM.
    const targets = Object.fromEntries(targetNames.map((name) => [name, new THREE.Object3D()]));
    const tail = new THREE.Object3D();
    tail.material = { opacity: 0 };
    const system = Object.assign(Object.create(SolarSystem.prototype), {
      simulationTime: 2446300.125, simulationDaysPerSecond: 12,
      ephemerides: { providers: publishedProviders, range: mars.jd_tdb_range },
      ephemerisTargets: targets,
      ephemerisStatus: { targets: Object.fromEntries(targetNames.map((name) => [name, {}])) },
      bodies: [], sun: new THREE.Object3D(), sunLight: new THREE.Object3D(), earth: targets.earth,
      halley: { tail, crossTail: new THREE.Object3D(), flame: new THREE.Object3D() },
    });
    const assertDisplay = () => {
      for (const name of targetNames) {
        const position = expectedPosition(name, system.simulationTime);
        const wanted = name === 'moon'
          ? new THREE.Vector3(...Object.values(physicalToDisplay(samplePosition('earth', system.simulationTime))))
            .add(new THREE.Vector3(position[0], position[2], -position[1]).multiplyScalar(1089.68)).toArray()
          : Object.values(physicalToDisplay(position));
        expect(targets[name].visible, name).toBe(true);
        expect(targets[name].position.toArray(), name).toEqual(wanted);
        expect(system.ephemerisStatus.targets[name].lastJd, name).toBe(system.simulationTime);
      }
    };
    system._advanceBodies(.125);
    expect(system.simulationTime).toBe(2446301.625);
    assertDisplay();
    const before = Object.values(targets).map((target) => target.position.toArray());
    system._advanceBodies(0);
    assertDisplay();
    expect(Object.values(targets).map((target) => target.position.toArray())).toEqual(before);
    system.simulationTime = 2446500.375;
    system._advanceBodies(0);
    assertDisplay();
  });
});

describe('P3-A falsifiable orbital behavior', () => {
  it('finds Mercury apsides dynamically and requires a one-day displacement ratio >= 1.45', () => {
    // Search the published epochs through the real provider, retaining room for
    // the one-day forward displacement. No epoch or expected ratio is baked in.
    const candidates = assets.mercury.states.map(([jd]) => jd).filter((jd) => jd + 1 <= assets.mercury.jd_tdb_range[1]);
    const radii = candidates.map((jd) => ({ jd, radius: Math.hypot(...samplePosition('mercury', jd)) }));
    const peri = radii.reduce((best, row) => row.radius < best.radius ? row : best);
    const aph = radii.reduce((best, row) => row.radius > best.radius ? row : best);
    const frame = runtimeFrame();
    const position = (jd) => {
      stepFrame(frame, jd);
      assertRuntimeFrame(frame, jd);
      return frame.targets.mercury.appliedPosition;
    };
    const displacement = (jd) => Math.hypot(...subtract(position(jd + 1), position(jd)));
    const ratio = displacement(peri.jd) / displacement(aph.jd);
    expect(ratio).toBeGreaterThanOrEqual(1.45);
    console.log(`[P3-A3 behavior] Mercury periJD=${peri.jd} aphJD=${aph.jd} oneDaySpeedRatio=${ratio}`);
  });

  it('preserves Mercury inclination with max absolute display y >= 0.5', () => {
    const frame = runtimeFrame();
    let maxY = 0;
    for (const [jd] of assets.mercury.states) {
      stepFrame(frame, jd);
      // Also guards every ordinary body's pointwise path across the full grid.
      assertRuntimeFrame(frame, jd);
      maxY = Math.max(maxY, Math.abs(physicalToDisplay(frame.targets.mercury.appliedPosition).y));
    }
    expect(maxY).toBeGreaterThanOrEqual(0.5);
    console.log(`[P3-A3 behavior] Mercury maxAbsDisplayY=${maxY}`);
  });
});

describe('P3-A counterexample controls at production boundaries', () => {
  it('C1 rejects a handwritten Venus circle and accepts real ephemeris output', () => {
    const jd = 2446300.125;
    const circle = runtimeFrame((target, position, name) => {
      const angle = .44 * (jd - mars.jd_tdb_range[0]);
      recordPosition(target, name === 'venus' ? [13.5 * Math.cos(angle), 0, -13.5 * Math.sin(angle)] : position);
    });
    stepFrame(circle, jd);
    // Status alone is insufficient: the fake consumer overwrites the position.
    expect(circle.statuses.venus.lastPhysicalPosition).toEqual(samplePosition('venus', jd));
    assertRejected('C1 Venus circle', () => assertRuntimeFrame(circle, jd), /venus applyPosition/);
    const positive = runtimeFrame();
    stepFrame(positive, jd);
    assertRuntimeFrame(positive, jd);
    console.log('[P3-A3 control] C1 real ephemeris: accepted');
  });

  it('C2 rejects Mars sampling at simulationTime + 0.5 even though lastJd matches', () => {
    const jd = 2446300.125;
    const capturedJds = [];
    const shiftedMars = { sample: (requested) => {
      capturedJds.push(requested + .5);
      return publishedProviders.mars.sample(requested + .5);
    } };
    const shifted = runtimeFrame();
    stepFrame(shifted, jd, { ...publishedProviders, mars: shiftedMars });
    expect(capturedJds).toEqual([jd + .5]);
    expect(shifted.statuses.mars.lastJd).toBe(jd); // Demonstrates the status-only false green.
    expect(shifted.targets.mars.appliedPosition).toEqual(samplePosition('mars', jd + .5));
    expect(shifted.targets.mars.appliedPosition).not.toEqual(samplePosition('mars', jd));
    assertRejected('C2 Mars +0.5 day', () => assertRuntimeFrame(shifted, jd), /mars applyPosition/);
    const positive = runtimeFrame();
    stepFrame(positive, jd);
    assertRuntimeFrame(positive, jd);
    console.log('[P3-A3 control] C2 requested simulationTime: accepted');
  });

  it('C3 rejects heliocentric Moon wiring and accepts Moon minus Earth', () => {
    const jd = 2446300.125;
    const directMoon = runtimeFrame((target, position, name, sample) => {
      recordPosition(target, name === 'moon' ? sample.position : position);
    });
    stepFrame(directMoon, jd);
    expect(directMoon.targets.moon.appliedPosition).toEqual(samplePosition('moon', jd));
    assertRejected('C3 heliocentric Moon', () => assertRuntimeFrame(directMoon, jd), /moon applyPosition/);
    const positive = runtimeFrame();
    stepFrame(positive, jd);
    assertRuntimeFrame(positive, jd);
    expect(positive.targets.moon.appliedPosition).toEqual(subtract(samplePosition('moon', jd), samplePosition('earth', jd)));
    console.log('[P3-A3 control] C3 geocentric Moon: accepted');
  });

  it('C4 rejects corrupt Uranus as healthy, preserves the other nine and recovers', () => {
    const jd = 2446300.125;
    const damaged = createEphemerisProvider({ ...assets.uranus, states: assets.uranus.states.slice(0, -1) }, expected('uranus'));
    expect(damaged).toEqual({ ok: false, error: 'invalid_states' });
    const frame = runtimeFrame();
    stepFrame(frame, jd);
    assertRuntimeFrame(frame, jd);
    // Feed the real validator's failure through the runtime's sample boundary.
    stepFrame(frame, jd + 1, { ...publishedProviders, uranus: { sample: () => damaged } });
    assertRejected('C4 corrupt Uranus cannot be healthy', () => assertRuntimeFrame(frame, jd + 1), /uranus must succeed/);
    assertRuntimeFrame(frame, jd + 1, ['uranus']);
    expect(frame.statuses.uranus.error).toBe('invalid_states');
    console.log('[P3-A3 control] C4 only Uranus failed; other nine at the requested JD: accepted');
    stepFrame(frame, jd + 2);
    assertRuntimeFrame(frame, jd + 2);
    console.log('[P3-A3 control] C4 restored Uranus: accepted');
  });
});
