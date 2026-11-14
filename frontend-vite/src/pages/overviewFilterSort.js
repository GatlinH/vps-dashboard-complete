export const OVERVIEW_STATUS_KEYS = ['all', 'online', 'warn', 'offline'];
export const OVERVIEW_SORT_KEYS = ['default', 'cpu', 'ram', 'speed', 'expiry', 'traffic'];

export function normalizeOverviewChoice(value, keys, fallback) {
  return keys.includes(value) ? value : fallback;
}

export function loadOverviewChoice(storage, key, keys, fallback) {
  try {
    return normalizeOverviewChoice(storage.getItem(key), keys, fallback);
  } catch {
    return fallback;
  }
}

export function saveOverviewChoice(storage, key, value, keys, fallback) {
  const choice = normalizeOverviewChoice(value, keys, fallback);
  try {
    storage.setItem(key, choice);
  } catch {}
  return choice;
}

export function overviewStatus(server) {
  return server.status === 'online' ? 'online' : server.status === 'warn' ? 'warn' : 'offline';
}

export function countOverviewStatuses(rows) {
  const counts = { all: rows.length, online: 0, warn: 0, offline: 0 };
  for (const server of rows) counts[overviewStatus(server)] += 1;
  return counts;
}

function finiteValue(value, maximum = Infinity) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= maximum ? numeric : null;
}

function rawValue(server, key) {
  return server.__rawPresentFlags?.[key] === true ? finiteValue(server[key]) : null;
}

function pairedValue(server, upKey, downKey) {
  const up = rawValue(server, upKey);
  const down = rawValue(server, downKey);
  const total = up != null && down != null ? up + down : null;
  return Number.isFinite(total) ? total : null;
}

export function overviewSortValue(server, key) {
  if (key === 'cpu' || key === 'ram') {
    const metric = `${key}_use`;
    return server.__liveMetricFlags?.[metric] === true ? finiteValue(server[metric], 100) : null;
  }
  if (key === 'speed') return pairedValue(server, 'net_up', 'net_down');
  if (key === 'traffic')
    return (
      rawValue(server, 'traffic_used_gb') ?? pairedValue(server, 'traffic_up_gb', 'traffic_down_gb')
    );
  if (key === 'expiry') {
    if (typeof server.expiry !== 'string' || !server.expiry.trim()) return null;
    const calendar = server.expiry.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/);
    if (calendar) {
      const date = new Date(`${calendar[1]}T00:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== calendar[1])
        return null;
    }
    const time = Date.parse(server.expiry);
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

export function filterSortOverviewNodes(rows, status, sort, compareDefault) {
  const activeStatus = normalizeOverviewChoice(status, OVERVIEW_STATUS_KEYS, 'all');
  const activeSort = normalizeOverviewChoice(sort, OVERVIEW_SORT_KEYS, 'default');
  return rows
    .filter((server) => activeStatus === 'all' || overviewStatus(server) === activeStatus)
    .sort((first, second) => {
      if (activeSort === 'default') return compareDefault(first, second);
      const firstValue = overviewSortValue(first, activeSort);
      const secondValue = overviewSortValue(second, activeSort);
      if (firstValue == null || secondValue == null) {
        if (firstValue !== secondValue) return firstValue == null ? 1 : -1;
      } else if (firstValue !== secondValue) {
        return activeSort === 'expiry' ? firstValue - secondValue : secondValue - firstValue;
      }
      return compareDefault(first, second);
    });
}
