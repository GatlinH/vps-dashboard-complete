import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--root') throw new Error('Usage: node scripts/verify-precision-manifest.mjs --root <public-or-dist-root>');
const root = resolve(args[1], 'assets/solar/de440-1900-2100');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = readFileSync(join(root, 'manifest.json'));
assert.equal(hash(manifestBytes), '5b9838fdf32de1f40106be6d248636e2a95ffc2f89108bf275277d76db867aa3', '[PRECISION-MANIFEST] exact bound manifest hash');
const manifest = JSON.parse(manifestBytes);
const expected = new Map([['manifest.json', { bytes: manifestBytes.length, sha256: hash(manifestBytes) }]]);
for (const [name, meta] of [...Object.entries(manifest.segments), ['halley', manifest.halley]]) {
  meta.sha256.forEach((sha256, index) => {
    const extension = name === 'halley' ? 'json' : 'f64';
    const bytes = name === 'halley' ? meta.bytes[index] : Math.min(meta.block_records, meta.record_count - index * meta.block_records) * 3 * (meta.degree + 1) * 8;
    expected.set(`${name}/${String(index).padStart(3, '0')}-${sha256.slice(0, 16)}.${extension}`, { bytes, sha256 });
  });
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}
const actual = files(root);
assert.equal(actual.length, expected.size, '[PRECISION-FILES] no missing or unexpected scientific assets');
let total = 0;
let maximum = 0;
for (const file of actual) {
  const name = relative(root, file).replaceAll('\\', '/');
  const contract = expected.get(name);
  assert.ok(contract, `[PRECISION-FILES] unexpected ${name}`);
  const bytes = readFileSync(file);
  assert.equal(bytes.length, contract.bytes, `[PRECISION-LENGTH] ${name}`);
  assert.equal(hash(bytes), contract.sha256, `[PRECISION-HASH] ${name}`);
  assert.ok(bytes.length <= 128 * 1024, `[PRECISION-BUDGET] ${name}`);
  maximum = Math.max(maximum, bytes.length);
  total += bytes.length;
}
assert.equal(actual.length, 865);
assert.equal(total, 21065706);
assert.equal(maximum, 79872);
console.log(JSON.stringify({ root, files: actual.length, bytes: total, maximum, manifestSha256: hash(manifestBytes) }, null, 2));
