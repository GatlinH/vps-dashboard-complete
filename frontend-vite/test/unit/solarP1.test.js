import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { mapRadial, physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';
import { createEphemerisProvider, loadP1Ephemerides } from '../../src/components/solar/EphemerisProvider.js';
import { advanceSimulationTime, antiSolarDisplayDirection, updateEphemerisTargets } from '../../src/components/solar/SolarEphemerisRuntime.js';

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
});

describe('P1 coordinate and runtime math', () => {
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
});
