import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildClusterScreenFanout,
  aggregateClusterStatus,
  buildClusterBeaconAppearance,
  clusterMemberAppearance,
  groupClusterMembers,
  resolveClusterSelection,
} from '../src/components/globe/vpsClusterInteraction.js';

const entitiesSource = readFileSync(new URL('../src/components/globe/vpsEntities.js', import.meta.url), 'utf8');
const cesiumSource = readFileSync(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8');
const threeSource = readFileSync(new URL('../src/components/ThreeGlobe.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const indexSource = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const labelOverlaySource = readFileSync(new URL('../src/components/globe/runtime/labelOverlay.js', import.meta.url), 'utf8');

const members = [
  { id: 20, name: 'Zulu', group_name: '生产', tags: ['数据库'] },
  { id: 3, name: 'Alpha', group: '生产', public_note: 'Web' },
  { id: 7, name: 'Beta', publicRemark: '边缘' },
];
const fanout = buildClusterScreenFanout({ viewportWidth: 1280, viewportHeight: 720, members });
assert.equal(fanout.length, 2, 'a proximity cluster must fan out canonical groups');
assert.deepEqual(fanout.map(({ group }) => group.name), ['默认分组', '生产'], 'fanout positions must use stable group ordering');
assert.deepEqual(fanout.map(({ group }) => group.members.map(({ id }) => id)), [[7], [3, 20]], 'each fanout group retains its matching members');
assert.ok(fanout.every(({ radiusPx }) => radiusPx >= 90 && radiusPx <= 105), 'fanout must retain a stable screen-space radius');
assert.ok(fanout.every(({ angleDeg }) => angleDeg >= 210 && angleDeg <= 250), 'fanout must avoid the upper label arc');
assert.ok(fanout.every(({ appearance }) => appearance?.color && appearance?.shape), 'fanout groups need stable role-derived color and shape');
assert.ok(fanout.every(({ lat, lon }) => lat === undefined && lon === undefined), 'fanout groups must never have derived geographic coordinates');

assert.equal(aggregateClusterStatus([{ status: 'healthy' }, { status: 'warning' }]), 'warn', 'warning aliases must aggregate as amber');
assert.equal(aggregateClusterStatus([{ status: 'online' }, { status: 'unknown' }]), 'warn', 'mixed healthy and unavailable members must aggregate as amber');
assert.equal(aggregateClusterStatus([{ status: 'warn' }, { status: 'error' }]), 'warn', 'a warning prevents an otherwise unavailable group from being all-red');
assert.equal(aggregateClusterStatus([{ status: 'offline' }, { status: 'unknown' }]), 'offline', 'all unavailable members must aggregate as red');
assert.equal(aggregateClusterStatus([{ status: 'ok' }, { status: 'up' }]), 'online', 'all healthy aliases must aggregate as green');

const canonicalMember = {
  id: 30,
  status: 'online',
  group: 'ignored legacy group',
  tags: ['ignored tag'],
  public_note: 'ignored note',
  group_info: { name: '主控', purpose: '控制平面', color: '#7c3aed' },
};
assert.deepEqual(clusterMemberAppearance(canonicalMember), {
  group: '主控', purpose: '控制平面', color: '#7c3aed', shape: clusterMemberAppearance(canonicalMember).shape,
}, 'group_info must override legacy group, tags, and notes for role appearance');
assert.deepEqual(clusterMemberAppearance({ id: 31, group_info: { name: '默认分组', purpose: '控制平面' } }), clusterMemberAppearance({ id: 99, group_info: { name: '默认分组', purpose: '控制平面' } }), 'role appearance must be stable independently of member id');
const beacon = buildClusterBeaconAppearance([canonicalMember, { id: 32, status: 'online', group_info: { name: '默认分组', purpose: '边缘', color: '#0ea5e9' } }]);
assert.equal(beacon.status, 'online', 'healthy collapsed clusters must remain green');
assert.deepEqual(beacon.sectors.map(({ group, purpose, color, count }) => ({ group, purpose, color, count })), [
  { group: '默认分组', purpose: '边缘', color: '#0ea5e9', count: 1 },
  { group: '主控', purpose: '控制平面', color: '#7c3aed', count: 1 },
], 'collapsed composition must use canonical group_info names, purposes, and colors');
assert.equal(beacon.label, '2 个节点 · 主控 / 默认分组', 'collapsed clusters need an accessible composition label');

assert.deepEqual(groupClusterMembers(members), [
  { group: '默认分组', purposes: [{ purpose: '边缘', members: [members[2]] }] },
  { group: '生产', purposes: [{ purpose: '数据库', members: [members[0]] }, { purpose: 'Web', members: [members[1]] }] },
], 'cluster picker must group members by safe group and purpose metadata');
assert.deepEqual(resolveClusterSelection([{ id: 1 }]), { type: 'navigate', member: { id: 1 } }, 'a regular node must still navigate directly');
assert.equal(resolveClusterSelection(members).type, 'expand', 'a multi-member cluster must expand instead of navigating');

assert.match(entitiesSource, /clusterMembers:\s*cluster\.members/, 'Cesium entities must retain all cluster members');
assert.match(entitiesSource, /buildClusterBeaconAppearance/, 'collapsed Cesium beacons must render composition sectors');
assert.match(entitiesSource, /aggregateClusterStatus/, 'collapsed Cesium beacons must use aggregate health status');
assert.match(entitiesSource, /const clusterClickProperties = isCluster \? \{[\s\S]*serverData: server,[\s\S]*clusterMembers: cluster\.members,[\s\S]*clusterCentroid: \{ lat, lon, clusterKey: cluster\.key \},[\s\S]*vpsClusterClick: true,[\s\S]*\} : null;/, 'collapsed cluster layers must share full-members, representative, canonical-centroid click metadata');
assert.match(entitiesSource, /const anchorEntity = globe\.viewer\.entities\.add\(\{[\s\S]*?id: `node-\$\{server\.id\}`,[\s\S]*?point: \{[\s\S]*?color: healthColor,[\s\S]*?properties: \{ \.\.\.clusterClickProperties, clusterKey: cluster\.key, vpsClusterAnchor: true \}[\s\S]*?\}\);[\s\S]*?globe\._nodeEntities\.push\(anchorEntity\);/, 'every coordinate cluster must create exactly one projected anchor point in _nodeEntities');
assert.match(entitiesSource, /nodeEntity = anchorEntity;/, 'cluster labels must use the projected cluster anchor entity');
assert.match(entitiesSource, /globe\._htmlLabels\.set\(nodeEntity\.id, labelEl\);/, 'cluster HTML labels must use their projected anchor entity key without a fallback key');
assert.match(entitiesSource, /properties: \{ \.\.\.clusterClickProperties, clusterKey: cluster\.key, vpsBeaconRing: true \}/, 'cluster health ring must carry unified cluster click metadata');
assert.match(entitiesSource, /properties: \{ \.\.\.clusterClickProperties, clusterKey: cluster\.key, vpsBeaconSector: true \}/, 'every cluster pie sector must carry unified cluster click metadata');
assert.match(entitiesSource, /globe\.onNodeClick\(server,\s*cluster\.members/, 'HTML labels must use the shared cluster callback');
assert.match(cesiumSource, /if \(vpsClusterClick && typeof this\.onNodeClick === 'function'\) \{[\s\S]*this\.onNodeClick\(serverData, clusterMembers, clusterCentroid\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(serverData && typeof this\.onNodeClick === 'function'\)/, 'Cesium cluster picks must take precedence over generic server navigation');
assert.match(cesiumSource, /this\.onNodeClick\(serverData,\s*clusterMembers/, 'Cesium picks must forward all cluster members');
assert.match(cesiumSource, /item\.appearance\.color/, 'fanout connectors must use member role color');
assert.match(cesiumSource, /_hideCollapsedClusterForFanout\(clusterKey, fanout\)/, 'fanout expansion must hide the matching collapsed cluster before rendering members');
assert.match(cesiumSource, /_hiddenClusterFanoutVisuals/, 'fanout must retain the collapsed visual state needed for exact restoration');
assert.match(cesiumSource, /for \(const \{ entity \} of entities\) entity\.show = false/, 'collapsed cluster ring and sectors must be hidden while fanout is active');
assert.match(cesiumSource, /label\.style\.display = 'none'/, 'collapsed cluster HTML label must be hidden while fanout is active');
assert.match(cesiumSource, /entity\.show = previousShow/, 'clearing fanout must restore each collapsed entity\'s original show value');
assert.match(cesiumSource, /label\.style\.display = previousDisplay/, 'clearing fanout must restore the collapsed HTML label\'s original display value');
assert.match(cesiumSource, /cluster-screen-fanout-member/, 'fanout members must be role-shaped HUD buttons');
assert.match(cesiumSource, /cluster-screen-fanout-leader/, 'fanout members must include visible leaders');
assert.match(entitiesSource, /clusterKey: cluster\.key/, 'collapsed cluster entities must retain their cluster key for fanout hiding');
assert.match(entitiesSource, /labelEl\.dataset\.clusterKey = cluster\.key/, 'collapsed cluster HTML labels must retain their cluster key for fanout hiding');
assert.match(labelOverlaySource, /if \(!Number\.isFinite\(win\?\.x\) \|\| !Number\.isFinite\(win\?\.y\)\) \{[\s\S]*?hideLabel\(labelEl\);[\s\S]*?return;/, 'failed world projections must hide HTML labels instead of falling back to a viewport position');
assert.doesNotMatch(labelOverlaySource, /win\?\.x\s*:\s*width\s*\/\s*2|win\?\.y\s*:\s*height\s*\/\s*2/, 'HTML labels must never use viewport-center fallbacks after a failed projection');
assert.match(cesiumSource, /expandClusterFanout\(\{ clusterKey, lat, lon, fanout, onMemberClick \}\)/, 'Cesium must expose a no-flight screen fanout API');
assert.doesNotMatch(cesiumSource, /flyToCity\(lon, lat, 600_000/, 'expanding a cluster must not fly or zoom the camera');
assert.match(cesiumSource, /worldToWindowCoordinates/, 'the HUD must project its one cluster anchor after rendering');
assert.match(cesiumSource, /frontFacing/, 'the HUD must hide for anchors behind the globe');
assert.match(cesiumSource, /updateServers\(servers\) \{[\s\S]*this\.clearClusterFanout\(\);[\s\S]*this\._buildEntities\(\);/, 'server refresh must clear fanout before rebuilding collapsed cluster visuals');
assert.match(cesiumSource, /onBlankClick/, 'Cesium blank-globe clicks must be observable for closing fanout');
assert.match(threeSource, /onBlankClick/, 'Three fallback blank clicks must close its picker');
assert.match(mainSource, /function handleGlobeNodeSelection/, 'all renderers must route node selection through one handler');
assert.match(mainSource, /function closeClusterInteraction/, 'cluster interaction must have an explicit close path');
assert.match(mainSource, /showClusterMemberPicker/, 'Three fallback must present a grouped picker');
assert.match(mainSource, /const canonicalCluster = clusterServersByCoordinate\(state\.servers\)/, 'fanout must resolve the canonical live cluster before using label metadata');
assert.match(mainSource, /const fanoutCluster = canonicalCluster \|\| cluster/, 'Cesium clusters must use a canonical centroid for the one anchor');
assert.match(mainSource, /buildClusterScreenFanout/, 'multi-cluster handler must build screen-space HUD members');
assert.doesNotMatch(mainSource, /buildClusterFanout/, 'main must not create geographic fanout positions');
assert.doesNotMatch(mainSource, /fanoutCluster\?\.valid/, 'globe fanout must not be blocked by an unrelated cluster validity flag when its centroid is finite');
assert.doesNotMatch(mainSource, /(?:localStorage|sessionStorage|fetch\([^\n]*(?:latitude|longitude))/, 'cluster fanout must not persist visual offsets');
assert.match(indexSource, /document\.documentElement\.classList\.add\('detail-pending'\)/, 'detail routes need a preboot pending marker');
assert.match(indexSource, /\.detail-pending #starfield/, 'preboot guard must hide legacy starfield');
assert.match(indexSource, /\.detail-pending \.display-shell/, 'preboot guard must hide legacy display shell');

console.log('CLUSTER_INTERACTION_REGRESSIONS_VERIFIED fanout grouping unified-click close preboot-guard');
