export function createDashboardTab({
  state,
  selectedServerId,
  overviewMode,
  loadServers,
  getMountedGlobe,
  renderOverview,
  renderMoonPanel,
}) {
  let refreshTimer = null;

  async function refresh() {
    if (selectedServerId) return;
    await loadServers();
    getMountedGlobe()?.setServers(state.servers);
    if (overviewMode && document.querySelector('.public-overview-page')) {
      renderOverview();
      window.__DBG__.OVERVIEW_LAST_REFRESH = {
        at: new Date().toISOString(),
        count: state.servers.length,
        names: state.servers.map((server) => server.name),
      };
    }
    renderMoonPanel();
  }

  function startRefresh() {
    if (selectedServerId) return;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, 10000);
    window.__DBG__.OVERVIEW_REFRESH_TIMER = refreshTimer;
    window.__DBG__.OVERVIEW_REFRESH_INTERVAL_MS = 10000;
  }

  function stopRefresh() {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
  }

  return { refresh, startRefresh, stopRefresh };
}
