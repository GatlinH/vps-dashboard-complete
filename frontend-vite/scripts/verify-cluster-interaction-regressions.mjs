import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildClusterFanout,
  groupClusterMembers,
  resolveClusterSelection,
} from '../src/components/globe/vpsClusterInteraction.js';

const entitiesSource = readFileSync(new URL('../src/components/globe/vpsEntities.js', import.meta.url), 'utf8');
const cesiumSource = readFileSync(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8');
const threeSource = readFileSync(new URL('../src/components/ThreeGlobe.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

const members = [
  { id: 20, name: 'Zulu', group_name: '生产', tags: ['数据库'] },
  { id: 3, name: 'Alpha', group: '生产', public_note: 'Web' },
  { id: 7, name: 'Beta', publicRemark: '边缘' },
];
const fanout = buildClusterFanout({ lat: 31.2304, lon: 121.4737, members });
assert.equal(fanout.length, 3, 'a proximity cluster must fan out every member');
assert.deepEqual(fanout.map(({ member }) => member.id), [3, 7, 20], 'fanout positions must use stable member ordering');
assert.ok(fanout.every(({ visualOnly, lat, lon }) => visualOnly && Number.isFinite(lat) && Number.isFinite(lon)), 'fanout coordinates must be explicit visual-only offsets');
assert.equal(new Set(fanout.map(({ lat, lon }) => `${lat},${lon}`)).size, 3, 'each fanned member needs a unique position');
assert.ok(fanout.every(({ radiusKm }) => radiusKm >= 2 && radiusKm <= 6), 'fanout radius must remain city-view scale');

assert.deepEqual(groupClusterMembers(members), [
  { group: '默认分组', purposes: [{ purpose: '边缘', members: [members[2]] }] },
  { group: '生产', purposes: [{ purpose: '数据库', members: [members[0]] }, { purpose: 'Web', members: [members[1]] }] },
], 'cluster picker must group members by safe group and purpose metadata');
assert.deepEqual(resolveClusterSelection([{ id: 1 }]), { type: 'navigate', member: { id: 1 } }, 'a regular node must still navigate directly');
assert.equal(resolveClusterSelection(members).type, 'expand', 'a multi-member cluster must expand instead of navigating');

assert.match(entitiesSource, /clusterMembers:\s*cluster\.members/, 'Cesium entities must retain all cluster members');
assert.match(entitiesSource, /globe\.onNodeClick\(server,\s*cluster\.members/, 'HTML labels must use the shared cluster callback');
assert.match(cesiumSource, /this\.onNodeClick\(serverData,\s*clusterMembers/, 'Cesium picks must forward all cluster members');
assert.match(cesiumSource, /onBlankClick/, 'Cesium blank-globe clicks must be observable for closing fanout');
assert.match(threeSource, /onBlankClick/, 'Three fallback blank clicks must close its picker');
assert.match(mainSource, /function handleGlobeNodeSelection/, 'all renderers must route node selection through one handler');
assert.match(mainSource, /function closeClusterInteraction/, 'cluster interaction must have an explicit close path');
assert.match(mainSource, /showClusterMemberPicker/, 'Three fallback must present a grouped picker');
assert.match(mainSource, /const canonicalCluster = clusterServersByCoordinate\(state\.servers\)/, 'fanout must resolve the canonical live cluster before using label metadata');
assert.match(mainSource, /const fanoutCluster = canonicalCluster \|\| cluster/, 'Cesium clusters must render visual-only radial fanout from a canonical centroid');
assert.match(indexSource, /document\.documentElement\.classList\.add\('detail-pending'\)/, 'detail routes need a preboot pending marker');
assert.match(indexSource, /\.detail-pending #starfield/, 'preboot guard must hide legacy starfield');
assert.match(indexSource, /\.detail-pending \.display-shell/, 'preboot guard must hide legacy display shell');

console.log('CLUSTER_INTERACTION_REGRESSIONS_VERIFIED fanout grouping unified-click close preboot-guard');
