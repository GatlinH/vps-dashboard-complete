import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPrecisionEphemerides } from '../src/components/solar/PrecisionEphemeris.js';
import { utcToTdb } from '../src/components/solar/RealTimeClock.js';

export const SCIENCE_BUDGET = Object.freeze({
  day: 1e-9,
  de440Au: 1e-10,
  halleyPositionKm: 10,
  halleyVelocityKmS: 0.001,
  auKm: 149597870.7,
});
const SOURCE_PINS = Object.freeze({
  bsp: 'c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2',
  lsk: '678e32bdb5a744117a467cd9601cd6b373f0e9bc9bbde1371d5eee39600a039b',
});
export const HALLEY_PINS = Object.freeze([
  '15cd88c478ecf74094dee62bc3ada8bb49d36f7a4372b1ac895f1106a1e8188a',
  '4f3da79bc5d8ae599025eb45c958ea8b40912f088b0a359e87498a294f81f883',
  '30248bcfb54fbb4f7bcc1463f7e41a15577806aaaba0732cb0712c42c0ae1c8c',
  'fa2ba7251351a47aabdb9908d7b76177fdb3129ec0aab871596124953c1a1795',
  'a95b73252c811cc298663e59cd79886af95f5b7486d1f38e5922c4f02ad93ae9',
]);
const TARGETS = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'moon',
];
const OVERLAP_JDS = [2429629.5, 2444239.5, 2458849.5, 2473459.5];
const DEFAULT_ARCHIVES = fileURLToPath(
  new URL('../test/unit/fixtures/halley-original/', import.meta.url),
);

export function validateScienceResult(result) {
  const failures = [];
  const add = (condition, code) => {
    if (condition) failures.push(code);
  };
  const numeric = ['utcTdbMaxDay', 'de440MaxAu', 'halleyMaxAu', 'halleyMaxVelocityKmS'];
  add(
    numeric.some((key) => !Number.isFinite(result[key]) || result[key] < 0),
    'SCI_NONFINITE_EVIDENCE',
  );
  add(
    ['timeRows', 'vectorComparisons', 'halleyComparisons'].some(
      (key) => !Number.isInteger(result[key]) || result[key] <= 0,
    ),
    'SCI_EMPTY_EVIDENCE',
  );
  add(
    result.timeRows !== 739 ||
      result.vectorComparisons !== 180 ||
      TARGETS.some((name) => result.bodyCounts?.[name] !== 20),
    'SCI_TARGET_COMPLETENESS',
  );
  const s = result.halleySelection;
  add(
    !s ||
      result.halleyComparisons !== 36525 ||
      s.count !== 36525 ||
      s.uniqueIndices !== 36525 ||
      s.rawRows !== 73055 ||
      s.uniqueRows !== 73051,
    'SCI_HALLEY_CARDINALITY',
  );
  add(!s || s.evenIndices !== 0, 'SCI_HALLEY_TRAINING_CONTAMINATION');
  add(
    !s ||
      s.minIndex !== 1 ||
      s.maxIndex !== 73049 ||
      s.firstJd !== 2415021.5 ||
      s.lastJd !== 2488069.5 ||
      result.referenceEpochInCoverage !== true,
    'SCI_HALLEY_COVERAGE',
  );
  add(
    Object.entries(SOURCE_PINS).some(([name, hash]) => result.originalSources?.[name] !== hash),
    'SCI_ORIGINAL_SOURCE_IDENTITY',
  );
  const archives = result.originalHalleyArchives;
  add(
    !Array.isArray(archives) ||
      archives.length !== 5 ||
      HALLEY_PINS.some(
        (hash, i) => archives[i]?.sha256 !== hash || archives[i]?.path !== `halley-${i}.txt.gz`,
      ),
    'SCI_ORIGINAL_ARCHIVE_IDENTITY',
  );
  add(
    !Array.isArray(result.overlapAudit) ||
      result.overlapAudit.length !== 4 ||
      OVERLAP_JDS.some((jd, i) => result.overlapAudit[i]?.jdTdb !== jd),
    'SCI_OVERLAP_AUDIT_REQUIRED',
  );
  add(result.utcTdbMaxDay > SCIENCE_BUDGET.day, 'SCI_TIME_RESIDUAL');
  add(result.de440MaxAu > SCIENCE_BUDGET.de440Au, 'SCI_DE440_RESIDUAL');
  add(
    result.halleyMaxAu * SCIENCE_BUDGET.auKm > SCIENCE_BUDGET.halleyPositionKm,
    'SCI_HALLEY_POSITION_RESIDUAL',
  );
  add(
    result.halleyMaxVelocityKmS > SCIENCE_BUDGET.halleyVelocityKmS,
    'SCI_HALLEY_VELOCITY_RESIDUAL',
  );
  return failures;
}

