import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadPrecisionEphemerides } from '../../src/components/solar/PrecisionEphemeris.js';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { RealTimeClock } from '../../src/components/solar/RealTimeClock.js';
import * as THREE from 'three';
import { vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { checkScience } from '../../scripts/solar-realtime-check.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/solarRealtimeReference.json', import.meta.url)),
);
export const localFetch = async (url) => {
  const bytes = readFileSync(new URL(`../../public${url}`, import.meta.url));
  return {
    ok: true,
    text: async () => bytes.toString(),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
};

describe('original-source precision consistency', () => {
  it('[PRODUCTION-LOAD] actual async production loader and display callbacks apply current epoch only after verification', async () => {
    const targets = Object.fromEntries(
      ['earth', 'moon', 'mars', 'halley'].map((name) => [name, new THREE.Object3D()]),
    );
    for (const target of Object.values(targets)) target.visible = false;
    const system = Object.assign(Object.create(SolarSystem.prototype), {
      realTimeClock: new RealTimeClock(),
      ephemerides: null,
      bodies: [],
      _epochRequestId: 0,
      _pendingEpoch: null,
      disposed: false,
      sun: new THREE.Object3D(),
      sunLight: new THREE.Object3D(),
      earth: targets.earth,
      halley: { tail: new THREE.Object3D(), flame: new THREE.Object3D() },
      ephemerisTargets: targets,
      ephemerisStatus: {
        status: 'initializing',
        error: null,
        lastAppliedJd: null,
        lastAppliedUtcMs: null,
        targets: Object.fromEntries(Object.keys(targets).map((name) => [name, {}])),
      },
      _initializeDustTail: vi.fn(),
    });
    vi.stubGlobal('fetch', localFetch);
    try {
      await system._loadEphemerides();
      expect(system.ephemerisStatus.status).not.toBe('ready');
      expect(Object.values(targets).every((target) => !target.visible)).toBe(true);
      system._advanceBodies(0);
      expect(system.ephemerisStatus.lastAppliedJd).toBe(null);
      await system.ephemerides.ensureEpoch(system.simulationTime);
      system._advanceBodies(0);
      expect(system.ephemerisStatus.status).toBe('ready');
      expect(system.ephemerisStatus.lastAppliedJd).toBe(system.simulationTime);
      expect(Math.abs(system.ephemerisStatus.lastAppliedUtcMs - Date.now())).toBeLessThan(250);
      const moon = system.ephemerisStatus.targets.moon.lastPhysicalPosition;
      expect(targets.moon.position.distanceTo(targets.earth.position)).toBeCloseTo(
        Math.hypot(...moon) * 1089.68,
        10,
      );
    } finally {
      system.ephemerides?.dispose();
      vi.unstubAllGlobals();
    }
  });
  it('[SCI-VECTORS] [MUT-FAIL-M8] public heliocentric and geocentric AU vectors match original CSPICE including valid perigee', async () => {
    const loaded = await loadPrecisionEphemerides(localFetch, undefined, {
      secureContext: false,
      cryptoImpl: undefined,
    });
    let maximum = 0;
    try {
      for (const row of fixture.timeAndVectors.filter((entry) => entry.vectors)) {
        await loaded.ensureEpoch(row.jdTdb);
        expect(loaded.isEpochReady(row.jdTdb)).toBe(true);
        for (const [name, wanted] of Object.entries(row.vectors)) {
          const sample = loaded.providers[name].sample(row.jdTdb);
          expect(sample.ok, `${name}: ${row.utc}`).toBe(true);
          const error = Math.hypot(...sample.position.map((value, axis) => value - wanted[axis]));
          maximum = Math.max(maximum, error);
          expect(error, `${name}: ${row.utc}`).toBeLessThanOrEqual(1e-10);
          expect(sample.metadata.center).toBe(name === 'moon' ? 399 : 10);
          expect(sample.metadata.targetKind).toBe(
            ['mercury', 'venus', 'earth', 'moon'].includes(name)
              ? 'body_center'
              : 'system_barycenter',
          );
          if (name === 'moon' && row.utc.startsWith('2026-12-24')) {
            expect(Math.hypot(...sample.position)).toBeLessThan(0.0024);
            expect(Math.hypot(...sample.position)).toBeGreaterThan(0.00238);
          }
        }
      }
      console.log(
        JSON.stringify({ originalCspiceMaxAu: maximum, diagnostics: loaded.getDiagnostics() }),
      );
      expect(loaded.getDiagnostics().peakConcurrentRequests).toBeLessThanOrEqual(4);
      expect(loaded.getDiagnostics().residentBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    } finally {
      loaded.dispose();
    }
  });
  it('[SCI-HALLEY] evaluates every untrained odd day against immutable original Horizons position and velocity', async () => {
    const report = await checkScience(
      fileURLToPath(new URL('../../public/', import.meta.url)),
      fixture,
    );
    expect(report.halleyComparisons).toBe(36525);
    expect(report.halleySelection.evenIndices).toBe(0);
    expect(report.halleySelection.uniqueIndices).toBe(36525);
    expect(report.overlapAudit).toHaveLength(4);
    expect(report.halleyPositionResidualKm.max).toBeLessThanOrEqual(10);
    expect(report.halleyMaxVelocityKmS).toBeLessThanOrEqual(0.001);
    expect(report.de440MaxAu).toBeLessThanOrEqual(1e-10);
    expect(report.utcTdbMaxDay).toBeLessThanOrEqual(1e-9);
    expect(report.pass, report.failures.join(', ')).toBe(true);
    console.log(
      JSON.stringify({
        oddDays: report.halleyComparisons,
        originalHorizonsResidualKm: report.halleyPositionResidualKm,
        originalHorizonsVelocityResidualKmS: report.halleyVelocityResidualKmS,
      }),
    );
  });
  it('fails closed outside coverage without wrap, P1 or two-body continuation', async () => {
    const loaded = await loadPrecisionEphemerides(localFetch);
    try {
      await expect(loaded.ensureEpoch(2500000)).rejects.toThrow('out_of_range');
      expect(loaded.providers.mars.sample(2500000).ok).toBe(false);
    } finally {
      loaded.dispose();
    }
  });
});
