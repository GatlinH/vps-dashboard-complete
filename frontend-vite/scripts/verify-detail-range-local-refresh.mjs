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
assert.match(mainSource, /\[0, 1, 2, 3, 4, 5, 6, 7, 30, 90\]/,
  'detail runtime must preserve explicitly-supported 30/90-day values');
assert.match(mainSource, /detailDays >= 30 \? 10000 : limit/,
  'long-range hourly PING requests must not truncate multi-target series at the general chart limit');

console.log('detail range local-refresh contract: ok');
