import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Builds test/fixtures/p3-holdout.json from the hold-out (off-grid) Horizons
// vectors. The fixture bundles every hold-out epoch with its position and
// velocity so unit tests can verify interpolation against points that are NOT
// part of the 1050-node grid, without ever reading paths outside the repo at
// test time.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '../..');
const assetsDir = path.join(project, 'public/assets/solar/p1');

const manifestPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(root, 'evidence/P3-horizons-holdout-manifest.json');
const manifestBase = path.basename(manifestPath).replace(/-manifest\.json$/, '');
const ev = path.join(path.dirname(manifestPath), manifestBase);
const outPath = path.join(project, 'test/fixtures/p3-holdout.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });

const manifest = JSON.parse(fs.readFileSync(manifestPath));

const n = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?)';
const re = new RegExp(
  `(\\d+(?:\\.\\d+)?) =[^\\n]*\\r?\\n X =\\s*${n} Y =\\s*${n} Z =\\s*${n}\\r?\\n VX=\\s*${n} VY=\\s*${n} VZ=\\s*${n}`,
  'g',
);

const fixture = {
  schema_version: 1,
  source: manifest.source,
  purpose: manifest.purpose,
  coordinate_contract: manifest.coordinate_contract,
  units: { position: 'AU', velocity: 'AU/day' },
  targets: {},
};

for (const [name, t] of Object.entries(manifest.targets)) {
  const byJd = new Map();
  for (const f of t.files) {
    const raw = fs.readFileSync(path.join(ev, f.file));
    if (crypto.createHash('sha256').update(raw).digest('hex') !== f.sha256) throw new Error(`SHA mismatch ${f.file}`);
    const s = raw.toString();
    for (const m of s.matchAll(re)) {
      const state = m.slice(1).map(Number);
      byJd.set(state[0], state);
    }
  }
  const epochs = [...byJd.values()].sort((a, b) => a[0] - b[0]);

  // Cross-check against the generated grid asset: the hold-out epochs must not
  // intersect the grid nodes, otherwise they are not an independent sample.
  const gridPath = path.join(assetsDir, `${name}.json`);
  if (fs.existsSync(gridPath)) {
    const grid = JSON.parse(fs.readFileSync(gridPath));
    const gridJd = new Set(grid.states.map((row) => row[0]));
    const overlap = epochs.filter((row) => gridJd.has(row[0]));
    if (overlap.length !== 0) throw new Error(`${name}: ${overlap.length} hold-out epochs overlap the grid`);
  }

  if (epochs.length < 1000) throw new Error(`${name}: expected >=1000 hold-out epochs, got ${epochs.length}`);

  fixture.targets[name] = {
    target_command: t.target_command,
    jd_range: [epochs[0][0], epochs[epochs.length - 1][0]],
    epoch_count: epochs.length,
    // Each state is [jd_tdb, x, y, z, vx, vy, vz]; position in AU, velocity AU/day.
    states: epochs,
    source_sha256: t.files.map((x) => x.sha256),
  };
}

fs.writeFileSync(outPath, JSON.stringify(fixture, null, 2));
const counts = Object.entries(fixture.targets).map(([k, v]) => `${k}=${v.epoch_count}`);
process.stdout.write(`fixture written: ${outPath}\n${counts.join(' ')}\n`);
