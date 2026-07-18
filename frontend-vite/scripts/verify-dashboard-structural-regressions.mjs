import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clusterServersByCoordinate } from '../src/components/globe/vpsClusters.js';

const detailPage = readFileSync(new URL('../src/pages/detailPage.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const detailStyles = readFileSync(new URL('../src/styles/detail-starfleet-console.css', import.meta.url), 'utf8');
const visitorBeacon = readFileSync(new URL('../src/components/globe/runtime/visitorBeacon.js', import.meta.url), 'utf8');

assert.doesNotMatch(detailPage, /fleet-left-rail/, 'ENV must not occupy a separate desktop left rail');
assert.match(mainSource, /function renderRealtimeResourcePanels\([^)]*runtimeEnvironmentCard[^)]*\)/, 'realtime panel renderer must receive ENV card markup');
assert.match(mainSource, /<section class="probe-observability-grid"[^>]*>[\s\S]*?\$\{runtimeEnvironmentCard\}[\s\S]*?allocation-card[\s\S]*?resources-card[\s\S]*?bandwidth-card/, 'ENV/ALC/RES/NET must share one grid container');
assert.match(detailStyles, /\.detail-currency-switch\s*\{[\s\S]*?height:\s*38px/, 'currency switch must reserve its complete border height');
assert.match(detailStyles, /\.detail-currency-switch\s+\.currency-btn\s*\{[\s\S]*?min-height:\s*36px[\s\S]*?height:\s*36px/, 'currency buttons must fit inside the clipped 38px switch');
assert.doesNotMatch(detailStyles, /\.probe-observability-grid\s*\{\s*display:\s*contents/, 'resource grid must remain a real grid container');
assert.match(visitorBeacon, /function isRenderableVisitorGeo/, 'visitor beacon must centralize geo validity checks');
assert.match(visitorBeacon, /valid\s*!==\s*false/, 'visitor beacon must reject invalid geo responses');
assert.match(visitorBeacon, /degraded/, 'visitor beacon must reject degraded geo responses');
assert.match(visitorBeacon, /fallback:anonymous/, 'visitor beacon must reject anonymous fallback geo responses');

const clusters = clusterServersByCoordinate([
  { id: 20, latitude: 31.23041, longitude: 121.47371 },
  { id: 3, latitude: 31.230409, longitude: 121.473709 },
  { id: 7, latitude: 35.6762, longitude: 139.6503 },
]);
assert.equal(clusters.length, 2, 'same rounded coordinates must form one cluster');
assert.deepEqual(clusters[0].members.map(({ id }) => id), [3, 20], 'cluster members must be deterministically ordered by numeric ID');
assert.equal(clusters[0].key, '31.2304,121.4737');
assert.equal(clusters[1].members.length, 1, 'distinct coordinates must remain distinct');
const invalidClusters = clusterServersByCoordinate([
  { id: 1, latitude: 0, longitude: 0 },
  { id: 2, latitude: 'invalid', longitude: 121.4737 },
]);
assert.equal(invalidClusters.length, 2, 'invalid or null-island coordinates must not form genuine coordinate clusters');
assert.ok(invalidClusters.every((cluster) => cluster.key.startsWith('invalid:')));

console.log('DASHBOARD_STRUCTURAL_REGRESSIONS_VERIFIED detail-grid currency visitor-geo vps-clustering');
