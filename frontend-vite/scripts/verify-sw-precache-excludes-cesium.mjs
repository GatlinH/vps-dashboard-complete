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

const precacheUrls = [...sw.matchAll(/"url":"([^"]+)"/g)].map((match) => match[1]);
const violations = precacheUrls.filter((url) => /cesium/i.test(url));
assert.equal(
  violations.length,
  0,
  `Cesium URLs found in precache (${violations.length}): ${violations.slice(0, 5).join(', ')}`,
);
assert.match(sw, /cesium-runtime|\/assets\/cesium-/i, 'Cesium runtime cache route is missing');
console.log(`sw precache excludes Cesium: ok (${precacheUrls.length} URLs)`);
