import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildClusterScreenFanout } from '../src/components/globe/vpsClusterInteraction.js';

const members = [
  { id: 30, name: 'Gamma', group: 'core', tags: 'api', group_info: { id: 2, name: '核心', purpose: 'API', color: '#ff6600' } },
  { id: 10, name: 'Alpha', group: 'edge', tags: 'web', group_info: { id: 1, name: '边缘', purpose: 'Web', color: '#0088ff' } },
  { id: 20, name: 'Beta', group: 'wrong legacy group', tags: 'wrong tag', group_info: { id: 2, name: '核心', purpose: 'API', color: '#ff6600' } },
];
const layout = buildClusterScreenFanout({ members, viewportWidth: 1280, viewportHeight: 720 });
assert.equal(layout.length, 2, 'one HUD symbol represents each canonical backend ServerGroup');
assert.deepEqual(layout.map(({ group }) => group.key), ['id:1', 'id:2'], 'HUD group order is stable by canonical group id');
assert.deepEqual(layout.map(({ group }) => group.name), ['边缘', '核心'], 'HUD labels use canonical group names');
assert.deepEqual(layout.map(({ group }) => group.members.map(({ id }) => id)), [[10], [20, 30]], 'each HUD group retains only its own members');
for (const item of layout) {
  assert.ok(item.radiusPx >= 90 && item.radiusPx <= 105, 'HUD radius is responsively clamped to 90–105px');
  assert.ok(item.angleDeg >= 210 && item.angleDeg <= 250, 'HUD members stay in the lower/side arc');
  assert.ok(Math.abs(Math.hypot(item.offsetX, item.offsetY) - item.radiusPx) < 0.001, 'HUD offsets retain their screen radius');
  assert.equal(item.lat, undefined, 'HUD groups have no geographic latitude');
  assert.equal(item.lon, undefined, 'HUD groups have no geographic longitude');
  assert.ok(item.appearance.color && item.appearance.shape, 'HUD group includes role appearance');
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

assert.match(mainSource, /onMemberClick:\s*\(group\) => showClusterMemberPicker\(group\.members, group\)/, 'a HUD group click replaces the picker with that group only');
assert.doesNotMatch(mainSource, /if (clusterPicker) { closeClusterInteraction(); return; }/, 'repeated cluster selections must not blank-close the interaction');
assert.match(cesiumSource, /event.stopPropagation()/, 'HUD button events must not bubble into blank-globe closing handlers');
assert.doesNotMatch(`${interactionSource}\n${cesiumSource}\n${mainSource}`, /localStorage|sessionStorage|fetch\([^\n]*(?:latitude|longitude)/, 'HUD expansion never persists coordinates');

console.log('CLUSTER_SCREEN_FANOUT_REGRESSIONS_VERIFIED screen-radius lower-arc no-fly cleanup navigation');
