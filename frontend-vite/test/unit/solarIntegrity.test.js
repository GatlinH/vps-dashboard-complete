import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createPrecisionAssetStore } from '../../src/components/solar/PrecisionAssetStore.js';
import { validateScienceResult } from '../../scripts/solar-realtime-check.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(
  readFileSync(new URL('../../public/assets/solar/de440-1900-2100/manifest.json', import.meta.url)),
);
const name = `000-${manifest.segments.mercury.sha256[0].slice(0, 16)}.f64`;
const original = readFileSync(
  new URL(`../../public/assets/solar/de440-1900-2100/mercury/${name}`, import.meta.url),
);
const arrayBuffer = (bytes) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

describe('ordinary HTTP actual payload integrity', () => {
  it('bounds real concurrent verified loads to four, 128 KiB files and a 2 MiB LRU', async () => {
    const bytes = new Uint8Array(65536);
    const store = createPrecisionAssetStore(
      async () => ({ ok: true, arrayBuffer: async () => bytes.slice().buffer }),
      { secureContext: false, cryptoImpl: null },
    );
    try {
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          store.load(
            String(index),
            `/${index}`,
            digest(bytes),
            bytes.length,
            (buffer) => new Uint8Array(buffer),
          ),
        ),
      );
      const diagnostics = store.getDiagnostics();
      expect(diagnostics.peakConcurrentRequests).toBe(4);
      expect(diagnostics.residentBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(diagnostics.cachedBlocks).toBe(32);
      expect(store.has('0')).toBe(false);
      expect(store.has('39')).toBe(true);
    } finally {
      store.dispose();
    }
    const oversized = new Uint8Array(128 * 1024 + 1);
    const largeStore = createPrecisionAssetStore(
      async () => ({ ok: true, arrayBuffer: async () => oversized.buffer }),
      { secureContext: false },
    );
    try {
      await expect(
        largeStore.load('big', '/big', digest(oversized), oversized.length, () => true),
      ).rejects.toThrow('byte budget');
    } finally {
      largeStore.dispose();
    }
  });
  it('[MUT-FAIL-M9] independently hashes actual bytes without WebCrypto on insecure HTTP', async () => {
    const subtle = {
      digest: vi.fn(() => {
        throw new Error('must not use HTTP WebCrypto');
      }),
    };
    const store = createPrecisionAssetStore(
      async () => ({ ok: true, arrayBuffer: async () => arrayBuffer(original) }),
      { secureContext: false, cryptoImpl: { subtle } },
    );
    try {
      await expect(
        store.load(
          'good',
          '/good',
          digest(original),
          original.length,
          (buffer) => new Float64Array(buffer),
        ),
      ).resolves.toBeInstanceOf(Float64Array);
      await expect(
        store.load('fake', '/fake', '0'.repeat(64), original.length, () => true),
      ).rejects.toThrow('EPHEMERIS_INTEGRITY_MISMATCH');
      expect(subtle.digest).not.toHaveBeenCalled();
    } finally {
      store.dispose();
    }
  });
  it('[MUT-FAIL-M6] same-length finite coefficients with valid structure reject before decode/cache', async () => {
    const damaged = Buffer.from(original);
    damaged[0] ^= 1;
    expect(damaged.length).toBe(original.length);
    for (let offset = 0; offset < damaged.length; offset += 8)
      expect(Number.isFinite(damaged.readDoubleLE(offset))).toBe(true);
    expect(digest(damaged)).not.toBe(digest(original));
    const decode = vi.fn((buffer) => new Float64Array(buffer));
    expect(decode(arrayBuffer(damaged)).every(Number.isFinite)).toBe(true);
    decode.mockClear();
    const store = createPrecisionAssetStore(
      async () => ({ ok: true, arrayBuffer: async () => arrayBuffer(damaged) }),
      { secureContext: false, cryptoImpl: null },
    );
    try {
      await expect(
        store.load('damaged', '/damaged', digest(original), original.length, decode),
      ).rejects.toThrow('EPHEMERIS_INTEGRITY_MISMATCH');
      expect(decode).not.toHaveBeenCalled();
      expect(store.has('damaged')).toBe(false);
      await expect(
        store.load('valid-damaged', '/damaged', digest(damaged), original.length, decode),
      ).resolves.toBeInstanceOf(Float64Array);
    } finally {
      store.dispose();
    }
  });
  it('secure WebCrypto verifies hash, length and finite bytes rather than an expected digest echo', async () => {
    const store = createPrecisionAssetStore(
      async () => ({ ok: true, arrayBuffer: async () => arrayBuffer(original) }),
      { secureContext: true, cryptoImpl: webcrypto },
    );
    try {
      await expect(
        store.load('short', '/short', digest(original), original.length - 1, () => true),
      ).rejects.toThrow('length mismatch');
      await expect(
        store.load('good', '/good', digest(original), original.length, () => true),
      ).resolves.toBe(true);
    } finally {
      store.dispose();
    }
  });
});

