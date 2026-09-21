// P3-B: the CC-BY planetary texture package must ship as ordinary static
// files served under a 1-year immutable HTTP cache, and must never enter the
// service worker precache manifest (~6.6 MiB of JPG/PNG would blow the install
// budget and force a full re-download on every SW revision).
//
// Run after `npm run build`; the npm script wires that up.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

// --dist-root=<path> only redirects the directory that is inspected; it exists
// so the assertions below can be proven falsifiable against a tampered
// fixture. The npm script always runs against the real frontend-dist/ output.
const distOverride = process.argv.slice(2).find((argument) => argument.startsWith('--dist-root='));
const distRoot = distOverride
  ? new URL(`${distOverride.slice('--dist-root='.length).replace(/\/*$/, '')}/`, import.meta.url)
  : new URL('../../frontend-dist/', import.meta.url);
const swPath = new URL('sw.js', distRoot);
let sw;
try {
  sw = readFileSync(swPath, 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('frontend-dist/sw.js not found; run npm run build first');
  }
  throw error;
}

// The textures must actually be published, otherwise "not precached" would be
// vacuously true because nothing shipped at all.
const manifestPath = new URL('assets/solar/textures-v1/manifest.json', distRoot);
assert.ok(existsSync(manifestPath), 'built output is missing assets/solar/textures-v1/manifest.json');
const textureManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const textureFiles = Object.values(textureManifest.textures).flatMap((meta) => Object.values(meta.tiers).map((tier) => tier.file));
assert.ok(textureFiles.length >= 22, `expected at least 22 tiered texture files, found ${textureFiles.length}`);
for (const file of textureFiles) {
  assert.ok(existsSync(new URL(`assets/solar/textures-v1/${file}`, distRoot)), `built output is missing texture ${file}`);
}

const manifestStart = sw.indexOf('[{"revision":');
if (manifestStart === -1) {
  throw new Error('Injected precache manifest not found; Workbox output shape may have changed or the service worker was not built');
}

let manifestEnd = -1;
let depth = 0;
let inString = false;
let escaped = false;
for (let index = manifestStart; index < sw.length; index += 1) {
  const character = sw[index];
  if (inString) {
    if (escaped) escaped = false;
    else if (character === '\\') escaped = true;
    else if (character === '"') inString = false;
    continue;
  }
  if (character === '"') {
    inString = true;
  } else if (character === '[') {
    depth += 1;
  } else if (character === ']') {
    depth -= 1;
    if (depth === 0) {
      manifestEnd = index + 1;
      break;
    }
  }
}
if (manifestEnd === -1) {
  throw new Error('Injected precache manifest is unterminated');
}

const precacheManifest = JSON.parse(sw.slice(manifestStart, manifestEnd));
assert.ok(Array.isArray(precacheManifest), 'Injected precache manifest is not an array');
assert.ok(precacheManifest.length >= 5, `Injected precache manifest has too few entries (${precacheManifest.length})`);
const precacheUrls = precacheManifest.map((entry) => entry.url).filter((url) => typeof url === 'string');
assert.ok(precacheUrls.some((url) => /(^|\/)index\.html$/.test(url)), 'Injected precache manifest is missing index.html');

const rasterViolations = precacheUrls.filter((url) => /\.(jpe?g|png|webp|avif)(\?|$)/i.test(url));
assert.equal(rasterViolations.length, 0, `Raster images found in precache (${rasterViolations.length}): ${rasterViolations.slice(0, 5).join(', ')}`);

const packageViolations = precacheUrls.filter((url) => /textures-v1|\/assets\/solar\//i.test(url));
assert.equal(packageViolations.length, 0, `Solar texture package URLs found in precache (${packageViolations.length}): ${packageViolations.slice(0, 5).join(', ')}`);

console.log(`sw precache excludes solar textures: ok (${precacheUrls.length} precache URLs, ${textureFiles.length} texture files shipped)`);
