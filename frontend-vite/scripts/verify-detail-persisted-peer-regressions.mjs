import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const chartsSource = readFileSync(new URL('../src/pages/detailCharts.js', import.meta.url), 'utf8');
const detailPageSource = readFileSync(new URL('../src/pages/detailPage.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/services/displayData.js', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../src/styles/starfleet-theme.css', import.meta.url), 'utf8');

const normalizer = mainSource.match(/function normalizePersistedTimelineRows\(rows = \[\], hours = 2\)[\s\S]*?\n}\n\nfunction seriesWindowFromRows/);
assert.ok(normalizer, 'persisted timeline normalizer must exist');
assert.doesNotMatch(normalizer[0], /Date\.now\(\)/, 'persisted telemetry must not use browser wall-clock');
assert.match(normalizer[0], /lastPersistedProbeMs[\s\S]*?const start = lastPersistedProbeMs - fullSpan/, 'persisted timeline must anchor to its last sample');
assert.match(mainSource, /const probeRows = normalizePersistedRows\(probeHistoryData\?\.data \|\| \[\], historyDays \* 24\);/, 'detail telemetry must use persisted normalizer before CPU/RAM/freshness rendering');
assert.doesNotMatch(mainSource, /const probeRows = normalizeWindowRows\(probeHistoryData/, 'future persisted rows must not be dropped by browser time');
assert.match(mainSource, /const liveLimit = detailDays === 0 \? 21600 :/, 'Today must request 21,600 raw rows on every viewport');
assert.match(mainSource, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit\)/, 'detail PING history must use the public configured-target endpoint');
assert.doesNotMatch(mainSource, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit, 'agent'\)/, 'detail PING history must not request agent peer data');
assert.match(detailPageSource, /PING 延迟/, 'detail chart terminology must identify PING latency');
assert.match(detailPageSource, /延迟监控目标/, 'detail table terminology must identify configured targets');
assert.doesNotMatch(detailPageSource, /displayPeerPingTargetsData|全球 VPS 互探延迟/, 'detail must not retain peer-only PING context');
assert.match(mainSource, /未读取到延迟监控目标/, 'configured-target empty state must not refer to VPS peers');
assert.match(apiSource, /sourceParam.*source=/s, 'ping history API client must pass an explicit source mode');
assert.match(chartsSource, /const networkAxisBounds = \{ min: networkLast - networkHours \* 60 \* 60 \* 1000, max: networkLast/, 'network axis must be a full canonical range ending at latest real sample');
assert.match(themeSource, /\.google-earth-node-html-label\.is-vps-node\.is-vps-beacon-node\s*\{[^}]*background:rgba\(8,18,31,\.6\)!important;[^}]*backdrop-filter:blur\(10px\)/s, 'only VPS beacon labels must override the opaque gradient with frosted translucency');

console.log('DETAIL_CONFIGURED_PING_REGRESSIONS_VERIFIED future-persisted=yes public-targets-only=yes traffic-21600=yes canonical-12h=yes beacon-frosted=yes');
