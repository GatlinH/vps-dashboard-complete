import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildClusterScreenFanout } from '../src/components/globe/vpsClusterInteraction.js';

const members = [
  { id: 30, name: 'Gamma', group: 'core', tags: 'api' },
  { id: 10, name: 'Alpha', group: 'edge', tags: 'web' },
  { id: 20, name: 'Beta', group: 'core', tags: 'db' },
];
const layout = buildClusterScreenFanout({ members, viewportWidth: 1280, viewportHeight: 720 });
assert.equal(layout.length, 3, 'every member receives one HUD layout item');
assert.deepEqual(layout.map(({ member }) => member.id), [10, 20, 30], 'HUD member order is stable by ID');
for (const item of layout) {
  assert.ok(item.radiusPx >= 90 && item.radiusPx <= 105, 'HUD radius is responsively clamped to 90–105px');
  assert.ok(item.angleDeg >= 210 && item.angleDeg <= 250, 'HUD members stay in the lower/side arc');
  assert.ok(Math.abs(Math.hypot(item.offsetX, item.offsetY) - item.radiusPx) < 0.001, 'HUD offsets retain their screen radius');
  assert.equal(item.lat, undefined, 'HUD members have no geographic latitude');
  assert.equal(item.lon, undefined, 'HUD members have no geographic longitude');
  assert.ok(item.appearance.color && item.appearance.shape, 'HUD member includes role appearance');
}

const [narrow] = buildClusterScreenFanout({ members: members.slice(0, 1), viewportWidth: 320, viewportHeight: 480 });
const [wide] = buildClusterScreenFanout({ members: members.slice(0, 1), viewportWidth: 2560, viewportHeight: 1440 });
assert.equal(narrow.radiusPx, 90, 'small viewports use the lower radius clamp');
assert.equal(wide.radiusPx, 105, 'large viewports use the upper radius clamp');

const [interactionSource, cesiumSource, cssSource, mainSource] = await Promise.all([
  readFile(new URL('../src/components/globe/vpsClusterInteraction.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/globe.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);
assert.match(interactionSource, /export function buildClusterScreenFanout/, 'screen HUD layout must be a public pure helper');
assert.doesNotMatch(interactionSource, /EARTH_RADIUS_KM|MIN_FANOUT_RADIUS_KM|radiusKm|latOffset|lonOffset/, 'fanout must not derive geographic member offsets');
assert.match(cesiumSource, /_clusterFanoutLayer/, 'Cesium owns a dedicated HUD overlay layer');
assert.match(cesiumSource, /scene\.postRender[\s\S]*?_updateClusterFanoutOverlay|_updateClusterFanoutOverlay/, 'HUD anchor projection is recomputed post-render');
assert.match(cesiumSource, /worldToWindowCoordinates/, 'HUD projects the one geographic anchor to screen space');
assert.match(cesiumSource, /frontFacing/, 'HUD hides when its anchor is behind the globe');
assert.match(cesiumSource, /leader/, 'HUD members include visual leaders back to the anchor');
assert.match(cesiumSource, /clearClusterFanout\([^)]*\)[\s\S]*?_clusterFanoutLayer\.replaceChildren\(\)/, 'collapse clears HUD members');
assert.match(cesiumSource, /updateServers\(servers\) \{[\s\S]*this\.clearClusterFanout\(\)/, 'updates clear the HUD');
assert.match(cesiumSource, /destroy\(\) \{[\s\S]*this\.clearClusterFanout\(\)/, 'destroy clears the HUD');
assert.doesNotMatch(cesiumSource, /flyToCity\(lon, lat, 600_000/, 'expansion must not fly or zoom the camera');
assert.doesNotMatch(cesiumSource, /vpsClusterFanout/, 'expanded members must not become Cesium map pins');
assert.match(cssSource, /\.cluster-screen-fanout/, 'HUD styles must be scoped');
assert.match(cssSource, /\.cluster-screen-fanout\s*\{[\s\S]*?pointer-events:\s*none/, 'HUD container must not block globe interactions');
assert.match(cssSource, /\.cluster-screen-fanout-member\s*\{[\s\S]*?pointer-events:\s*auto/, 'only member elements accept pointers');
assert.match(mainSource, /buildClusterScreenFanout/, 'main passes screen-HUD presentation data');
assert.doesNotMatch(mainSource, /buildClusterFanout/, 'main must not build geographic fanout coordinates');
assert.doesNotMatch(`${interactionSource}\n${cesiumSource}\n${mainSource}`, /localStorage|sessionStorage|fetch\([^\n]*(?:latitude|longitude)/, 'HUD expansion never persists coordinates');

console.log('CLUSTER_SCREEN_FANOUT_REGRESSIONS_VERIFIED screen-radius lower-arc no-fly cleanup navigation');
