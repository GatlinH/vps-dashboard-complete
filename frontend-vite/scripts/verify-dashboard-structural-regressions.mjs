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
assert.match(detailStyles, /@media\s*\(min-width:\s*1201px\)\s*\{[\s\S]*?html body \.detail-page-shell\.starship-console-page:has\(\.fleet-detail-console\) \.probe-observability-grid\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1\s*!important;[\s\S]*?grid-row:\s*3\s*!important;[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)\s*!important;/, 'desktop resource grid must span four columns so NET does not wrap');
assert.match(visitorBeacon, /function isRenderableVisitorGeo/, 'visitor beacon must centralize geo validity checks');
assert.match(visitorBeacon, /valid\s*!==\s*false/, 'visitor beacon must reject invalid geo responses');
assert.match(visitorBeacon, /degraded/, 'visitor beacon must reject degraded geo responses');
assert.match(visitorBeacon, /fallback:anonymous/, 'visitor beacon must reject anonymous fallback geo responses');

const clusters = clusterServersByCoordinate([
  { id: 20, latitude: 34.0544, longitude: -118.244 },
  { id: 3, latitude: 34.0549, longitude: -118.243 },
  { id: 7, latitude: 34.0744, longitude: -118.244 },
]);
assert.equal(clusters.length, 2, 'nearby city-level coordinates must form one proximity cluster');
assert.deepEqual(clusters[0].members.map(({ id }) => id), [3, 20], 'cluster members must be deterministically ordered by numeric ID');
assert.equal(clusters[0].lat, 34.05465, 'cluster latitude must be the deterministic centroid');
assert.equal(clusters[0].lon, -118.2435, 'cluster longitude must be the deterministic centroid');
assert.equal(clusters[1].members.length, 1, 'a sufficiently distant coordinate must remain separate');
const invalidClusters = clusterServersByCoordinate([
  { id: 1, latitude: 0, longitude: 0 },
  { id: 2, latitude: 'invalid', longitude: 121.4737 },
]);
assert.equal(invalidClusters.length, 2, 'invalid or null-island coordinates must not form genuine coordinate clusters');
assert.ok(invalidClusters.every((cluster) => cluster.key.startsWith('invalid:')));

console.log('DASHBOARD_STRUCTURAL_REGRESSIONS_VERIFIED detail-grid currency visitor-geo vps-proximity-clustering');
