import { describe, expect, it } from 'vitest';
import { R_S, R_YIELD } from '../../src/components/solar/SolarHitLayout.js';
import { continuityScan, killerScans, reverseScan } from '../helpers/solarHitScans.js';
import { recordMeasurement } from '../helpers/solarHitGeometry.js';

function expectHardClearance(rows) {
  for (const { anchor, seam, minClearance } of rows) {
    const context = `K1 hard clearance: anchor=${anchor}, seam=${seam}`;
    expect(minClearance, context).toBeGreaterThanOrEqual(R_S);
    expect(minClearance - R_S, `${context}, positive margin`).toBeGreaterThan(0);
  }
}

function expectKnownTargetShortfalls(rows) {
  // MAX_OFF_S caps the collinear 14.2 samples at 13; all other rows meet 13.5.
  const shortfalls = rows
    .filter(({ minClearance }) => minClearance < R_YIELD)
    .map(({ anchor, seam }) => ({ anchor, seam }));
  expect(shortfalls, 'K1 target shortfall count').toHaveLength(2);
  expect(shortfalls, 'K1 exact target shortfall set').toEqual([
    { anchor: 14.2, seam: 0 },
    { anchor: 14.2, seam: 180 },
  ]);
}

describe('scheme D continuous fields', () => {
  it('scans over 100000 samples with 0.001px Cartesian probe steps', () => {
    const r = continuityScan();
    recordMeasurement('continuity', r);
    expect(r.samples).toBeGreaterThanOrEqual(100000);
    expect(r.maxStep).toBeLessThanOrEqual(0.024);
  }, 120000);
  it('K1 revised seams and K2 fixed Earth crossing are continuous', () => {
    const r = killerScans();
    recordMeasurement('killers', r);
    expect(r.K1.maxStep).toBeLessThanOrEqual(0.024);
    expect(r.K2.maxStep).toBeLessThanOrEqual(0.024);
    expect(r.K2.crossing).toBeLessThanOrEqual(0.024);
    expect(r.K2.maxD0Step).toBeLessThanOrEqual(0.024);
    expect(r.K2.tAtZero).toBe(0);
    expect(r.K1.rows).toHaveLength(16);
    expectHardClearance(r.K1.rows);
    expectKnownTargetShortfalls(r.K1.rows);
  });
  it.each([11.9, R_S])('rejects K1 clearance %s without a positive hard margin', (clearance) => {
    const { rows } = killerScans().K1;
    rows.find(({ anchor, seam }) => anchor === 14.2 && seam === 0).minClearance = clearance;
    expect(() => expectHardClearance(rows)).toThrowError('K1 hard clearance');
  });
  it('rejects an additional K1 target shortfall even when the hard margin passes', () => {
    const { rows } = killerScans().K1;
    rows.find(({ anchor, seam }) => anchor === 16 && seam === 0).minClearance = 13;
    expectHardClearance(rows);
    expect(() => expectKnownTargetShortfalls(rows)).toThrowError('K1 target shortfall count');
  });
  it('rejects a changed K1 target shortfall set even when its count stays two', () => {
    const { rows } = killerScans().K1;
    rows.find(({ anchor, seam }) => anchor === 14.2 && seam === 0).minClearance = R_YIELD;
    rows.find(({ anchor, seam }) => anchor === 16 && seam === 0).minClearance = 13;
    expectHardClearance(rows);
    expect(() => expectKnownTargetShortfalls(rows)).toThrowError('K1 exact target shortfall set');
  });
  it('has bit-identical outputs under time reversal', () => {
    const r = reverseScan();
    recordMeasurement('reversal', r);
    expect(r.maxDeviation).toBe(0);
  });
});
