export const detailCache = {
  traffic: null,
  historyRows: [],
  // Dedicated bounded six-hour throughput buckets; separate from selected-range history.
  networkRows: [],
  probeRows: [],
  // Fixed one-hour raw telemetry for CPU/memory/process charts. Long-range
  // history remains separately bucketed for the network chart.
  resourceRows: [],
  processRows: [],
  liveUpdatedAt: 0,
  // Newest 5s live telemetry sample, kept so the 20s persisted re-render can
  // re-align the resource card with the health-summary row (they must agree).
  liveSample: null,
  // Latest computed health snapshot (state/online/counts), used to recompose the
  // health-summary labels on a language switch without waiting for the next poll.
  liveHealth: null,
  pingTargets: null,
  pingTargetHistory: null,
  vpsProbeTargets: null,
  vpsProbeHistory: null,
};

export function resetDetailCache() {
  detailCache.traffic = null;
  detailCache.historyRows = [];
  detailCache.networkRows = [];
  detailCache.probeRows = [];
  detailCache.resourceRows = [];
  detailCache.processRows = [];
  detailCache.liveUpdatedAt = 0;
  detailCache.liveSample = null;
  detailCache.liveHealth = null;
  detailCache.pingTargets = null;
  detailCache.pingTargetHistory = null;
  detailCache.vpsProbeTargets = null;
  detailCache.vpsProbeHistory = null;
}
