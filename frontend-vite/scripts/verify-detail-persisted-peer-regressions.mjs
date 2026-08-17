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
assert.match(mainSource, /const historyLimit = getDetailHistoryPointLimit\(detailDays\);/, 'selected history ranges must use the bounded point-budget helper');
assert.doesNotMatch(mainSource, /const liveLimit = detailDays === 0 \? 21600 :/, 'detail history must not restore the unbounded 21,600-row request');
assert.match(mainSource, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit\)/, 'detail PING history must use the public configured-target endpoint');
assert.match(mainSource, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit\)/, 'configured-target PING history must remain source=public');
assert.match(mainSource, /fetchPingTargetHistory\(resolvedServer\.id, targetHistoryHours, historyLimit, 'agent'\)/, 'global VPS probe history must explicitly request agent-reported peers');
assert.match(detailPageSource, /t\('chartPingLatency'\).*t\('chartHours6'\).*t\('chartDropLeavesGap'\)/s, 'detail chart terminology must identify configured-target PING with its fixed six-hour window');
assert.match(detailPageSource, /class="detail-ping-target-count">\$\{targetCount\} \$\{Number\(targetCount\) === 1 \? t\('chartTargetOne'\) : t\('chartTargets'\)\}/, 'detail PING card must identify localized configured targets without mixing peer rows');
assert.match(detailPageSource, /<div class="fleet-title">全球 VPS 探针延迟 <small class="fleet-title-hint">当前节点 → 其它 VPS<\/small><\/div>/, 'detail must retain the dedicated global VPS probe surface, separate from configured-target PING');
assert.match(mainSource, /未读取到延迟监测目标/, 'configured-target empty state must not refer to VPS peers');
assert.match(apiSource, /sourceParam.*source=/s, 'ping history API client must pass an explicit source mode');
assert.match(chartsSource, /const networkHours = 6;[\s\S]*?const networkAxisBounds = \(\(\) => \{[\s\S]*?const fullSpan = networkHours \* 60 \* 60 \* 1000;/, 'network axis must use the fixed six-hour duration with an independent real-sample domain');
assert.match(themeSource, /\.google-earth-node-html-label\.is-vps-node\.is-vps-beacon-node\s*\{[^}]*background:rgba\(8,18,31,\.6\)!important;[^}]*backdrop-filter:blur\(10px\)/s, 'only VPS beacon labels must override the opaque gradient with frosted translucency');

console.log('DETAIL_CONFIGURED_PING_REGRESSIONS_VERIFIED future-persisted=yes public-targets-only=yes bounded-history=yes fixed-windows=1h-6h beacon-frosted=yes');
