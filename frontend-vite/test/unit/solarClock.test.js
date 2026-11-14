import { describe, expect, it } from 'vitest';
import { RealTimeClock, utcToTdb } from '../../src/components/solar/RealTimeClock.js';
import { readFileSync } from 'node:fs';

describe('wall and monotonic clock contracts', () => {
  it('[MUT-FAIL-M1] defaults to 1x and tracks absolute wall clock after missing frames', () => {
    let wall = Date.now();
    let perf = 0;
    const clock = new RealTimeClock({ wallNow: () => wall, monotonicNow: () => perf });
    expect(clock.rate).toBe(1);
    wall += 3600000;
    perf += 50;
    expect(clock.sample().utcMs).toBe(wall);
  });
  it('[MUT-FAIL-M2] non-1x switches reanchor the current simulation epoch', () => {
    let perf = 0;
    const clock = new RealTimeClock({ wallNow: () => Date.now(), monotonicNow: () => perf });
    clock.setRate(60);
    perf = 5678.25;
    const before = clock.sample().utcMs;
    clock.setRate(3600);
    expect(clock.sample().utcMs).toBe(before);
    perf += 123.5;
    expect(clock.sample().utcMs - before).toBe(123.5 * 3600);
  });
  it('[MUT-FAIL-M3] 1x and Now return directly to current wall clock', () => {
    let wall = Date.now();
    let perf = 0;
    const clock = new RealTimeClock({ wallNow: () => wall, monotonicNow: () => perf });
    clock.setRate(86400);
    perf += 9000;
    wall += 9000;
    expect(clock.sample().utcMs).not.toBe(wall);
    expect(clock.setRate(1).utcMs).toBe(wall);
    expect(clock.sample().mode).toBe('realtime');
  });
  it('uses measured monotonic elapsed time, not an assumed sleep duration', async () => {
    const clock = new RealTimeClock();
    clock.setRate(60);
    const start = performance.now();
    const before = clock.sample().utcMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    const end = performance.now();
    const after = clock.sample().utcMs;
    expect(Math.abs(after - before - (end - start) * 60)).toBeLessThanOrEqual(1);
  });
  it('[SCI-TDB] matches original CSPICE/LSK on 731 daily epochs, boundaries and actual generation wall clock', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('./fixtures/solarRealtimeReference.json', import.meta.url)),
    );
    let maximum = 0;
    for (const row of fixture.timeAndVectors)
      maximum = Math.max(maximum, Math.abs(utcToTdb(row.utcMs) - row.jdTdb));
    console.log(JSON.stringify({ utcTdbMaxDay: maximum, rows: fixture.timeAndVectors.length }));
    expect(maximum).toBeLessThanOrEqual(1e-9);
  });
});