describe('scientific verification contract', () => {
  it('[SCI-REFERENCE-BUDGET] actual CLI separates native DE440 arithmetic from compact Halley reference residual', () => {
    const directory = mkdtempSync(join(tmpdir(), 'solar-science-policy-'));
    const cwd = resolve(fileURLToPath(new URL('../../', import.meta.url)));
    try {
      const run = spawnSync(
        process.execPath,
        [
          'scripts/solar-realtime-check.mjs',
          '--public-root',
          'public',
          '--output',
          join(directory, 'result.json'),
        ],
        { cwd, encoding: 'utf8' },
      );
      const report = JSON.parse(run.stdout);
      expect(report.utcTdbMaxDay).toBeLessThanOrEqual(1e-9);
      expect(report.de440MaxAu).toBeLessThanOrEqual(1e-10);
      expect(report.halleyMaxAu * 149597870.7).toBeLessThanOrEqual(10);
      expect(run.status, run.stderr || run.stdout).toBe(0);
      expect(report.pass).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

// Synthetic normalized policy records; real CLI/corpus checks supply astronomical evidence.
function policyRecord() {
  const fixture = JSON.parse(
    readFileSync(new URL('./fixtures/solarRealtimeReference.json', import.meta.url)),
  );
  return {
    utcTdbMaxDay: 0,
    de440MaxAu: 0,
    halleyMaxAu: 0,
    halleyMaxVelocityKmS: 0,
    timeRows: 739,
    vectorComparisons: 180,
    halleyComparisons: 36525,
    originalSources: fixture.sources,
    originalHalleyArchives: fixture.halleyArchives,
    bodyCounts: Object.fromEntries(
      ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'moon'].map(
        (name) => [name, 20],
      ),
    ),
    halleySelection: {
      rawRows: 73055,
      uniqueRows: 73051,
      count: 36525,
      uniqueIndices: 36525,
      evenIndices: 0,
      minIndex: 1,
      maxIndex: 73049,
      firstJd: 2415021.5,
      lastJd: 2488069.5,
    },
    overlapAudit: [2429629.5, 2444239.5, 2458849.5, 2473459.5].map((jdTdb) => ({ jdTdb })),
    referenceEpochInCoverage: true,
  };
}

describe('science validator refuses incomplete or mislabelled evidence', () => {
  it('[SCI-GUARD-VALID] accepts an otherwise complete policy record', () => {
    expect(validateScienceResult(policyRecord())).toEqual([]);
  });
  it('[SCI-GUARD-EMPTY] refuses zero measured samples', () => {
    const r = policyRecord();
    r.halleyComparisons = 0;
    r.halleySelection.count = 0;
    expect(validateScienceResult(r)).toContain('SCI_EMPTY_EVIDENCE');
  });
  it('[SCI-GUARD-SHORT] refuses a truncated odd-day corpus', () => {
    const r = policyRecord();
    r.halleyComparisons -= 1;
    r.halleySelection.count -= 1;
    r.halleySelection.uniqueIndices -= 1;
    expect(validateScienceResult(r)).toContain('SCI_HALLEY_CARDINALITY');
  });
  it('[SCI-GUARD-PARITY] refuses training-day contamination', () => {
    const r = policyRecord();
    r.halleySelection.evenIndices = 1;
    expect(validateScienceResult(r)).toContain('SCI_HALLEY_TRAINING_CONTAMINATION');
  });
  it('[SCI-GUARD-SOURCE] refuses a different BSP source identity', () => {
    const r = policyRecord();
    r.originalSources.bsp = '0'.repeat(64);
    expect(validateScienceResult(r)).toContain('SCI_ORIGINAL_SOURCE_IDENTITY');
  });
  it('[SCI-GUARD-ARCHIVE] refuses a different original Horizons archive', () => {
    const r = policyRecord();
    r.originalHalleyArchives[0].sha256 = '0'.repeat(64);
    expect(validateScienceResult(r)).toContain('SCI_ORIGINAL_ARCHIVE_IDENTITY');
  });
  it('[SCI-GUARD-COVERAGE] refuses a shortened reference coverage', () => {
    const r = policyRecord();
    r.halleySelection.firstJd += 2;
    expect(validateScienceResult(r)).toContain('SCI_HALLEY_COVERAGE');
  });
  it('[SCI-GUARD-BODY] refuses an empty intended planet target', () => {
    const r = policyRecord();
    r.bodyCounts.neptune = 0;
    expect(validateScienceResult(r)).toContain('SCI_TARGET_COMPLETENESS');
  });
  it('[SCI-GUARD-NAN] refuses non-finite numeric evidence', () => {
    const r = policyRecord();
    r.de440MaxAu = Number.NaN;
    expect(validateScienceResult(r)).toContain('SCI_NONFINITE_EVIDENCE');
  });
  it('[SCI-GUARD-NATIVE] retains the strict native DE440 bound', () => {
    const r = policyRecord();
    r.de440MaxAu = 1.1e-10;
    expect(validateScienceResult(r)).toContain('SCI_DE440_RESIDUAL');
  });
  it('[SCI-GUARD-HALLEY-POS] rejects excessive compact position residual', () => {
    const r = policyRecord();
    r.halleyMaxAu = 10.01 / 149597870.7;
    expect(validateScienceResult(r)).toContain('SCI_HALLEY_POSITION_RESIDUAL');
  });
  it('[SCI-GUARD-HALLEY-VEL] rejects excessive compact velocity residual', () => {
    const r = policyRecord();
    r.halleyMaxVelocityKmS = 0.0011;
    expect(validateScienceResult(r)).toContain('SCI_HALLEY_VELOCITY_RESIDUAL');
  });
  it('[SCI-GUARD-OVERLAP] refuses loss of the original conflict audit', () => {
    const r = policyRecord();
    r.overlapAudit = [];
    expect(validateScienceResult(r)).toContain('SCI_OVERLAP_AUDIT_REQUIRED');
  });
});
