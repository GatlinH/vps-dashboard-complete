import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const rangeSource = readFileSync(new URL('../src/detail/historyRange.js', import.meta.url), 'utf8');
const mainSource = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

// A history-tab interaction must preserve the mounted detail page. It may fetch
// and redraw charts, but must not invoke the full page renderer / remount map.
assert.match(rangeSource, /setDetailHistoryDays\(days, refreshDetailHistoryRange\)/,
  'range setter must accept the history-only refresh callback');
assert.doesNotMatch(rangeSource, /renderDetailPage/,
  'historyRange must not know or invoke the full detail renderer');
assert.match(mainSource, /async function refreshDetailHistoryRange\(serverId\)/,
  'main entry must expose an in-place history refresh path');
assert.match(mainSource, /setDetailHistoryDaysModule\(days, refreshDetailHistoryRange\)/,
  'range buttons must target the in-place refresh path');
assert.match(mainSource, /DETAIL_RANGE_REFRESH/,
  'range refresh must expose a runtime trace for deployed browser verification');
assert.match(rangeSource, /30:\s*60/, '30-day range must use bounded hourly telemetry buckets');
assert.match(rangeSource, /90:\s*180/, '90-day range must use a bounded three-hour display budget');
assert.match(mainSource, /\[1, 4, 7, 30, 90\]/,
  'detail runtime must preserve the explicitly-supported 1/4/7/30/90-day values');
assert.match(mainSource, /getDetailHistoryPointLimit\(detailDays\)/,
  'initial load and range refresh must share a bounded history point budget');
assert.match(rangeSource, /Math\.ceil\(\(d \* 24 \* 60\) \/ bucketMinutes\)/,
  'point budget must derive from the selected day range and bucket resolution');
assert.match(rangeSource, /return Math\.max\(1, Math\.ceil/,
  'point budget must always remain finite and positive');

// Resolution ladder: every supported window maps to a bounded display bucket.
// Raw windows (<=7d) use minute buckets; 30/90d use hourly rollups (60/180m).
for (const [days, bucket] of [[1, 5], [4, 20], [7, 60], [30, 60], [90, 180]]) {
  assert.match(rangeSource, new RegExp(`${days}:\\s*${bucket}`),
    `resolution ladder must map ${days}d to a ${bucket}m display bucket`);
}

// Merged history: the range refresh must not re-scan ProbeResult via a separate
// traffic/history request; the network series is derived from server-history.
assert.doesNotMatch(mainSource, /traffic\/public\/\$\{current\.id\}\/history/,
  'range refresh must not issue a duplicate traffic/history ProbeResult scan');

// Local skeleton: the chart matrix pulses in place during a range reload.
assert.match(mainSource, /is-range-loading/,
  'range refresh must toggle the in-place chart skeleton class');
assert.match(mainSource, /externalPingPromise = settleWithin\(\s*fetchPingTargetHistory/s,
  'detail first paint must start external PING history asynchronously without a separate target fetch');
assert.match(mainSource, /peerPingPromise = settleWithin\(\s*fetchPingTargetHistory/s,
  'detail first paint must start peer PING history asynchronously without a separate target fetch');
assert.match(mainSource, /DETAIL_PEER_PING_PROGRESSIVE_ERROR/,
  'peer PING completion must be handled outside the first-paint critical path');

console.log('detail range local-refresh contract: ok');
