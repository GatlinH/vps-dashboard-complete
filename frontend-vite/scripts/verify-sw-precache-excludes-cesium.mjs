import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const swPath = new URL('../../frontend-dist/sw.js', import.meta.url);
let sw;
try {
  sw = readFileSync(swPath, 'utf8');
} catch (error) {
  if (error?.code === 'ENOENT') {
    throw new Error('frontend-dist/sw.js not found; run npm run build first');
  }
  throw error;
}

const manifestStart = sw.indexOf('[{"revision":');
if (manifestStart === -1) {
  throw new Error(
    'Injected precache manifest not found; Workbox output shape may have changed or the service worker was not built',
  );
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

const manifestText = sw.slice(manifestStart, manifestEnd);
let manifest;
try {
  manifest = JSON.parse(manifestText);
} catch (error) {
  throw new Error(`Injected precache manifest could not be parsed: ${error.message}`);
}
assert.ok(Array.isArray(manifest), 'Injected precache manifest is not an array');
assert.ok(manifest.length >= 5, `Injected precache manifest has too few entries (${manifest.length})`);
assert.ok(
  manifest.some((entry) => typeof entry?.url === 'string' && /(^|\/)index\.html$/.test(entry.url)),
  'Injected precache manifest is missing index.html',
);

const precacheUrls = manifest.map((entry) => entry.url).filter((url) => typeof url === 'string');
const violations = precacheUrls.filter((url) => /cesium/i.test(url));
assert.equal(
  violations.length,
  0,
  `Cesium URLs found in precache (${violations.length}): ${violations.slice(0, 5).join(', ')}`,
);
const serviceWorkerCode = `${sw.slice(0, manifestStart)}${sw.slice(manifestEnd)}`;
assert.match(serviceWorkerCode, /cacheName\s*:\s*["']cesium-runtime-v1["']/i, 'Cesium runtime cacheName is missing');
assert.match(serviceWorkerCode, /startsWith\(\s*["']\/cesium\/["']\s*\)/i, 'Cesium route prefix /cesium/ is missing');
assert.match(serviceWorkerCode, /includes\(\s*["']\/assets\/cesium-["']\s*\)/i, 'Cesium route prefix /assets/cesium- is missing');
console.log(`sw precache excludes Cesium: ok (${precacheUrls.length} URLs)`);
