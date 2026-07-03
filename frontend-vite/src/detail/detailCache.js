export const detailCache = {
  traffic: null,
  historyRows: [],
  probeRows: [],
  pingTargets: null,
  pingTargetHistory: null,
  peerPingTargets: null,
};

export function resetDetailCache() {
  detailCache.traffic = null;
  detailCache.historyRows = [];
  detailCache.probeRows = [];
  detailCache.pingTargets = null;
  detailCache.pingTargetHistory = null;
  detailCache.peerPingTargets = null;
}
