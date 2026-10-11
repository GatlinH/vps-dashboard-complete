import { solveSolarHitLayout } from '../../src/components/solar/SolarHitLayout.js';
import { distance } from './solarHitInvariants.js';
export const solve = (p) => solveSolarHitLayout(p.sun, p.earth, p.moon);
export function at(anchor, d, phi, rotation = 0) {
  const p = {
    sun: { x: anchor, y: 0 },
    earth: { x: (-d / 2) * Math.cos(phi), y: (-d / 2) * Math.sin(phi) },
    moon: { x: (d / 2) * Math.cos(phi), y: (d / 2) * Math.sin(phi) },
  };
  if (rotation)
    for (const k of ['sun', 'earth', 'moon']) {
      const { x, y } = p[k];
      p[k] = {
        x: x * Math.cos(rotation) - y * Math.sin(rotation),
        y: x * Math.sin(rotation) + y * Math.cos(rotation),
      };
    }
  return p;
}
const step = (a, b) => Math.max(...['sun', 'earth', 'moon'].map((k) => distance(a[k], b[k])));
export function continuityScan(solver = solve, full = true) {
  const anchors = [10.565, 11.9, 13.2, 14.2, 16.5, 18.33, 22.56, 27.31, 53.47, 78.99, 105];
  const gaps = [0, ...Array.from({ length: 19 }, (_, i) => 10 ** (-9 + i / 2))];
  for (let d = 0; d <= 30; d += 0.25) gaps.push(d);
  for (const seam of [1.574, 1.6, 24.4]) for (let i = -10; i <= 10; i++) gaps.push(seam + i * 1e-4);
  let samples = 0,
    maxStep = 0,
    worst;
  for (const anchor of anchors)
    for (const d of gaps)
      for (let deg = 0; deg < 360; deg += full ? 0.25 : 15) {
        const p = at(anchor, d, (deg * Math.PI) / 180),
          l = solver(p);
        for (const axis of ['x', 'y']) {
          const next = { ...p, moon: { ...p.moon, [axis]: p.moon[axis] + 0.001 } };
          const delta = step(l, solver(next));
          samples++;
          if (delta > maxStep) {
            maxStep = delta;
            worst = { anchor, d, deg, axis };
          }
        }
      }
  return {
    samples,
    h: 0.001,
    maxStep,
    limit: 0.024,
    worst,
    gapCount: gaps.length,
    angleStep: full ? 0.25 : 15,
    anchors,
  };
}
export function killerScans(solver = solve) {
  const rows = [];
  for (const anchor of [14.2, 16, 18.33, 22.56])
    for (const seam of [0, 90, 180, 270]) {
      let previous,
        maxStep = 0,
        minClearance = Infinity;
      for (let i = -1000; i <= 1000; i++) {
        const p = at(anchor, 2.14, ((seam + i * 0.01) * Math.PI) / 180),
          l = solver(p);
        if (previous) maxStep = Math.max(maxStep, step(previous, l));
        minClearance = Math.min(minClearance, distance(l.sun, l.earth), distance(l.sun, l.moon));
        previous = l;
      }
      rows.push({ anchor, seam, maxStep, minClearance, samples: 2001, stepDegrees: 0.01 });
    }
  // P_E is fixed. P_M crosses it on a straight line, with r reversing at zero.
  let previous,
    maxStep = 0,
    zero;
  for (let i = -3000; i <= 3000; i++) {
    const p = { sun: { x: 18.33, y: 0 }, earth: { x: 0, y: 0 }, moon: { x: i * 0.001, y: 0 } },
      l = solver(p);
    if (previous) maxStep = Math.max(maxStep, step(previous, l));
    if (i === 0) zero = l.t;
    previous = l;
  }
  // Offset the grid by h/2 to measure the two sides without landing on r=0.
  let crossing = 0;
  for (const angle of [0, Math.PI / 2, Math.PI]) {
    const p = at(18.33, -0.001 / 2, angle),
      q = at(18.33, 0.001 / 2, angle);
    crossing = Math.max(crossing, step(solver(p), solver(q)));
  }
  const d0 = [];
  for (const angle of [0, Math.PI]) {
    const p = at(18.33, 1.6 - 0.0005, angle),
      q = at(18.33, 1.6 + 0.0005, angle);
    d0.push(step(solver(p), solver(q)));
  }
  return {
    K1: { rows, maxStep: Math.max(...rows.map((r) => r.maxStep)) },
    K2: { maxStep, tAtZero: zero, crossing, d0, maxD0Step: Math.max(...d0) },
  };
}
export function reverseScan(solver = solve) {
  const sequence = Array.from({ length: 601 }, (_, i) =>
    at(11.9 + i * 0.015, 1.2 + 3 * Math.sin(i * 0.02) ** 2, i * 0.017),
  );
  const forward = sequence.map(solver),
    backward = sequence.slice().reverse().map(solver).reverse();
  return {
    samples: sequence.length,
    maxDeviation: Math.max(...forward.map((x, i) => step(x, backward[i]))),
  };
}
