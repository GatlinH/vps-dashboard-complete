import '../globals/dashboardGlobals.js';
let detailRefreshTimer = null;
let detailHeavyRefreshAt = 0;
let detailVisibilityHandler = null;

export function stopDetailRefreshTimer() {
  if (detailRefreshTimer) clearInterval(detailRefreshTimer);
  if (detailVisibilityHandler && typeof document !== 'undefined') document.removeEventListener('visibilitychange', detailVisibilityHandler);
  detailVisibilityHandler = null;
  detailRefreshTimer = null;
  window.__DBG__.DETAIL_REFRESH_ACTIVE = false;
}

export function startDetailRefreshTimer(callback, intervalMs = 5000) {
  stopDetailRefreshTimer();
  const tick = () => { if (typeof document === 'undefined' || !document.hidden) callback(); };
  detailRefreshTimer = setInterval(tick, intervalMs);
  if (typeof document !== 'undefined') {
    detailVisibilityHandler = () => { if (!document.hidden) callback(); };
    document.addEventListener('visibilitychange', detailVisibilityHandler);
  }
  window.__DBG__.DETAIL_REFRESH_ACTIVE = true;
  window.__DBG__.DETAIL_REFRESH_INTERVAL_MS = intervalMs;
  window.__DBG__.DETAIL_SOURCE_SAMPLE_MS = intervalMs;
  return detailRefreshTimer;
}

export function getDetailHeavyRefreshAt() {
  return detailHeavyRefreshAt;
}

export function setDetailHeavyRefreshAt(value = Date.now()) {
  detailHeavyRefreshAt = Number(value) || 0;
  return detailHeavyRefreshAt;
}
