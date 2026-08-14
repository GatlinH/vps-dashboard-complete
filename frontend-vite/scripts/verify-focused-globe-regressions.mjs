import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { aggregateClusterStatus, buildClusterScreenFanout } from '../src/components/globe/vpsClusterInteraction.js';
import { STATUS_COLORS } from '../src/components/globe-utils.js';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const cesiumSource = readFileSync(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8');
const showcaseSource = readFileSync(new URL('../src/components/StarshipShowcase.js', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const starfleetThemeSource = readFileSync(new URL('../src/styles/starfleet-theme.css', import.meta.url), 'utf8');
const vpsEntitiesSource = readFileSync(new URL('../src/components/globe/vpsEntities.js', import.meta.url), 'utf8');
const labelOverlaySource = readFileSync(new URL('../src/components/globe/runtime/labelOverlay.js', import.meta.url), 'utf8');

const globeSelection = mainSource.match(/function handleGlobeNodeSelection\([\s\S]*?\n}/);
const fanout = cesiumSource.match(/showClusterFanout\([\s\S]*?\n  }\n\n  expandClusterFanout/);
assert.ok(globeSelection, 'globe selection handler must exist');
assert.ok(fanout, 'cluster fanout renderer must exist');
assert.match(globeSelection[0], /if \(selection\.type === 'navigate'\) \{ closeClusterInteraction\(\); navigateToServer\(selection\.member\); return; }/, 'a non-cluster server must still navigate directly');
assert.match(globeSelection[0], /showClusterFanout\(fanoutCluster, selection\.members\);/, 'a co-located anchor must explicitly expand into group HUD shapes');
assert.doesNotMatch(globeSelection[0], /showClusterMemberPicker\(/, 'normal co-located anchors and labels must not open the member picker');
assert.match(fanout[0], /member\.addEventListener\('click', \(event\) => \{ event\.stopPropagation\(\); onMemberClick\?\.\(item\.group\); }\)/, 'only an explicitly-expanded group HUD shape may invoke its picker callback');

// Group IDs are allocated at creation. Fan-out must use four familiar shapes
// before advancing fallback color, even when only a subset co-locates today.
const fanoutGroups = Array.from({ length: 5 }, (_, index) => ({
  id: index + 1,
  status: 'online',
  group_info: { id: index + 1, name: `group-${index + 1}`, purpose: '', color: '' },
}));
const shapeFirstFanout = buildClusterScreenFanout({ members: fanoutGroups, viewportWidth: 1440, viewportHeight: 900 });
assert.deepEqual(shapeFirstFanout.slice(0, 4).map((item) => item.appearance.shape), ['circle', 'diamond', 'square', 'triangle'], 'first four created groups must consume common shapes in order');
assert.equal(new Set(shapeFirstFanout.slice(0, 4).map((item) => item.appearance.color)).size, 1, 'the first shape batch must use one fallback color');
assert.notEqual(shapeFirstFanout[4].appearance.color, shapeFirstFanout[0].appearance.color, 'only after common shapes are exhausted may the fallback color advance');
const sparseFanout = buildClusterScreenFanout({ members: [fanoutGroups[1], fanoutGroups[4]], viewportWidth: 1440, viewportHeight: 900 });
assert.deepEqual(sparseFanout.map((item) => item.appearance.shape), ['diamond', 'circle'], 'a group retains its creation-order shape when earlier groups are absent');
assert.notEqual(sparseFanout[0].appearance.color, sparseFanout[1].appearance.color, 'a later color batch remains distinct in sparse co-location');
const explicitColorFanout = buildClusterScreenFanout({ members: [{
  id: 99,
  status: 'online',
  group_info: { id: 5, name: 'manual-color', purpose: '', color: '#123456' },
}], viewportWidth: 1440, viewportHeight: 900 });
assert.equal(explicitColorFanout[0].appearance.color, '#123456', 'an explicit server_groups color must override the fallback color batch');

assert.match(stylesSource, /\.cluster-member-picker \{[^}]*background: rgba\(3,20,25,\.74\);[^}]*backdrop-filter: blur\(14px\) saturate\(1\.12\);/, 'member picker must use the translucent frosted beacon-callout treatment');
assert.doesNotMatch(stylesSource, /\.cluster-member-picker \{[^}]*rgba\(7,12,23,\.96\)/, 'member picker must not use the opaque legacy panel background');
assert.match(stylesSource, /html body \.google-earth-node-label-layer\.is-far-hidden \.google-earth-node-html-label\.is-vps-node\.is-vps-beacon-node\.is-visible \{[\s\S]*?background: rgba\(3, 20, 25, \.74\) !important;[\s\S]*?backdrop-filter: blur\(8px\) !important;/, 'the final loaded stylesheet must keep readable translucent VPS beacon cards even in the far-hidden starship state');
assert.match(cesiumSource, /const MOBILE_IMAGERY_TONE = \{ brightness: 0\.96, contrast: 1\.08, saturation: 1\.04, gamma: 1\.0 \};/, 'mobile imagery tone must be conservative and non-clipping');
assert.match(cesiumSource, /Object\.assign\(base, \{ show: true, alpha: 1\.0, \.\.\.\(isMobileGlobe\(\) \? MOBILE_IMAGERY_TONE : DESKTOP_BASE_IMAGERY_TONE\) }\);/, 'base layer initialization must respect the mobile tone branch');
assert.match(cesiumSource, /Object\.assign\(sat, \{ show: true, alpha: 1\.0, \.\.\.\(isMobileGlobe\(\) \? MOBILE_IMAGERY_TONE : DESKTOP_SAT_IMAGERY_TONE\) }\);/, 'satellite layer initialization must respect the mobile tone branch');
assert.match(cesiumSource, /this\._baseLayer, mobile \? MOBILE_IMAGERY_TONE : DESKTOP_BASE_IMAGERY_TONE/, 'base layer activation must preserve the mobile branch');
assert.match(cesiumSource, /this\._satLayer, mobile \? MOBILE_IMAGERY_TONE : DESKTOP_SAT_IMAGERY_TONE/, 'satellite layer activation must preserve the mobile branch');

const imageryInstall = cesiumSource.match(/async _installImagery\(\) \{[\s\S]*?\n  \}\n\n  async _installWorldTerrain/);
assert.ok(imageryInstall, 'imagery installer must exist');
const imagerySource = imageryInstall[0];
const baseAddIndex = imagerySource.indexOf('const base = layers.addImageryProvider(baseProvider, 0);');
const baseRenderIndex = imagerySource.indexOf('this._safeRequestRender();', baseAddIndex);
const arcGisAwaitIndex = imagerySource.indexOf('await Cesium.ArcGisMapServerImageryProvider.fromUrl');
const cloudAwaitIndex = imagerySource.indexOf('await Cesium.SingleTileImageryProvider.fromUrl(CLOUDS_TEXTURE_URL');
assert.ok(baseAddIndex >= 0, 'base imagery must be added');
assert.ok(baseRenderIndex > baseAddIndex, 'base imagery must request rendering after it is added');
assert.ok(baseRenderIndex < arcGisAwaitIndex, 'base rendering must be requested before awaiting ArcGIS');
assert.ok(arcGisAwaitIndex < cloudAwaitIndex, 'cloud initialization must remain reachable after an ArcGIS failure');
assert.match(imagerySource.slice(arcGisAwaitIndex, cloudAwaitIndex), /\} catch \(e\) \{[\s\S]*?imageryError/, 'ArcGIS initialization must handle its own failure before cloud initialization');
assert.match(imagerySource.slice(cloudAwaitIndex), /\} catch \(e\) \{[\s\S]*?imageryError/, 'cloud initialization must handle its own failure');

assert.match(mainSource, /new StarshipShowcase\(stage, \{[\s\S]*?modelUrl: '\/globe\/xinjian1\.glb\?v=20260728'[\s\S]*?fallbackModelUrl: ''[\s\S]*?deferMs: 1200/, 'homepage must defer the versioned original model and fail-soft instead of downloading a duplicate GLB');
assert.doesNotMatch(mainSource, /star_trek_dsc_enterprise_user\.glb/, 'homepage must not request the duplicate legacy Enterprise asset');
assert.match(mainSource, /enableStarship: false/, 'Cesium embedded starship must stay disabled on home');
assert.match(showcaseSource, /_installInteractionHandlers/, 'independent showcase must keep interaction handlers');
assert.match(showcaseSource, /_makeGlowTexture\(r, g, b\)/, 'Bussard collector fidelity must define its glow texture helper before use');
assert.match(showcaseSource, /camera\.position\.set\(0\.0, 0\.06, 9\.35\)/, 'original-model complete-silhouette camera baseline');
assert.match(showcaseSource, /basePosition = new THREE\.Vector3\(2\.15, -0\.16, 0\.0\)/, 'Enterprise hero must be pulled inside the desktop right viewport boundary');
const clusterAnchorSource = vpsEntitiesSource.match(/const anchorEntity = globe\.viewer\.entities\.add\(\{[\s\S]*?globe\._nodeEntities\.push\(anchorEntity\);/);
assert.ok(clusterAnchorSource, 'cluster VPS markers must create one anchor point');
assert.match(clusterAnchorSource[0], /position: Cesium\.Cartesian3\.fromDegrees\(lon, lat, 1200\),[\s\S]*?point: anchorPoint/, 'cluster anchors must lift complete health-colored points above terrain depth clipping');
assert.match(vpsEntitiesSource, /pixelSize: 16,[\s\S]*?color: healthColor/, 'VPS beacons use 16px health color anchors for single and clustered nodes');
assert.match(vpsEntitiesSource, /const clusterStatus = isCluster\s*\? aggregateClusterStatus\(cluster\.members\)\s*:\s*\(aggregateClusterStatus\(\[server\]\)\);[\s\S]*?const healthColor = statusColor\(\{ status: clusterStatus \}\);/, 'all VPS anchors must derive color from aggregate health data');
assert.doesNotMatch(vpsEntitiesSource, /node-cluster-range|semiMajorAxis:\s*42000/, 'cluster VPS markers must not render a misleading 42 km geographic range');

for (const { members, status, color, label } of [
  { members: [{ status: 'healthy' }, { status: 'online' }], status: 'online', color: [0, 255, 136], label: 'all healthy members' },
  { members: [{ status: 'online' }, { status: 'error' }], status: 'warn', color: [255, 170, 0], label: 'mixed healthy and unavailable members' },
  { members: [{ status: 'offline' }, { status: 'unknown' }, { status: 'error' }], status: 'offline', color: [255, 40, 72], label: 'all unavailable members' },
]) {
  const aggregateStatus = aggregateClusterStatus(members);
  assert.equal(aggregateStatus, status, `${label} must aggregate to ${status}`);
  assert.deepEqual(STATUS_COLORS[aggregateStatus], color, `${label} must use the expected health color`);
}
assert.match(labelOverlaySource, /placeLabel\(visitorPoint, globe\._visitorLabel, width <= 520 \? 82 : 92\);/, 'desktop visitor labels must use a distinct offset from VPS labels');

console.log('focused globe regressions: ok');
