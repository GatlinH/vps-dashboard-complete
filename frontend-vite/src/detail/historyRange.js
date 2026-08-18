import '../globals/dashboardGlobals.js';
// Point-budget contract: larger windows use coarser persisted buckets.
// Supported windows: 1/4/7 days (bounded raw minute buckets) and 30/90 days
// (served by hourly materialized telemetry rollups). Default window is realtime.
const DETAIL_HISTORY_BUCKETS = { 0: 0, 1: 5, 4: 20, 7: 60, 30: 60, 90: 180 };
const DEFAULT_DETAIL_HISTORY_DAYS = 0;

export function getDetailHistoryDays() {
  const raw = Number(window.__DBG__.DETAIL_HISTORY_DAYS ?? DEFAULT_DETAIL_HISTORY_DAYS);
  return Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, raw) ? raw : DEFAULT_DETAIL_HISTORY_DAYS;
}

export function setDetailHistoryDays(days, refreshDetailHistoryRange) {
  const requested = Number(days);
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
  const requested = Number(days);
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : DEFAULT_DETAIL_HISTORY_DAYS;
  return (DETAIL_HISTORY_BUCKETS[d] ?? 5);
}

// The UI never needs tens of thousands of raw rows. Keep the server response
// within a fixed canvas-friendly budget derived from the selected resolution.
export function getDetailHistoryPointLimit(days = getDetailHistoryDays()) {
  const requested = Number(days);
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : DEFAULT_DETAIL_HISTORY_DAYS;
  const bucketMinutes = getDetailHistoryBucketMinutes(d);
  // Realtime is a raw one-hour series. At second resolution its bounded point
  // budget is 3,600; persisted ranges retain their bucket-derived budgets.
  if (d === 0) return 60 * 60;
  return Math.max(1, Math.ceil((d * 24 * 60) / bucketMinutes));
}

export function syncDetailHistoryStateFromStorage(initialDays = DEFAULT_DETAIL_HISTORY_DAYS) {
  try { localStorage.removeItem('detailHistoryDays'); } catch (_) {}
  window.__DBG__.DETAIL_HISTORY_DAYS = DEFAULT_DETAIL_HISTORY_DAYS;
  return DEFAULT_DETAIL_HISTORY_DAYS;
}

export { DETAIL_HISTORY_BUCKETS, DEFAULT_DETAIL_HISTORY_DAYS };
