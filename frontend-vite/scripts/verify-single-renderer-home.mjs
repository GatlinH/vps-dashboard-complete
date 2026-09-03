import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/modules/serverTable.js', import.meta.url), 'utf8');
const showcaseSource = readFileSync(new URL('../src/components/StarshipShowcase.js', import.meta.url), 'utf8');
const engineSource = readFileSync(new URL('../src/components/starship/EngineFX.js', import.meta.url), 'utf8');
const bussardSource = readFileSync(new URL('../src/components/starship/BussardFX.js', import.meta.url), 'utf8');
const starshipSource = `${showcaseSource}\n${engineSource}\n${bussardSource}`;
const cesiumSource = readFileSync(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8');
const defaultGlobe = mainSource.match(/function getGlobe\(\) \{[\s\S]*?\n\}\n\nfunction initGlobe/);
const displayMount = mainSource.match(/function mountDisplayPage\(\) \{[\s\S]*?\n\}\n\nfunction renderPublicOverviewPage/);

assert.ok(defaultGlobe, 'getGlobe must exist');
assert.ok(displayMount, 'mountDisplayPage must exist');

assert.match(defaultGlobe[0], /new CesiumGlobe\('#globe-container', state\.servers, \{[\s\S]*?enableStarship: false/, '7/17 default: Cesium without embedded ship');
assert.match(defaultGlobe[0], /new StarshipShowcase\(stage, \{[\s\S]*?modelUrl: '\/globe\/xinjian1\.glb\?v=20260728'[\s\S]*?fallbackModelUrl: ''/, 'independent showcase uses one versioned original hero and fails soft instead of downloading a duplicate fallback');
assert.match(defaultGlobe[0], /modelUrl: '\/globe\/xinjian1\.glb\?v=20260728'/, 'homepage explicitly selects the versioned original hero model');
assert.match(defaultGlobe[0], /fallbackModelUrl: ''/, 'homepage must not fetch a duplicate fallback model');
assert.doesNotMatch(defaultGlobe[0], /star_trek_dsc_enterprise_user\.glb/, 'homepage must not request the legacy duplicate hero');

assert.match(displayMount[0], /photo-space-showcase[\s\S]*?starship-gltf-stage/, 'independent stage markup present');
assert.doesNotMatch(defaultGlobe[0], /ThreeGlobe/, 'default home must not use ThreeGlobe');
assert.doesNotMatch(defaultGlobe[0], /fromGltfAsync/, 'default home must not load ship via Cesium Model');

// Composition is intentionally tuned for the complete 55MB original model:
// full silhouette in frame, right-side hero anchor, and readable NCC panel detail.
assert.match(showcaseSource, /camera\.position\.set\(0\.0, 0\.06, 9\.35\)/, 'full original-model camera distance');
assert.match(showcaseSource, /basePosition = new THREE\.Vector3\(2\.15, -0\.16, 0\.0\)/, 'right-side hero anchor keeps the complete silhouette in frame');
assert.match(showcaseSource, /userScale = 0\.86/, 'original-model hero scale keeps labels readable');
assert.match(showcaseSource, /const target = 4\.85/, 'model normalization target');
assert.match(showcaseSource, /this\._addExhaustRig\(\);/, 'runtime adds compact nacelle propulsion');
assert.match(engineSource, /const ports = \[\[-4\.00, 3\.20, -4\.50\], \[-4\.00, -3\.20, -4\.50\]\];/, 'propulsion is anchored to two nacelles');
assert.doesNotMatch(showcaseSource.match(/_finishModelLoad\([\s\S]*?\n  _normalizeUserModel/)[0], /_addWeiyan[45]/, 'runtime model load does not attach legacy smoke/plume rigs');
assert.doesNotMatch(engineSource.match(/_addExhaustRig\(\) \{[\s\S]*?\n\},?\n\n_makeGlowSprite/)[0], /this\._makeExhaustRibbonTexture\(|this\._addWeiyan[45]/, 'compact exhaust rig does not create legacy flame-sheet or plume rigs');
assert.match(showcaseSource, /modelUrl: '\/globe\/xinjian1\.glb\?v=20260728'/, 'showcase default uses the versioned original xinjian1 hero model');
assert.match(showcaseSource, /fallbackModelUrl: ''/, 'showcase fails soft rather than downloading a legacy duplicate fallback');
assert.doesNotMatch(showcaseSource, /star_trek_dsc_enterprise_user\.glb/, 'showcase must not retain the legacy duplicate hero URL');
assert.match(showcaseSource, /_installInteractionHandlers/, 'interaction handlers');
assert.match(showcaseSource, /AnimationMixer/, 'GLB mixer');
assert.match(starshipSource, /bussard/, 'bussard animation path');
assert.match(showcaseSource, /new THREE\.WebGLRenderer/, 'single WebGLRenderer');
assert.match(showcaseSource, /requestAnimationFrame\(\(\) => this\._tick\(\)\)/, 'single rAF');
assert.match(cesiumSource, /this\.enableStarship = options\.enableStarship === true/, 'Cesium starship opt-in only');

console.log('july17 rendering + star_trek_dsc_enterprise_user model regression: ok');
