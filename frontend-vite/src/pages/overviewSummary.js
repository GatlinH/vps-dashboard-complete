import { getMonthlyPrice } from '../utils/currency.js';
import { t } from '../core/preferences.js';

const billingPeriods = new Set([
  'monthly',
  'month',
  '1',
  '月',
  'quarterly',
  'quarter',
  '3',
  '季',
  'semiannual',
  'semi_annually',
  'halfyearly',
  'half_yearly',
  'halfyear',
  '6',
  '半年',
  'yearly',
  'annual',
  'annually',
  'year',
  '12',
  '年',
]);

function number(value, minimum = 0) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum ? numeric : null;
}

function raw(server, key) {
  return server.__rawPresentFlags?.[key] === true ? number(server[key]) : null;
}

function live(server, key) {
  if (server.status !== 'online' || server.__liveMetricFlags?.[key] !== true) return null;
  const value = number(server[key]);
  return value != null && value <= 100 ? value : null;
}

function sum(values) {
  return {
    value: values.length ? values.reduce((total, value) => total + value, 0) : null,
    coverage: values.length,
  };
}

function resource(rows, key) {
  const total = sum(rows.map((server) => raw(server, key)).filter((value) => value != null));
  const matched = rows
    .map((server) => ({ capacity: raw(server, key), rate: live(server, `${key}_use`) }))
    .filter(({ capacity, rate }) => capacity > 0 && rate != null);
  const capacity = matched.reduce((total, entry) => total + entry.capacity, 0);
  const used = matched.reduce((total, entry) => total + (entry.capacity * entry.rate) / 100, 0);
  return {
    total: total.value,
    totalCoverage: total.coverage,
    used: capacity > 0 ? used : null,
    rate: capacity > 0 ? (used / capacity) * 100 : null,
    capacity: capacity > 0 ? capacity : null,
    coverage: matched.length,
  };
}

function counts(rows, key) {
  const result = new Map();
  rows.forEach((server) => {
    const value = String(server[key] ?? '').trim();
    if (value) result.set(value, (result.get(value) || 0) + 1);
  });
  return [...result.entries()].sort((left, right) => right[1] - left[1]);
}

function expiryTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return NaN;
  const calendar = value.match(/^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/);
  if (calendar) {
    const date = new Date(`${calendar[1]}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== calendar[1])
      return NaN;
  }
  return Date.parse(value);
}

export function summarizeOverview(rows, now = Date.now()) {
  const status = { total: rows.length, online: 0, warn: 0, offline: 0 };
  rows.forEach((server) => {
    status[server.status === 'online' ? 'online' : server.status === 'warn' ? 'warn' : 'offline'] +=
      1;
  });
  const cpu = resource(rows, 'cpu');
  const loads = rows
    .map((server) => ({ server, value: live(server, 'cpu_use') }))
    .filter((entry) => entry.value != null);
  const highestLoad = loads.reduce(
    (highest, entry) => (!highest || entry.value > highest.value ? entry : highest),
    null,
  );
  const rates = Object.fromEntries(
    ['net_up', 'net_down'].map((key) => [
      key,
      sum(
        rows
          .filter((server) => server.status === 'online')
          .map((server) => raw(server, key))
          .filter((value) => value != null),
      ),
    ]),
  );
  const usedTraffic = (server) => {
    const direct = raw(server, 'traffic_used_gb');
    if (direct != null) return direct;
    const up = raw(server, 'traffic_up_gb');
    const down = raw(server, 'traffic_down_gb');
    return up != null && down != null ? up + down : null;
  };
  const traffic = {
    used: sum(rows.map(usedTraffic).filter((value) => value != null)),
    up: sum(rows.map((server) => raw(server, 'traffic_up_gb')).filter((value) => value != null)),
    down: sum(
      rows.map((server) => raw(server, 'traffic_down_gb')).filter((value) => value != null),
    ),
    limit: sum(
      rows.map((server) => raw(server, 'traffic_limit_gb')).filter((value) => value != null),
    ),
    unset: rows.filter((server) => raw(server, 'traffic_limit_gb') === 0).length,
    rate: null,
    coverage: 0,
  };
  const limited = rows
    .map((server) => ({ used: usedTraffic(server), limit: raw(server, 'traffic_limit_gb') }))
    .filter((entry) => entry.used != null && entry.limit > 0);
  const denominator = limited.reduce((total, entry) => total + entry.limit, 0);
  if (denominator > 0)
    traffic.rate = (limited.reduce((total, entry) => total + entry.used, 0) / denominator) * 100;
  traffic.coverage = limited.length;
  const byRegion = new Map();
  const byProvider = new Map();
  const prices = [];
  rows.forEach((server) => {
    const price = server.__rawPresentFlags?.price === true ? number(server.price, -1) : null;
    if (price == null || price === 0) return;
    const period =
      server.period ||
      server.agent_config?.billing?.period ||
      server.agent_config?.billing?.period_months;
    if (price > 0 && !billingPeriods.has(String(period).toLowerCase())) return;
    const monthly = price < 0 ? 0 : getMonthlyPrice(server);
    if (!Number.isFinite(monthly) || monthly < 0) return;
    prices.push(monthly);
    const region =
      server.location || server.city || server.region || server.country || t('unknownRegion');
    const provider = server.provider || server.provider_guess || t('unknownProvider');
    byRegion.set(region, (byRegion.get(region) || 0) + monthly);
    byProvider.set(provider, (byProvider.get(provider) || 0) + monthly);
  });
  const monthly = sum(prices);
  const sortCost = (map) =>
    [...map.entries()].sort((left, right) => right[1] - left[1]).slice(0, 4);
  const cost = {
    monthlyActual: monthly.value,
    yearlyActual: monthly.value == null ? null : monthly.value * 12,
    coverage: monthly.coverage,
    byRegion: sortCost(byRegion),
    byProvider: sortCost(byProvider),
  };
  const expiry = { valid: 0, missing: 0, expired: 0, soon: 0, entries: [] };
  rows.forEach((server) => {
    const value = server.expiry;
    const timestamp = expiryTimestamp(value);
    if (!Number.isFinite(timestamp)) {
      expiry.missing += 1;
      return;
    }
    const days = Math.ceil((timestamp - now) / 86400000);
    expiry.valid += 1;
    if (timestamp < now) expiry.expired += 1;
    else if (days <= 7) expiry.soon += 1;
    expiry.entries.push({ id: server.id, name: server.name, days, expired: timestamp < now });
  });
  expiry.entries.sort((left, right) => left.days - right.days);
  return {
    status,
    platforms: { arch: counts(rows, 'arch'), os: counts(rows, 'os') },
    cpu,
    load: {
      value: highestLoad?.value ?? null,
      coverage: loads.length,
      id: highestLoad?.server.id ?? null,
      name: highestLoad?.server.name ?? null,
    },
    ram: resource(rows, 'ram'),
    disk: resource(rows, 'disk'),
    rates,
    traffic,
    cost,
    expiry,
  };
}
