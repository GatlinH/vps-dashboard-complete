export const detailCache = {
  traffic: null,
  historyRows: [],
  probeRows: [],
  pingTargets: null,
  pingTargetHistory: null,
  vpsProbeTargets: null,
  vpsProbeHistory: null,
};

export function resetDetailCache() {
  detailCache.traffic = null;
  detailCache.historyRows = [];
  detailCache.probeRows = [];
  detailCache.pingTargets = null;
  detailCache.pingTargetHistory = null;
  detailCache.vpsProbeTargets = null;
  detailCache.vpsProbeHistory = null;
}