export function readOriginalHalley(archiveDirectory = DEFAULT_ARCHIVES) {
  const files = readdirSync(archiveDirectory)
    .filter((name) => /^halley-.*\.txt\.gz$/.test(name))
    .sort();
  assert.deepEqual(
    files,
    HALLEY_PINS.map((_, i) => `halley-${i}.txt.gz`),
    'SCI_ORIGINAL_ARCHIVE_SET',
  );
  const byJd = new Map();
  const archives = [];
  const overlapAudit = [];
  let rawRows = 0;
  const pattern =
    /([0-9]+\.[0-9]+) =[^\n]*\n\s*X\s*=\s*([-+0-9.E]+)\s+Y\s*=\s*([-+0-9.E]+)\s+Z\s*=\s*([-+0-9.E]+)\s*\n\s*VX\s*=\s*([-+0-9.E]+)\s+VY\s*=\s*([-+0-9.E]+)\s+VZ\s*=\s*([-+0-9.E]+)/g;
  for (let index = 0; index < files.length; index += 1) {
    const bytes = readFileSync(join(archiveDirectory, files[index]));
    const hash = createHash('sha256').update(bytes).digest('hex');
    assert.equal(hash, HALLEY_PINS[index], 'SCI_ORIGINAL_ARCHIVE_HASH');
    const text = gunzipSync(bytes).toString('utf8');
    for (const clause of [
      '{source: JPL#75}',
      '{source: DE441}',
      '{source: SB441-N16}',
      'Ecliptic of J2000.0',
      'GEOMETRIC cartesian states',
      'AU-D',
      ' TDB',
    ])
      assert.ok(text.includes(clause), `SCI_ORIGINAL_CONVENTION ${clause}`);
    const body = text.split('$$SOE')[1]?.split('$$EOE')[0];
    assert.ok(body, 'SCI_ORIGINAL_BODY_REQUIRED');
    let count = 0;
    for (const match of body.matchAll(pattern)) {
      const row = {
        jdTdb: Number(match[1]),
        position: match.slice(2, 5).map(Number),
        velocity: match.slice(5, 8).map(Number),
        archive: index,
      };
      assert.ok(
        [row.jdTdb, ...row.position, ...row.velocity].every(Number.isFinite),
        'SCI_ORIGINAL_FINITE',
      );
      const previous = byJd.get(row.jdTdb);
      if (previous)
        overlapAudit.push({
          jdTdb: row.jdTdb,
          archives: [previous.archive, index],
          originalPositions: [previous.position, row.position],
          positionDifferenceAu: Math.hypot(...row.position.map((v, k) => v - previous.position[k])),
          policy: 'retain later original row; no averaging or source edit',
        });
      byJd.set(row.jdTdb, row);
      rawRows += 1;
      count += 1;
    }
    assert.ok(count > 0, 'SCI_ORIGINAL_ROWS_REQUIRED');
    archives.push({ path: files[index], sha256: hash, bytes: bytes.length, rows: count });
  }
  const rows = [...byJd.values()].sort((a, b) => a.jdTdb - b.jdTdb);
  assert.equal(rawRows, 73055, 'SCI_ORIGINAL_RAW_CARDINALITY');
  assert.equal(rows.length, 73051, 'SCI_ORIGINAL_UNIQUE_CARDINALITY');
  assert.equal(rows[0].jdTdb, 2415020.5, 'SCI_ORIGINAL_START');
  assert.equal(rows.at(-1).jdTdb, 2488070.5, 'SCI_ORIGINAL_END');
  assert.ok(
    rows.every((row, i) => i === 0 || row.jdTdb - rows[i - 1].jdTdb === 1),
    'SCI_ORIGINAL_DAILY_GRID',
  );
  const oddRows = rows
    .filter((_, i) => i % 2 === 1)
    .map((row) => ({ ...row, globalIndex: row.jdTdb - rows[0].jdTdb }));
  assert.equal(oddRows.length, 36525, 'SCI_ORIGINAL_HELDOUT_CARDINALITY');
  return { rows, oddRows, archives, overlapAudit, rawRows };
}

