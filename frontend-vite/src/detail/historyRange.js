import '../globals/dashboardGlobals.js';
// Point-budget contract: larger windows use coarser persisted buckets.
// 30/90-day views are served by hourly materialized telemetry rollups.
const DETAIL_HISTORY_BUCKETS = { 0: 0, 1: 5, 2: 10, 3: 15, 4: 20, 5: 30, 6: 30, 7: 60, 30: 60, 90: 180 };

export function getDetailHistoryDays() {
  return Number(window.__DBG__.DETAIL_HISTORY_DAYS ?? 0) || 0;
}

export function setDetailHistoryDays(days, refreshDetailHistoryRange) {
  const requested = Number(days) || 0;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : 0;
  window.__DBG__.DETAIL_HISTORY_DAYS = d;
  try { localStorage.setItem('detailHistoryDays', String(d)); } catch (_) {}
  const sid = new URLSearchParams(location.search).get('server');
  // Range changes must retain the mounted detail shell, globe, and static facts.
  // The caller refreshes only persisted history and the existing chart canvases.
  if (sid && typeof refreshDetailHistoryRange === 'function') refreshDetailHistoryRange(sid);
  return d;
}

export function getDetailHistoryBucketMinutes(days = getDetailHistoryDays()) {
  const requested = Number(days) || 0;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, requested) ? requested : 0;
  return (DETAIL_HISTORY_BUCKETS[d] ?? 30);
}

export function syncDetailHistoryStateFromStorage(initialDays = 0) {
  let raw = (window.__DBG__.DETAIL_HISTORY_DAYS ?? initialDays);
  try { raw = localStorage.getItem('detailHistoryDays') || raw; } catch (_) {}
  const stored = Number(raw || initialDays) || initialDays;
  const d = Object.prototype.hasOwnProperty.call(DETAIL_HISTORY_BUCKETS, stored) ? stored : 0;
  window.__DBG__.DETAIL_HISTORY_DAYS = d;
  return d;
}

export { DETAIL_HISTORY_BUCKETS };
