export const detailCache = {
  traffic: null,
  historyRows: [],
  probeRows: [],
  // Fixed one-hour raw telemetry for CPU/memory/process charts. Long-range
  // history remains separately bucketed for the network chart.
  resourceRows: [],
  processRows: [],
  pingTargets: null,
  pingTargetHistory: null,
  vpsProbeTargets: null,
  vpsProbeHistory: null,
};

export function resetDetailCache() {
  detailCache.traffic = null;
  detailCache.historyRows = [];
  detailCache.probeRows = [];
  detailCache.resourceRows = [];
  detailCache.processRows = [];
  detailCache.pingTargets = null;
  detailCache.pingTargetHistory = null;
  detailCache.vpsProbeTargets = null;
  detailCache.vpsProbeHistory = null;
}
