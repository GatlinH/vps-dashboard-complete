import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildClusterFanout,
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
assert.ok(fanout.every(({ radiusKm }) => radiusKm >= 12), 'fanout radius must be plainly visible at city-view scale');
assert.ok(fanout.every(({ appearance }) => appearance?.color && appearance?.shape), 'fanout members need stable role-derived color and shape');
assert.ok(fanout.every(({ visualOnly }) => visualOnly), 'fanout offsets must never become persisted node coordinates');

assert.equal(aggregateClusterStatus([{ status: 'healthy' }, { status: 'warning' }]), 'warn', 'warning aliases must aggregate as amber');
assert.equal(aggregateClusterStatus([{ status: 'online' }, { status: 'unknown' }]), 'offline', 'unknown status must take error precedence');
assert.equal(aggregateClusterStatus([{ status: 'warn' }, { status: 'error' }]), 'offline', 'error status must take error precedence');

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
assert.match(entitiesSource, /if \(!isCluster\) \{[\s\S]*?point: \{[\s\S]*?\}[\s\S]*?\}/, 'only a single node may create the center point entity');
assert.match(entitiesSource, /properties: \{ \.\.\.clusterClickProperties, clusterKey: cluster\.key, vpsBeaconRing: true \}/, 'cluster health ring must carry unified cluster click metadata');
assert.match(entitiesSource, /properties: \{ \.\.\.clusterClickProperties, clusterKey: cluster\.key, vpsBeaconSector: true \}/, 'every cluster pie sector must carry unified cluster click metadata');
assert.match(entitiesSource, /globe\.onNodeClick\(server,\s*cluster\.members/, 'HTML labels must use the shared cluster callback');
assert.match(cesiumSource, /if \(vpsClusterClick && typeof this\.onNodeClick === 'function'\) \{[\s\S]*this\.onNodeClick\(serverData, clusterMembers, clusterCentroid\);[\s\S]*return;[\s\S]*\}[\s\S]*if \(serverData && typeof this\.onNodeClick === 'function'\)/, 'Cesium cluster picks must take precedence over generic server navigation');
assert.match(cesiumSource, /this\.onNodeClick\(serverData,\s*clusterMembers/, 'Cesium picks must forward all cluster members');
assert.match(cesiumSource, /item\.appearance\.color/, 'fanout connectors must use member role color');
assert.match(cesiumSource, /_hideCollapsedClusterForFanout\(clusterKey, fanout\)/, 'fanout expansion must hide the matching collapsed cluster before rendering members');
assert.match(cesiumSource, /_hiddenClusterFanoutVisuals/, 'fanout must retain the collapsed visual state needed for exact restoration');
assert.match(cesiumSource, /entity\.show = false/, 'collapsed cluster ring and sectors must be hidden while fanout is active');
assert.match(cesiumSource, /label\.style\.display = 'none'/, 'collapsed cluster HTML label must be hidden while fanout is active');
assert.match(cesiumSource, /entity\.show = previousShow/, 'clearing fanout must restore each collapsed entity\'s original show value');
assert.match(cesiumSource, /label\.style\.display = previousDisplay/, 'clearing fanout must restore the collapsed HTML label\'s original display value');
assert.match(cesiumSource, /width: 38, height: 38/, 'fanout members must use prominent role-shaped billboards');
assert.match(cesiumSource, /pixelSize: 18/, 'fanout members must include a distinct glow point below each billboard');
assert.match(cesiumSource, /showBackground: true/, 'fanout member labels must have a readable background');
assert.match(cesiumSource, /labelOffsetX/, 'fanout member labels must use staggered offsets');
assert.match(cesiumSource, /width: 4/, 'fanout connectors must be visually strong');
assert.match(entitiesSource, /clusterKey: cluster\.key/, 'collapsed cluster entities must retain their cluster key for fanout hiding');
assert.match(entitiesSource, /labelEl\.dataset\.clusterKey = cluster\.key/, 'collapsed cluster HTML labels must retain their cluster key for fanout hiding');
assert.match(cesiumSource, /expandClusterFanout\(\{ clusterKey, lat, lon, fanout, onMemberClick \}\)/, 'Cesium must expose a safe city-flight fanout API');
assert.match(cesiumSource, /this\.flyToCity\(lon, lat, 600_000, \{ complete:/, 'multi-cluster expansion must fly to the canonical centroid before rendering');
assert.match(cesiumSource, /if \(expansionId !== this\._clusterFanoutExpansionId \|\| this\._destroyed\) return;/, 'stale city-flight completions must not render fanout');
assert.match(cesiumSource, /clearClusterFanout\([^)]*\) \{[\s\S]*this\._clusterFanoutExpansionId \+= 1;/, 'clearing fanout must cancel queued expansion');
assert.match(cesiumSource, /this\.viewer\?\.camera\?\.cancelFlight\(\);/, 'clearing fanout must cancel an in-flight city expansion');
assert.match(cesiumSource, /updateServers\(servers\) \{[\s\S]*this\.clearClusterFanout\(\);[\s\S]*this\._buildEntities\(\);/, 'server refresh must clear fanout before rebuilding collapsed cluster visuals');
assert.match(cesiumSource, /onBlankClick/, 'Cesium blank-globe clicks must be observable for closing fanout');
assert.match(threeSource, /onBlankClick/, 'Three fallback blank clicks must close its picker');
assert.match(mainSource, /function handleGlobeNodeSelection/, 'all renderers must route node selection through one handler');
assert.match(mainSource, /function closeClusterInteraction/, 'cluster interaction must have an explicit close path');
assert.match(mainSource, /showClusterMemberPicker/, 'Three fallback must present a grouped picker');
assert.match(mainSource, /const canonicalCluster = clusterServersByCoordinate\(state\.servers\)/, 'fanout must resolve the canonical live cluster before using label metadata');
assert.match(mainSource, /const fanoutCluster = canonicalCluster \|\| cluster/, 'Cesium clusters must render visual-only radial fanout from a canonical centroid');
assert.match(mainSource, /const hasFanoutCentroid = Number\.isFinite\(Number\(fanoutCluster\?\.lat\)\) && Number\.isFinite\(Number\(fanoutCluster\?\.lon\)\)/, 'a finite canonical centroid must be sufficient for globe fanout even when a cluster validity flag is absent');
assert.doesNotMatch(mainSource, /fanoutCluster\?\.valid/, 'globe fanout must not be blocked by an unrelated cluster validity flag when its centroid is finite');
assert.match(mainSource, /globe\?\.expandClusterFanout\?\.\(\{ clusterKey: cluster\.key, lat: cluster\.lat, lon: cluster\.lon, fanout, onMemberClick: navigateToServer \}\)/, 'multi-cluster handler must request Cesium fly-then-expand rather than immediate fanout');
assert.doesNotMatch(mainSource, /showClusterFanout\(fanout, navigateToServer\)/, 'main must not bypass the city-flight expansion API');
assert.doesNotMatch(mainSource, /(?:localStorage|sessionStorage|fetch\([^\n]*latitude|fetch\([^\n]*longitude)/, 'cluster fanout must not persist visual offsets');
assert.match(indexSource, /document\.documentElement\.classList\.add\('detail-pending'\)/, 'detail routes need a preboot pending marker');
assert.match(indexSource, /\.detail-pending #starfield/, 'preboot guard must hide legacy starfield');
assert.match(indexSource, /\.detail-pending \.display-shell/, 'preboot guard must hide legacy display shell');

console.log('CLUSTER_INTERACTION_REGRESSIONS_VERIFIED fanout grouping unified-click close preboot-guard');
