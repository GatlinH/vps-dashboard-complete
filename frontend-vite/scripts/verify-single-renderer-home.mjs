import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const defaultGlobe = mainSource.match(/function getGlobe\(\) \{[\s\S]*?\n}\n\nfunction initGlobe/);
const displayMount = mainSource.match(/function mountDisplayPage\(\) \{[\s\S]*?\n}\n\nfunction renderPublicOverviewPage/);
const bootRoute = mainSource.match(/async function boot\(\) \{[\s\S]*?\n}\n\nboot\(\);/);

assert.ok(defaultGlobe, 'default globe initializer must exist');
assert.ok(displayMount, 'default display mount must exist');
assert.ok(bootRoute, 'application route dispatch must exist');
assert.match(defaultGlobe[0], /new ThreeGlobe\('#globe-container', state\.servers, \{[\s\S]*?enableStarship: true,[\s\S]*?starshipModelUrl: '\/globe\/xinjian1\.glb'/, 'the default home must use ThreeGlobe with the original starship model enabled');
assert.doesNotMatch(defaultGlobe[0], /CesiumGlobe|URLSearchParams\(window\.location\.search\)\.get\('renderer'\)/, 'the default home must not select Cesium or depend on a renderer query parameter');
assert.doesNotMatch(displayMount[0], /photo-space-showcase|starship-gltf-stage/, 'the default home must not mount an independent StarshipShowcase stage');
assert.doesNotMatch(mainSource, /StarshipShowcase|initStarshipShowcase/, 'the default application path must not initialize StarshipShowcase');
assert.match(bootRoute[0], /else if \(selectedServerId\) \{[\s\S]*?await renderDetailPage\(selectedServerId\);[\s\S]*?else \{[\s\S]*?mountDisplayPage\(\);[\s\S]*?initGlobe\(\);/, 'a ?server= detail route must render before the default ThreeGlobe home path');

console.log('single-renderer home regression: ok');
