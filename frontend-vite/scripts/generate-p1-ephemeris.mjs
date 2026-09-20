import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(project, '../..');
const out = path.join(project, 'public/assets/solar/p1');
fs.mkdirSync(out, { recursive: true });

// Manifest path is configurable so the same pipeline covers P1 (default) and
// the P3 full-system grid. The evidence directory is derived from the manifest
// file name: evidence/<X>-horizons-manifest.json -> evidence/<X>-horizons-full.
const manifestArg = process.argv[2];
const manifestPath = manifestArg
  ? path.resolve(process.cwd(), manifestArg)
  : path.join(root, 'evidence/P1-horizons-manifest.json');
const manifestBase = path.basename(manifestPath).replace(/-manifest\.json$/, '');
const ev = path.join(path.dirname(manifestPath), `${manifestBase}-full`);

const manifest = JSON.parse(fs.readFileSync(manifestPath));

const n = '([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[Ee][+-]?\\d+)?)';
const re = new RegExp(
  `(\\d+(?:\\.\\d+)?) =[^\\n]*\\r?\\n X =\\s*${n} Y =\\s*${n} Z =\\s*${n}\\r?\\n VX=\\s*${n} VY=\\s*${n} VZ=\\s*${n}`,
  'g',
);

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
  const states = [...byJd.values()].sort((a, b) => a[0] - b[0]);
  if (states.length !== 1050) throw new Error(`${name}: expected 1050 states, got ${states.length}`);
  fs.writeFileSync(
    `${out}/${name}.json`,
    JSON.stringify({
      schema_version: 1,
      target: name,
      frame: manifest.coordinate_contract,
      time_scale: 'TDB',
      units: { position: 'AU', velocity: 'AU/day' },
      sample: 'daily',
      jd_tdb_range: t.jd_tdb_range,
      states,
      source_sha256: t.files.map((x) => x.sha256),
    }),
  );
}

// Merge into the published manifest instead of overwriting it so previously
// generated targets (e.g. mars/halley) survive when a new manifest is applied.
// The top-level metadata (schema_version/source/coordinate_contract/
// interpolation) is preserved from the existing manifest when present.
const manifestOut = `${out}/manifest.json`;
let merged;
if (fs.existsSync(manifestOut)) {
  merged = JSON.parse(fs.readFileSync(manifestOut));
  merged.targets = { ...merged.targets };
} else {
  merged = { ...manifest, targets: {} };
}
for (const [name, t] of Object.entries(manifest.targets)) merged.targets[name] = t;
fs.writeFileSync(manifestOut, JSON.stringify(merged, null, 2));
