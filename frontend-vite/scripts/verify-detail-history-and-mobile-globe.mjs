import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const chartsSource = readFileSync(new URL('../src/pages/detailCharts.js', import.meta.url), 'utf8');
const cesiumSource = readFileSync(new URL('../src/components/CesiumGlobe.js', import.meta.url), 'utf8');
const publicHistory = [...mainSource.matchAll(/fetchServerHistory\(([^)]*)\)/g)];
const detailRenderer = mainSource.match(/async function renderDetailPage\(serverId\) \{[\s\S]*?(?=\nfunction denseFallbackSeries)/);
const refreshRenderer = mainSource.match(/async function refreshDetailRealtime\(serverId\) \{[\s\S]*?(?=\nfunction startDetailRealtimeRefresh)/);

assert.ok(detailRenderer, 'detail renderer must exist');
assert.ok(refreshRenderer, 'detail realtime refresh must exist');
assert.ok(publicHistory.length >= 2, 'detail initial and heavy refresh must fetch public server history');
assert.match(
  detailRenderer[0],
  /const historyLimit = detailDays === 0 \? 21600 : liveLimit;/,
  'today must request all 21,600 persisted public history rows',
);
assert.match(
  detailRenderer[0],
  /fetchServerHistory\(resolvedServer\.id, historyDays, historyLimit, detailBucketMinutes\)/,
  'detail renderer must pass selected range and history limit to public history endpoint',
);
assert.match(
  detailRenderer[0],
  /const probeRows = normalizePersistedRows\(probeHistoryData\?\.data \|\| \[\], historyDays \* 24\);/,
  'charts must anchor endpoint rows to their final persisted sample',
);
assert.doesNotMatch(
  detailRenderer[0],
  /loadStoredTelemetrySamples\(|mergeTelemetryRows\(/,
  'initial detail telemetry charts must not use browser-local sample caches',
);
assert.doesNotMatch(
  refreshRenderer[0],
  /mergeTelemetryRows\(/,
  'refresh telemetry charts must retain persisted history rows instead of merging local samples',
);
assert.match(mainSource, /\.sort\(\(a, b\) => a\.__timeMs - b\.__timeMs\)/, 'history rows must be sorted chronologically by true timestamps');
assert.match(chartsSource, /const telemetryHours = detailDays === 0 \? 2 : detailDays \* 24;/, 'today CPU, memory, and freshness must retain a two-hour persisted range');
assert.match(chartsSource, /telemetryEmptyStatePlugin/, 'telemetry charts must provide a genuine persisted-history empty state');
assert.match(chartsSource, /暂无已持久化的历史采样/, 'telemetry empty state must identify absent persisted samples');
assert.doesNotMatch(chartsSource, /expandSinglePointSeries\(cpu|expandSinglePointSeries\(ram|expandSinglePointSeries\(fresh/, 'telemetry charts must not fabricate timestamps');

assert.match(cesiumSource, /const MOBILE_IMAGERY_TONE = \{ brightness: 0\.96, contrast: 1\.08, saturation: 1\.04, gamma: 1\.0 \};/, 'mobile imagery tone must be explicitly bounded');
assert.match(cesiumSource, /Object\.assign\(this\._baseLayer, mobile \? MOBILE_IMAGERY_TONE/, 'mobile base imagery must receive bounded tone properties');
assert.match(cesiumSource, /Object\.assign\(this\._satLayer, mobile \? MOBILE_IMAGERY_TONE/, 'mobile satellite imagery must receive bounded tone properties');
assert.doesNotMatch(cesiumSource, /mobile[^\n]{0,160}(?:alpha|baseColor|Color\.fromCssColorString)/i, 'mobile exposure fix must not add a color overlay');

console.log('DETAIL_HISTORY_MOBILE_GLOBE_REGRESSIONS_VERIFIED persisted-history=21600 chronological=yes persisted-anchor=yes genuine-empty=yes mobile-imagery-tone=bounded no-color-overlay=yes');
