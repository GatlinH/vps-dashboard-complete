// Canonical CPU/RAM timeline contract for detail-page realtime charts.
//
// Resource charts are always a raw one-hour timeline.  They must never inherit
// the 1/4/7/30/90-day history selector's bucket because that selector exists for
// the wide historical/network view, not host telemetry.
export const RESOURCE_TIMELINE_HOURS = 1;
export const RESOURCE_TIMELINE_DAYS = 1 / 24;
export const RESOURCE_TIMELINE_LIMIT = 900;

function parseTelemetryTime(row) {
  let text = String(row?.created_at || row?.timestamp || row?.time || row?.ts || '').trim();
  // MySQL's timezone-less ISO form represents UTC in this API. Date.parse would
  // otherwise reinterpret it in the browser timezone and falsely drop/misorder
  // fresh samples on clients outside UTC.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) text += 'Z';
  return Date.parse(text);
}

export function resourceTimelineRows(rows = [], nowMs = Date.now()) {
  const start = nowMs - RESOURCE_TIMELINE_HOURS * 60 * 60 * 1000;
  const byTime = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const time = parseTelemetryTime(row);
    if (!Number.isFinite(time) || time < start || time > nowMs + 60_000) continue;
    // Duplicate timestamps may occur when a live point races a history refresh.
    // Keeping the later array record makes the merge deterministic.
    byTime.set(time, { ...row, __timeMs: time });
  }
  return [...byTime.values()].sort((a, b) => a.__timeMs - b.__timeMs);
}

export function shouldReplaceResourceTimeline(currentRows = [], candidateRows = []) {
  const current = resourceTimelineRows(currentRows);
  const candidate = resourceTimelineRows(candidateRows);
  const currentLast = current.at(-1)?.__timeMs || 0;
  const candidateLast = candidate.at(-1)?.__timeMs || 0;
  // An empty/older HTTP response must not erase a newer point appended by the
  // 5-second live endpoint while the request was in flight.
  if (candidateLast < currentLast) return false;

  // A history endpoint can return a newer final bucket while still being much
  // coarser than the live series already on screen. Compare average spacing so
  // that a 5-minute response cannot replace second-resolution points.
  const spacing = (rows) => rows.length > 1
    ? (rows.at(-1).__timeMs - rows[0].__timeMs) / (rows.length - 1)
    : Infinity;
  const currentSpacing = spacing(current);
  const candidateSpacing = spacing(candidate);
  return !Number.isFinite(currentSpacing)
    || !Number.isFinite(candidateSpacing)
    || candidateSpacing <= currentSpacing * 1.5;
}

export function mergeResourceTimelineHistory(currentRows = [], historyRows = []) {
  const current = resourceTimelineRows(currentRows);
  const history = resourceTimelineRows(historyRows);
  if (!current.length) return history;
  if (!history.length) return current;

  const oldestCurrent = current[0].__timeMs;
  return resourceTimelineRows([
    ...history.filter((row) => row.__timeMs < oldestCurrent),
    ...current,
  ]);
}

export function resourceHistoryRequest() {
  return {
    days: RESOURCE_TIMELINE_DAYS,
    limit: RESOURCE_TIMELINE_LIMIT,
    bucketMinutes: 0,
    metric: 'resource_timeline',
  };
}
