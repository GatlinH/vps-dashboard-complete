let detailRefreshTimer = null;
let detailHeavyRefreshAt = 0;
let detailPingTargetsFetchedAt = 0;

export function stopDetailRefreshTimer() {
  if (detailRefreshTimer) clearInterval(detailRefreshTimer);
  detailRefreshTimer = null;
  window.__DBG__.DETAIL_REFRESH_ACTIVE = false;
}

export function startDetailRefreshTimer(callback, intervalMs = 5000) {
  stopDetailRefreshTimer();
  detailRefreshTimer = setInterval(callback, intervalMs);
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

export function getDetailPingTargetsFetchedAt() {
  return detailPingTargetsFetchedAt;
}

export function setDetailPingTargetsFetchedAt(value = Date.now()) {
  detailPingTargetsFetchedAt = Number(value) || 0;
  return detailPingTargetsFetchedAt;
}
