import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { mapRadial, physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';
import { createEphemerisProvider, loadP1Ephemerides } from '../../src/components/solar/EphemerisProvider.js';
import { advanceOrbitalBodies, advanceSimulationTime, antiSolarDisplayDirection, hasGenericOrbitRing, orbitDisplayPosition, updateEphemerisTargets } from '../../src/components/solar/SolarEphemerisRuntime.js';

const asset = (name) => JSON.parse(readFileSync(new URL(`../../public/assets/solar/p1/${name}.json`, import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../../public/assets/solar/p1/manifest.json', import.meta.url), 'utf8'));
const mars = asset('mars');
const halley = asset('halley');
const expected = (target) => ({ target, frame: manifest.coordinate_contract, jd_tdb_range: manifest.targets[target].jd_tdb_range, source_sha256: manifest.targets[target].files.map((file) => file.sha256) });

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

  it('loads only both published P1 targets', async () => {
    const values = { 'manifest.json': manifest, 'mars.json': mars, 'halley.json': halley };
    const fetchImpl = vi.fn(async (url) => ({ ok: true, json: async () => values[url.split('/').at(-1)] }));
    const loaded = await loadP1Ephemerides(fetchImpl);
    expect(Object.keys(loaded.providers)).toEqual(['mars', 'halley']);
    expect(loaded.range).toEqual(mars.jd_tdb_range);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual(['/assets/solar/p1/manifest.json', '/assets/solar/p1/mars.json', '/assets/solar/p1/halley.json']);
  });

  it('returns the strict intersection of target ranges', async () => {
    const rangedManifest = structuredClone(manifest);
    rangedManifest.targets.mars.jd_tdb_range = [10, 30];
    rangedManifest.targets.halley.jd_tdb_range = [20, 40];
    const values = {
      'manifest.json': rangedManifest,
      'mars.json': { ...mars, jd_tdb_range: [10, 30], states: mars.states.map((row, i, rows) => [10 + (20 * i) / (rows.length - 1), ...row.slice(1)]) },
      'halley.json': { ...halley, jd_tdb_range: [20, 40], states: halley.states.map((row, i, rows) => [20 + (20 * i) / (rows.length - 1), ...row.slice(1)]) }
    };
    const fetchImpl = vi.fn(async (url) => ({ ok: true, json: async () => values[url.split('/').at(-1)] }));
    expect((await loadP1Ephemerides(fetchImpl)).range).toEqual([20, 30]);
  });

  it.each([
    ['missing manifest target', (value) => { delete value.targets.mars; }, 'manifest target mars missing'],
    ['missing coordinate contract', (value) => { delete value.coordinate_contract; }, 'manifest coordinate_contract missing'],
    ['missing range', (value) => { delete value.targets.mars.jd_tdb_range; }, 'manifest target mars range invalid'],
    ['missing files', (value) => { delete value.targets.mars.files; }, 'manifest target mars files invalid'],
    ['empty files', (value) => { value.targets.mars.files = []; }, 'manifest target mars files invalid'],
    ['missing SHA', (value) => { delete value.targets.mars.files[0].sha256; }, 'manifest target mars files invalid']
  ])('fails closed for %s', async (_label, mutate, message) => {
    const badManifest = structuredClone(manifest); mutate(badManifest);
    const values = { 'manifest.json': badManifest, 'mars.json': mars, 'halley.json': halley };
    const fetchImpl = vi.fn(async (url) => ({ ok: true, status: 200, json: async () => values[url.split('/').at(-1)] }));
    await expect(loadP1Ephemerides(fetchImpl)).rejects.toThrow(message);
  });

  it('rejects HTTP errors, provider validation errors, and disjoint ranges', async () => {
    await expect(loadP1Ephemerides(async () => ({ ok: false, status: 503 }))).rejects.toThrow('ephemeris manifest HTTP 503');
    const invalidValues = { 'manifest.json': manifest, 'mars.json': { ...mars, source_sha256: ['bad'] }, 'halley.json': halley };
    await expect(loadP1Ephemerides(async (url) => ({ ok: true, status: 200, json: async () => invalidValues[url.split('/').at(-1)] }))).rejects.toThrow('mars ephemeris source_sha_mismatch');
    const disjointManifest = structuredClone(manifest);
    disjointManifest.targets.mars.jd_tdb_range = [10, 20];
    disjointManifest.targets.halley.jd_tdb_range = [30, 40];
    const disjointValues = {
      'manifest.json': disjointManifest,
      'mars.json': { ...mars, jd_tdb_range: [10, 20], states: mars.states.map((row, i, rows) => [10 + (10 * i) / (rows.length - 1), ...row.slice(1)]) },
      'halley.json': { ...halley, jd_tdb_range: [30, 40], states: halley.states.map((row, i, rows) => [30 + (10 * i) / (rows.length - 1), ...row.slice(1)]) }
    };
    await expect(loadP1Ephemerides(async (url) => ({ ok: true, status: 200, json: async () => disjointValues[url.split('/').at(-1)] }))).rejects.toThrow('ephemeris common range invalid');
  });
});

describe('P1 coordinate and runtime math', () => {
  it('keeps placeholder, moon-relative, and asteroid-style display motion prograde', () => {
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

  it('omits only Mars from generic orbit rings', () => {
    expect(hasGenericOrbitRing('Mars')).toBe(false);
    for (const name of ['Mercury', 'Venus', 'Earth', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) expect(hasGenericOrbitRing(name)).toBe(true);
  });

  it('spins Mars without applying the generic circular orbit', () => {
    const position = { set: vi.fn() };
    const marsBody = { name: 'Mars', angle: 1, speed: .24, orbit: 25, spin: .4, mesh: { position, rotation: { y: 2 } } };
    const earthBody = { name: 'Earth', angle: 1, speed: .31, orbit: 19, spin: .4, mesh: { position: { set: vi.fn() }, rotation: { y: 2 } } };
    advanceOrbitalBodies([marsBody, earthBody], .5);
    expect(marsBody.angle).toBe(1);
    expect(position.set).not.toHaveBeenCalled();
    expect(marsBody.mesh.rotation.y).toBeCloseTo(2.2);
    expect(earthBody.angle).toBeCloseTo(1.155);
    expect(earthBody.mesh.position.set).toHaveBeenCalledOnce();
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
