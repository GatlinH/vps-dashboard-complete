export function createDetailTab({
  syncHistoryDays,
  persistHistoryDays,
  refreshHistoryRange,
  stopRefreshTimer,
  startRefreshTimer,
  setHeavyRefreshAt,
  refreshRealtime,
}) {
  let historyDays = syncHistoryDays(1);

  function getHistoryDays() {
    return historyDays;
  }

  function setHistoryDays(days) {
    let refreshServerId;
    historyDays = persistHistoryDays(days, (serverId) => {
      refreshServerId = serverId;
    });
    if (refreshServerId && typeof refreshHistoryRange === 'function') {
      refreshHistoryRange(refreshServerId);
    }
    return historyDays;
  }

  function stopRealtimeRefresh() {
    stopRefreshTimer();
  }

  function startRealtimeRefresh(serverId) {
    stopRealtimeRefresh();
    setHeavyRefreshAt(Date.now());
    const run = () => refreshRealtime(serverId).catch((error) => {
      window.__DBG__.DETAIL_REFRESH_ERROR = String(error?.stack || error);
      console.warn('[detail] realtime refresh failed', error);
    });
    startRefreshTimer(run, 5000);
    run();
  }

  return { getHistoryDays, setHistoryDays, startRealtimeRefresh, stopRealtimeRefresh };
}