export async function checkScience(root, fixture, options = {}) {
  assert.ok(
    Array.isArray(fixture.timeAndVectors) && fixture.timeAndVectors.length === 739,
    'SCI_REFERENCE_TIME_CARDINALITY',
  );
  assert.ok(
    Object.entries(SOURCE_PINS).every(([name, hash]) => fixture.sources?.[name] === hash),
    'SCI_REFERENCE_SOURCE_IDENTITY',
  );
  const original = readOriginalHalley(options.archiveDirectory);
  const reference = fixture.halleyValidation;
  assert.ok(
    reference &&
      reference.mode === 'all-original-untrained-odd-days' &&
      reference.oddCount === 36525 &&
      reference.rawRows === 73055 &&
      reference.uniqueRows === 73051,
    'SCI_REFERENCE_ALL_ODD_CONTRACT',
  );
  const fetchLocal = async (url) => {
    const bytes = readFileSync(join(root, url));
    return {
      ok: true,
      text: async () => bytes.toString(),
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  const result = {
    executedUtc: new Date().toISOString(),
    generatedReferenceUtc: fixture.generatedUtc,
    originalSources: fixture.sources,
    originalHalleyArchives: original.archives,
    toleranceDay: SCIENCE_BUDGET.day,
    toleranceAu: SCIENCE_BUDGET.de440Au,
    halleyPositionToleranceKm: SCIENCE_BUDGET.halleyPositionKm,
    halleyVelocityToleranceKmS: SCIENCE_BUDGET.halleyVelocityKmS,
    errorBasis:
      'native numerical consistency / compact representation-vs-Horizons; not observational accuracy',
    utcTdbMaxDay: 0,
    de440MaxAu: 0,
    halleyMaxAu: 0,
    halleyMaxVelocityKmS: 0,
    timeRows: 0,
    vectorComparisons: 0,
    halleyComparisons: 0,
    bodyCounts: Object.fromEntries(TARGETS.map((name) => [name, 0])),
    perBodyMaxAu: Object.fromEntries(TARGETS.map((name) => [name, 0])),
    overlapAudit: original.overlapAudit,
    witnesses: [],
  };
  const loaded = await loadPrecisionEphemerides(fetchLocal, undefined, {
    secureContext: false,
    cryptoImpl: null,
  });
  const positionErrors = [];
  const velocityErrors = [];
  try {
    const first = fixture.timeAndVectors[0];
    result.referenceEpochInCoverage =
      Number.isFinite(first.jdTdb) &&
      first.jdTdb >= loaded.providers.halley.range[0] &&
      first.jdTdb <= loaded.providers.halley.range[1];
    for (const row of fixture.timeAndVectors) {
      assert.ok(
        Number.isFinite(row.utcMs) && Number.isFinite(row.jdTdb),
        'SCI_REFERENCE_TIME_FINITE',
      );
      result.timeRows += 1;
      result.utcTdbMaxDay = Math.max(
        result.utcTdbMaxDay,
        Math.abs(utcToTdb(row.utcMs) - row.jdTdb),
      );
      if (!row.vectors) continue;
      assert.deepEqual(
        Object.keys(row.vectors).sort(),
        [...TARGETS].sort(),
        'SCI_REFERENCE_TARGET_SET',
      );
      await loaded.ensureEpoch(row.jdTdb);
      for (const name of TARGETS) {
        const wanted = row.vectors[name];
        assert.ok(
          wanted.length === 3 && wanted.every(Number.isFinite),
          'SCI_REFERENCE_VECTOR_FINITE',
        );
        const sample = loaded.providers[name].sample(row.jdTdb);
        assert.ok(sample.ok, `SCI_TARGET_UNREADY ${name}`);
        const error = Math.hypot(...sample.position.map((value, axis) => value - wanted[axis]));
        result.vectorComparisons += 1;
        result.bodyCounts[name] += 1;
        result.perBodyMaxAu[name] = Math.max(result.perBodyMaxAu[name], error);
        result.de440MaxAu = Math.max(result.de440MaxAu, error);
      }
    }
    for (const row of original.oddRows) {
      await loaded.providers.halley.ensure(row.jdTdb);
      const sample = loaded.providers.halley.sample(row.jdTdb);
      assert.ok(
        sample.ok &&
          sample.position.every(Number.isFinite) &&
          sample.velocity.every(Number.isFinite),
        'SCI_HALLEY_UNREADY_OR_NONFINITE',
      );
      const positionAu = Math.hypot(
        ...sample.position.map((value, axis) => value - row.position[axis]),
      );
      const velocityKmS =
        (Math.hypot(...sample.velocity.map((value, axis) => value - row.velocity[axis])) *
          SCIENCE_BUDGET.auKm) /
        86400;
      result.halleyComparisons += 1;
      result.halleyMaxAu = Math.max(result.halleyMaxAu, positionAu);
      result.halleyMaxVelocityKmS = Math.max(result.halleyMaxVelocityKmS, velocityKmS);
      positionErrors.push(positionAu * SCIENCE_BUDGET.auKm);
      velocityErrors.push(velocityKmS);
      if (!result.worstHalley || positionAu > result.worstHalley.errorAu)
        result.worstHalley = {
          jdTdb: row.jdTdb,
          globalIndex: row.globalIndex,
          errorAu: positionAu,
          actual: sample.position,
          originalHorizons: row.position,
        };
    }
    const indices = original.oddRows.map((row) => row.globalIndex);
    result.halleySelection = {
      rawRows: original.rawRows,
      uniqueRows: original.rows.length,
      count: indices.length,
      uniqueIndices: new Set(indices).size,
      evenIndices: indices.filter((index) => index % 2 === 0).length,
      minIndex: indices[0],
      maxIndex: indices.at(-1),
      firstJd: original.oddRows[0].jdTdb,
      lastJd: original.oddRows.at(-1).jdTdb,
    };
    result.diagnostics = loaded.getDiagnostics();
  } finally {
    loaded.dispose();
  }
  const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      min: sorted[0],
      max: sorted.at(-1),
      mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  };
  result.halleyPositionResidualKm = summary(positionErrors);
  result.halleyVelocityResidualKmS = summary(velocityErrors);
  result.failures = validateScienceResult(result);
  result.pass = result.failures.length === 0;
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = {};
  assert.ok(
    args.length > 0 && args.length % 2 === 0,
    'Usage: --public-root <root> --output <json> [--fixture <json>] [--archives <directory>]',
  );
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      ['--public-root', '--output', '--fixture', '--archives'].includes(args[i]) && !flags[args[i]],
      'SCI_CLI_ARGUMENT_CONTRACT',
    );
    flags[args[i]] = args[i + 1];
  }
  assert.ok(flags['--public-root'] && flags['--output'], 'SCI_CLI_REQUIRED_ARGUMENTS');
  const fixturePath =
    flags['--fixture'] ||
    fileURLToPath(new URL('../test/unit/fixtures/solarRealtimeReference.json', import.meta.url));
  try {
    const fixture = JSON.parse(readFileSync(fixturePath));
    const result = await checkScience(resolve(flags['--public-root']), fixture, {
      archiveDirectory: flags['--archives'],
    });
    writeFileSync(flags['--output'], JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    const result = { pass: false, failures: [error.message], errorType: error.name };
    writeFileSync(flags['--output'], JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
