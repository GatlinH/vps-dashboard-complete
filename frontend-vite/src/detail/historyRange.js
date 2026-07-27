import '../globals/dashboardGlobals.js';
// Point-budget contract: larger windows use coarser persisted buckets.
// Supported windows: 1/4/7 days (bounded raw minute buckets) and 30/90 days
// (served by hourly materialized telemetry rollups). Default window is 1 day.
const DETAIL_HISTORY_BUCKETS = { 1: 5, 4: 20, 7: 60, 30: 60, 90: 180 };
const DEFAULT_DETAIL_HISTORY_DAYS = 1;

export function getDetailHistoryDays() {
  const raw = Number(window.__DBG__.DETAIL_HISTORY_DAYS ?? DEFAULT_DETAIL_HISTORY_DAYS) || DEFAULT_DETAIL_HISTORY_DAYS;
  return Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, raw) ? raw : DEFAULT_DETAIL_HISTORY_DAYS;
}

export function setDetailHistoryDays(days, refreshDetailHistoryRange) {
  const requested = Number(days) || DEFAULT_DETAIL_HISTORY_DAYS;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : DEFAULT_DETAIL_HISTORY_DAYS;
  window.__DBG__.DETAIL_HISTORY_DAYS = d;
  try { localStorage.setItem('detailHistoryDays', String(d)); } catch (_) {}
  const sid = new URLSearchParams(location.search).get('server');
  // Range changes must retain the mounted detail shell, globe, and static facts.
  // The caller refreshes only persisted history and the existing chart canvases.
  if (sid && typeof refreshDetailHistoryRange === 'function') refreshDetailHistoryRange(sid);
  return d;
}

export function getDetailHistoryBucketMinutes(days = getDetailHistoryDays()) {
  const requested = Number(days) || DEFAULT_DETAIL_HISTORY_DAYS;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : DEFAULT_DETAIL_HISTORY_DAYS;
  return (DETAIL_HISTORY_BUCKETS[d] ?? 5);
}

// The UI never needs tens of thousands of raw rows. Keep the server response
// within a fixed canvas-friendly budget derived from the selected resolution.
export function getDetailHistoryPointLimit(days = getDetailHistoryDays()) {
  const requested = Number(days) || DEFAULT_DETAIL_HISTORY_DAYS;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : DEFAULT_DETAIL_HISTORY_DAYS;
  const bucketMinutes = getDetailHistoryBucketMinutes(d);
  return Math.max(1, Math.ceil((d * 24 * 60) / bucketMinutes));
}

export function syncDetailHistoryStateFromStorage(initialDays = DEFAULT_DETAIL_HISTORY_DAYS) {
  let raw = (window.__DBG__.DETAIL_HISTORY_DAYS ?? initialDays);
  try { raw = localStorage.getItem('detailHistoryDays') || raw; } catch (_) {}
  const stored = Number(raw || initialDays) || initialDays;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, stored) ? stored : DEFAULT_DETAIL_HISTORY_DAYS;
  window.__DBG__.DETAIL_HISTORY_DAYS = d;
  return d;
}

export { DETAIL_HISTORY_BUCKETS, DEFAULT_DETAIL_HISTORY_DAYS };
