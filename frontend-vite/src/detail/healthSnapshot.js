export const HEALTH_FUTURE_TOLERANCE_MS = 60_000;
export const HEALTH_WARN_AGE_MS = 30_000;
export const HEALTH_DANGER_AGE_MS = 180_000;

const asTime = (value) => {
  if (value == null || value === '') return null;
  const text = String(value);
  const normalized = /(?:T|\s)\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text) ? `${text}Z` : text;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : null;
};

const nullableNumber = (value) => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const rowServerId = (row) => row?.server_id ?? row?.serverId ?? null;
const rowTime = (row) => asTime(row?.created_at ?? row?.updated_at ?? row?.timestamp);

function hasTelemetry(row) {
  return ['cpu_use', 'ram_use', 'disk_use', 'packet_loss', 'process_count', 'net_up', 'net_down'].some((key) => nullableNumber(row?.[key]) != null);
}

function rawRows(payload, serverId) {
  return [...(Array.isArray(payload?.resource_timeline) ? payload.resource_timeline : []), ...(Array.isArray(payload?.process_history) ? payload.process_history : [])]
    .filter((row) => {
      if (row?.__frontendCache) return false;
      const identity = rowServerId(row);
      return hasTelemetry(row) && rowTime(row) != null && (identity == null || String(identity) === String(serverId));
    })
    .sort((left, right) => rowTime(left) - rowTime(right));
}

function normalSampleSec(rows) {
  const intervals = [];
  for (let index = 1; index < rows.length; index += 1) {
    const seconds = (rowTime(rows[index]) - rowTime(rows[index - 1])) / 1000;
    if (seconds > 0 && seconds <= 300) intervals.push(seconds);
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a - b);
  const middle = Math.floor(intervals.length / 2);
  const median = intervals.length % 2 ? intervals[middle] : (intervals[middle - 1] + intervals[middle]) / 2;
  return Math.round(median);
}

function liveData(payload, serverId) {
  const live = payload?.live && typeof payload.live === 'object' ? payload.live : null;
  if (!live) return null;
  const identity = rowServerId(live);
  if (identity != null && String(identity) !== String(serverId)) return null;
  const updatedAtMs = asTime(live.updated_at);
  return {
    updatedAtMs,
    status: typeof live.status === 'string' ? live.status.trim().toLowerCase() : '',
    cpuPct: nullableNumber(live.cpu_use),
    ramPct: nullableNumber(live.ram_use),
    diskPct: nullableNumber(live.disk_use),
    lossPct: nullableNumber(live.packet_loss ?? live.loss),
  };
}

export function buildAggregateHealthSnapshot({ serverId, generation = 0, receiveSeq = 0, source = 'aggregate', payload = {} }) {
  const rows = rawRows(payload, serverId);
  return {
    serverId: String(serverId),
    generation,
    receiveSeq,
    source,
    live: liveData(payload, serverId),
    raw: { latestMs: rows.length ? rowTime(rows[rows.length - 1]) : null, sampleSec: normalSampleSec(rows) },
  };
}

export function acceptHealthSnapshot(current, candidate) {
  if (!candidate) return current;
  if (!current) return candidate;
  if (candidate.serverId !== current.serverId || candidate.generation !== current.generation) return current;
  const currentTime = current.live?.updatedAtMs ?? -Infinity;
  const candidateTime = candidate.live?.updatedAtMs ?? -Infinity;
  const live = candidate.live?.updatedAtMs == null && current.live ? current.live
    : (candidateTime < currentTime ? current.live : candidate.live);
  const raw = candidate.raw?.latestMs == null || (Number.isFinite(current.raw?.latestMs) && candidate.raw.latestMs < current.raw.latestMs)
    ? current.raw : candidate.raw;
  if (candidateTime < currentTime && candidate.raw?.latestMs == null) return current;
  if (candidateTime === currentTime && candidate.receiveSeq < current.receiveSeq && candidate.source !== 'live') return current;
  if (raw === candidate.raw && live === candidate.live) return candidate;
  return { ...candidate, live, raw };
}

export function evaluateHealthSnapshot(snapshot, now = Date.now()) {
  const rawLatestMs = snapshot?.raw?.latestMs;
  const rawAgeMs = Number.isFinite(rawLatestMs) ? now - rawLatestMs : null;
  const rawAge = rawAgeMs == null ? null : Math.max(0, rawAgeMs);
  const liveLead = Number.isFinite(snapshot?.live?.updatedAtMs) && Number.isFinite(rawLatestMs) ? snapshot.live.updatedAtMs - rawLatestMs : null;
  const metrics = {
    cpuPct: snapshot?.live?.cpuPct ?? null,
    ramPct: snapshot?.live?.ramPct ?? null,
    diskPct: snapshot?.live?.diskPct ?? null,
    lossPct: snapshot?.live?.lossPct ?? null,
  };
  const explicitOffline = ['offline', 'error', 'failed', 'down'].includes(snapshot?.live?.status);
  const metricDanger = [metrics.cpuPct, metrics.ramPct, metrics.diskPct].some((value) => value != null && value >= 95) || (metrics.lossPct != null && metrics.lossPct >= 20);
  const metricWarn = [metrics.cpuPct, metrics.ramPct, metrics.diskPct].some((value) => value != null && value >= 85) || (metrics.lossPct != null && metrics.lossPct >= 5);
  const ageDanger = rawAge != null && rawAge > HEALTH_DANGER_AGE_MS;
  const unknown = rawAge == null || rawAgeMs < -HEALTH_FUTURE_TOLERANCE_MS || (liveLead != null && liveLead > Math.max(2 * (snapshot?.raw?.sampleSec || 0) * 1000, 60_000));
  let state = unknown ? 'unknown' : 'ok';
  if (explicitOffline || metricDanger || ageDanger) state = 'danger';
  else if (unknown) state = 'unknown';
  else if (metricWarn || rawAge > HEALTH_WARN_AGE_MS) state = 'warn';
  return { state, online: explicitOffline ? false : snapshot?.live?.status === 'online' ? true : null, metrics, rawAgeMs: rawAge, liveLeadMs: liveLead, raw: snapshot?.raw || { latestMs: null, sampleSec: null } };
}
