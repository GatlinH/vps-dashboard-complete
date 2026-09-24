import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MU_EARTH_MOON_AU3_DAY2,
  MU_SUN_AU3_DAY2,
  createContinuousEphemerisProviders,
  orbitalPeriodDays,
  propagateTwoBody,
} from '../../src/components/solar/TwoBodyEphemeris.js';
import { advanceSimulationTime } from '../../src/components/solar/SolarEphemerisRuntime.js';
import { createEphemerisProvider } from '../../src/components/solar/EphemerisProvider.js';

const asset = (name) =>
  JSON.parse(readFileSync(new URL(`../../public/assets/solar/p1/${name}.json`, import.meta.url)));
const names = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'moon',
  'halley',
];
const raw = Object.fromEntries(names.map((name) => [name, asset(name)]));
const finiteState = (state) =>
  state?.ok && [...state.position, ...state.velocity].every(Number.isFinite);
const distance = (a, b) => Math.hypot(...a.map((value, axis) => value - b[axis]));

describe('continuous real-period solar clock', () => {
  it('never rolls time backward at the former 565-day boundary', () => {
    expect(advanceSimulationTime(2446643.49, 1, 12, [2446078.5, 2446643.5])).toBeCloseTo(
      2446655.49,
      10,
    );
    expect(advanceSimulationTime(2446643.5, 30, 12, [2446078.5, 2446643.5])).toBeCloseTo(
      2447003.5,
      10,
    );
    expect(advanceSimulationTime(10, -5, 12, [0, 1])).toBe(10);
  });

  it('fails closed for non-finite time, state, or non-positive GM', () => {
    expect(advanceSimulationTime(NaN, 1, 12, [0, 1])).toBeNaN();
    expect(propagateTwoBody([1, 0, 0], [0, 0.01, 0], Infinity, MU_SUN_AU3_DAY2)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(propagateTwoBody([1, 0, 0], [0, NaN, 0], 1, MU_SUN_AU3_DAY2)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
    expect(propagateTwoBody([1, 0, 0], [0, 0.01, 0], 1, 0)).toEqual({
      ok: false,
      error: 'invalid_input',
    });
  });
});

describe('endpoint-anchored two-body continuation', () => {
  const providers = createContinuousEphemerisProviders(
    Object.fromEntries(names.map((name) => [name, createEphemerisProvider(raw[name])])),
  );

  it.each(names)('%s preserves exact position and velocity at both window endpoints', (name) => {
    const [start, end] = raw[name].jd_tdb_range;
    for (const [jd, row] of [
      [start, raw[name].states[0]],
      [end, raw[name].states.at(-1)],
    ]) {
      const state = providers[name].sample(jd);
      expect(state.ok).toBe(true);
      expect(state.position).toEqual(row.slice(1, 4));
      expect(state.velocity).toEqual(row.slice(4, 7));
    }
  });

  it.each(names)('%s is position/velocity continuous just outside both endpoints', (name) => {
    const [start, end] = raw[name].jd_tdb_range;
    for (const [insideJd, outsideJd] of [
      [start, start - 1e-7],
      [end, end + 1e-7],
    ]) {
      const inside = providers[name].sample(insideJd);
      const outside = providers[name].sample(outsideJd);
      expect(finiteState(outside)).toBe(true);
      expect(distance(outside.position, inside.position), `${name} position`).toBeLessThan(1e-7);
      expect(distance(outside.velocity, inside.velocity), `${name} velocity`).toBeLessThan(1e-7);
    }
  });

  it('keeps genuine Hermite interpolation byte-for-byte inside the window', () => {
    for (const name of names) {
      const jd = raw[name].states[400][0] + 0.321;
      expect(providers[name].sample(jd)).toEqual(createEphemerisProvider(raw[name]).sample(jd));
    }
  });

  it('uses body-specific osculating periods instead of the asset window', () => {
    const periods = Object.fromEntries(
      names
        .filter((name) => name !== 'moon')
        .map((name) => [
          name,
          orbitalPeriodDays(
            raw[name].states.at(-1).slice(1, 4),
            raw[name].states.at(-1).slice(4, 7),
            MU_SUN_AU3_DAY2,
          ),
        ]),
    );
    expect(periods.mercury).toBeGreaterThan(80);
    expect(periods.mercury).toBeLessThan(100);
    expect(periods.earth).toBeGreaterThan(350);
    expect(periods.earth).toBeLessThan(380);
    expect(periods.jupiter).toBeGreaterThan(4000);
    expect(periods.halley).toBeGreaterThan(20000);
    expect(new Set(Object.values(periods).map((value) => Math.round(value))).size).toBe(
      names.length - 1,
    );
    expect(Object.values(periods).every((period) => Math.abs(period - 565) > 1)).toBe(true);
  });

  it('propagates Moon relative to Earth with Earth+Moon GM and then adds Earth', () => {
    const end = raw.moon.jd_tdb_range[1];
    const moon0 = raw.moon.states.at(-1);
    const earth0 = raw.earth.states.at(-1);
    const relativePosition = moon0.slice(1, 4).map((v, i) => v - earth0[i + 1]);
    const relativeVelocity = moon0.slice(4, 7).map((v, i) => v - earth0[i + 4]);
    const period = orbitalPeriodDays(relativePosition, relativeVelocity, MU_EARTH_MOON_AU3_DAY2);
    expect(period).toBeGreaterThan(25);
    expect(period).toBeLessThan(30);
    const actual = providers.moon.sample(end + period);
    const earth = providers.earth.sample(end + period);
    expect(
      distance(
        actual.position.map((v, i) => v - earth.position[i]),
        relativePosition,
      ),
    ).toBeLessThan(1e-9);
    expect(
      distance(
        actual.velocity.map((v, i) => v - earth.velocity[i]),
        relativeVelocity,
      ),
    ).toBeLessThan(1e-10);
  });

  it('stays finite over multiple distinct orbital periods and samples tail history outside the asset window', () => {
    const end = raw.earth.jd_tdb_range[1];
    for (const [name, periods] of [
      ['mercury', 12],
      ['earth', 4],
      ['jupiter', 2],
      ['halley', 2],
    ]) {
      const row = raw[name].states.at(-1);
      const period = orbitalPeriodDays(row.slice(1, 4), row.slice(4, 7), MU_SUN_AU3_DAY2);
      expect(finiteState(providers[name].sample(end + period * periods)), name).toBe(true);
    }
    for (let age = 0; age <= 100; age += 0.5) {
      expect(finiteState(providers.halley.sample(end + 30 - age)), `tail release age ${age}`).toBe(
        true,
      );
    }
  });
});
