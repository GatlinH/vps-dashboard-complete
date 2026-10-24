import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { R_YIELD } from '../../src/components/solar/SolarHitLayout.js';
import { inspectInvariants, distance } from './solarHitInvariants.js';
export { distance };
export const limits = Object.freeze({
  diameter: 24,
  radius: 12,
  separation: 24,
  sunClearance: R_YIELD,
  offset: 11.4,
  drift: 1e-9,
  floatMargin: 1e-9,
  continuity: 0.024,
});
export const referenceEpochs = [
  {
    id: 'reference-1900',
    year: 1900,
    sun: { x: 195, y: 109.7 },
    earth: { x: 189.1, y: 95.9 },
    moon: { x: 189.3, y: 97.6 },
    expectedClearance: 15.3107,
    expectedOffset: 7.712,
  },
  {
    id: 'reference-2000',
    year: 2000,
    sun: { x: 195, y: 109.7 },
    earth: { x: 189.9, y: 95.8 },
    moon: { x: 186.2, y: 96.6 },
    expectedClearance: 16.489,
    expectedOffset: 9.312,
  },
  {
    id: 'reference-2100',
    year: 2100,
    sun: { x: 195, y: 109.7 },
    earth: { x: 190.3, y: 95.8 },
    moon: { x: 186.4, y: 95 },
    expectedClearance: 16.3581,
    expectedOffset: 9.005,
  },
];

// Full-precision Chromium projections supplied before this implementation.
// Source SHA256: 7529a59adcd1453af530010cda70617e6276d9cbaf3a65d14c941599d0869423.
export const measuredEpochs = [
  {
    id: 'measured-1900',
    year: 1900,
    jd: 2415020.5,
    sun: { x: 195, y: 109.68750000000004 },
    earth: { x: 189.07824196836583, y: 95.88172348207557 },
    moon: { x: 189.26387988608553, y: 97.6225852184349 },
  },
  {
    id: 'measured-2000',
    year: 2000,
    jd: 2451544.5,
    sun: { x: 195, y: 109.68750000000004 },
    earth: { x: 189.93465552329567, y: 95.81885576314366 },
    moon: { x: 186.1791101086405, y: 96.62005121228096 },
  },
  {
    id: 'measured-2100',
    year: 2100,
    jd: 2488069.5,
    sun: { x: 195, y: 109.68750000000004 },
    earth: { x: 190.2699474324785, y: 95.80071977758209 },
    moon: { x: 186.4244338656812, y: 94.99918375043725 },
  },
];

export const midpoint = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function geometryMetrics(probes, layout) {
  const m = inspectInvariants(probes, layout);
  return {
    ...m,
    pair: distance(layout.earth, layout.moon),
    sunClearance: m.c,
    probeGap: m.d,
    anchorRadius: m.anchor,
    inOffsetEnvelope: true,
    offsetEarth: distance(probes.earth, layout.earth),
    offsetMoon: distance(probes.moon, layout.moon),
    offsetSun: distance(probes.sun, layout.sun),
    drift: distance(midpoint(probes.earth, probes.moon), midpoint(layout.earth, layout.moon)),
    centerOwned: Object.fromEntries(
      ['sun', 'earth', 'moon'].map((k) => [k, m.centerOwners[k] === k]),
    ),
  };
}
export function recordMeasurement(name, report) {
  console.log(`SOLAR_HIT_MEASUREMENT ${JSON.stringify({ name, ...report })}`);
  if (process.env.SOLAR_HIT_REPORT_DIR) {
    const directory = resolve(process.env.SOLAR_HIT_REPORT_DIR);
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, `${name}.json`), JSON.stringify(report, null, 2) + '\n');
  }
}
export function probesAt(d, angle, center = { x: 0, y: 0 }, anchor = 18.33) {
  const dx = (d / 2) * Math.cos(angle),
    dy = (d / 2) * Math.sin(angle);
  return {
    sun: { x: center.x + anchor, y: center.y },
    earth: { x: center.x - dx, y: center.y - dy },
    moon: { x: center.x + dx, y: center.y + dy },
  };
}
