import { ALL_REGIONS, decodeRegionSelection, encodeRegionSelection, filterRegionalTargets, restoreRegionSelection } from '../services/regionalPing.js';
import { getDetailHistoryPointLimit } from './historyRange.js';

export function createDetailRegionalPingController({ serverId, generation, isCurrent, cache, fetchTargets, fetchHistory, onChange = () => {} }) {
  const state = { selectedRegion: ALL_REGIONS, timeRange: 1, reqSeq: 0, serverId, generation };
  let disposed = false;
  let request = null;
  const active = (seq) => !disposed && isCurrent(serverId, generation) && seq === state.reqSeq;
  async function refresh({ metadata, reloadMetadata = true } = {}) {
    if (disposed || !isCurrent(serverId, generation)) return false;
    request?.abort();
    request = new AbortController();
    const signal = request.signal;
    const seq = ++state.reqSeq;
    let fullMetadata = metadata ?? cache.pingTargetsMetadata;
    if (!metadata && (reloadMetadata || !fullMetadata)) {
      try { fullMetadata = await fetchTargets(serverId, 1, 'external'); } catch { fullMetadata ??= { targets: [], unavailable: true }; }
    }
    if (!active(seq)) return false;
    cache.pingTargetsMetadata = fullMetadata;
    state.selectedRegion = restoreRegionSelection(state.selectedRegion, fullMetadata?.targets);
    cache.pingTargets = { ...fullMetadata, targets: filterRegionalTargets(fullMetadata?.targets, state.selectedRegion) };
    cache.pingTargetHistory = { targets: [] };
    onChange();
    let history;
    try {
      history = cache.pingTargets.targets.length
        ? await fetchHistory(serverId, Math.max(1, state.timeRange * 24), getDetailHistoryPointLimit(state.timeRange), 'external', { selection: state.selectedRegion, signal })
        : { targets: [] };
    } catch {
      history = { targets: [], unavailable: true };
    }
    if (!active(seq)) return false;
    cache.pingTargetHistory = history;
    onChange();
    return true;
  }
  function selectRegion(selection) {
    state.selectedRegion = typeof selection === 'string' ? decodeRegionSelection(selection) : decodeRegionSelection(encodeRegionSelection(selection));
    return refresh({ reloadMetadata: false });
  }
  function setTimeRange(days) {
    state.timeRange = Number(days);
    return refresh({ reloadMetadata: false });
  }
  function dispose() {
    disposed = true;
    state.reqSeq += 1;
    request?.abort();
  }
  return { state, refresh, selectRegion, setTimeRange, dispose };
}
