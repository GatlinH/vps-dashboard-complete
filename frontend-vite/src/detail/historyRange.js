const DETAIL_HISTORY_BUCKETS = { 0: 0, 1: 5, 2: 10, 3: 15, 4: 20, 5: 30, 6: 30, 7: 60 };

export function getDetailHistoryDays() {
  return Number(window.__DBG__.DETAIL_HISTORY_DAYS ?? 0) || 0;
}

export function setDetailHistoryDays(days, renderDetailPage) {
  const d = Math.max(0, Math.min(7, Number(days) || 0));
  window.__DBG__.DETAIL_HISTORY_DAYS = d;
  try { localStorage.setItem('detailHistoryDays', String(d)); } catch (_) {}
  const routeServerId = new URLSearchParams(location.search).get('server');
  const selected = new URLSearchParams(location.search).get('server');
  const sid = selected || routeServerId;
  if (sid && typeof renderDetailPage === 'function') renderDetailPage(sid);
  return d;
}

export function getDetailHistoryBucketMinutes(days = getDetailHistoryDays()) {
  const d = Math.max(0, Math.min(7, Number(days) || 0));
  return (DETAIL_HISTORY_BUCKETS[d] ?? 30);
}

export function syncDetailHistoryStateFromStorage(initialDays = 0) {
  let raw = (window.__DBG__.DETAIL_HISTORY_DAYS ?? initialDays);
  try { raw = localStorage.getItem('detailHistoryDays') || raw; } catch (_) {}
  const stored = Number(raw || initialDays) || initialDays;
  const d = Math.max(0, Math.min(7, stored));
  window.__DBG__.DETAIL_HISTORY_DAYS = d;
  return d;
}

export { DETAIL_HISTORY_BUCKETS };
