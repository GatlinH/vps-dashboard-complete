import { t } from '../core/preferences.js';
import { toDisplay } from '../utils/currency.js';
import { OVERVIEW_STATUS_KEYS, OVERVIEW_SORT_KEYS } from './overviewFilterSort.js';

function escapeText(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  );
}

export function renderOverviewSummary(summary) {
  const total = summary.status.total;
  const missing = t('overviewSummaryMissing');
  const coverage = (count) => `${t('overviewSummaryCoverage')} ${count}/${total}`;
  const numeric = (value, unit = '') =>
    value == null ? missing : `${Number(value.toFixed(2))}${unit}`;
  const gb = (value) => numeric(value, ' GB');
  const pct = (value) => numeric(value, '%');
  const money = (value) => (value == null ? missing : toDisplay(value));
  const rate = (value) =>
    value == null
      ? missing
      : value >= 1024
        ? `${(value / 1024).toFixed(2)} MB/s`
        : numeric(value, ' KB/s');
  const statuses = `${t('online')} ${summary.status.online} · ${t('warn')} ${summary.status.warn} · ${t('offline')} ${summary.status.offline}`;
  const card = (key, title, value, details) =>
    `<section class="overview-summary-card" data-overview-summary="${key}"><h2 class="overview-summary-title">${escapeText(t(title))}</h2><strong class="overview-summary-value">${escapeText(value)}</strong><div class="overview-summary-details">${details.map((detail) => `<p>${escapeText(detail)}</p>`).join('')}</div></section>`;
  const platform = (entries) =>
    entries.length ? entries.map(([label, count]) => `${label} × ${count}`).join(' · ') : missing;
  const resource = (key, title) => {
    const metric = summary[key];
    return card(key, title, gb(metric.total), [
      `${t('overviewSummaryCapacity')} · ${coverage(metric.totalCoverage)}`,
      `${t('overviewSummaryUsed')} ${gb(metric.used)} · ${pct(metric.rate)}`,
      `${t('overviewSummaryMatched')} · ${coverage(metric.coverage)}`,
    ]);
  };
  const limit =
    summary.traffic.limit.value == null
      ? missing
      : summary.traffic.limit.value === 0
        ? t('overviewSummaryUnset')
        : gb(summary.traffic.limit.value);
  const expiry = summary.expiry;
  return `<div class="overview-summary-grid" role="group" aria-label="${escapeText(t('overviewSummaryLabel'))}">
    ${card('nodes', 'overviewSummaryNodes', String(total), [statuses])}
    ${card('platforms', 'overviewSummaryPlatforms', platform(summary.platforms.arch), [platform(summary.platforms.os)])}
    ${card(
      'cpu',
      'overviewSummaryCpu',
      numeric(summary.cpu.total, ` ${t('overviewSummaryCores')}`),
      [
        `${t('overviewSummaryCapacity')} · ${coverage(summary.cpu.totalCoverage)}`,
        `${t('overviewSummaryAverage')} ${pct(summary.cpu.rate)} · ${coverage(summary.cpu.coverage)}`,
      ],
    )}
    ${card('load', 'overviewSummaryLoad', pct(summary.load.value), [
      summary.load.value == null
        ? missing
        : summary.load.name || (summary.load.id ?? t('unknownNode')),
      coverage(summary.load.coverage),
      t('overviewSummaryHealthy'),
    ])}
    ${resource('ram', 'overviewSummaryRam')}
    ${resource('disk', 'overviewSummaryDisk')}
    ${card('rates', 'overviewSummaryRates', `↑ ${rate(summary.rates.net_up.value)}`, [
      coverage(summary.rates.net_up.coverage),
      `↓ ${rate(summary.rates.net_down.value)}`,
      coverage(summary.rates.net_down.coverage),
      t('overviewSummaryHealthy'),
    ])}
    ${card('traffic', 'overviewSummaryTraffic', gb(summary.traffic.used.value), [
      coverage(summary.traffic.used.coverage),
      `↑ ${gb(summary.traffic.up.value)} · ${coverage(summary.traffic.up.coverage)}`,
      `↓ ${gb(summary.traffic.down.value)} · ${coverage(summary.traffic.down.coverage)}`,
      `${t('overviewSummaryLimit')} ${limit} · ${coverage(summary.traffic.limit.coverage)}`,
      `${t('overviewSummaryUnset')} ${summary.traffic.unset}/${total}`,
      `${pct(summary.traffic.rate)} · ${t('overviewSummaryMatched')} · ${coverage(summary.traffic.coverage)}`,
    ])}
    ${card('cost', 'overviewSummaryCost', money(summary.cost.monthlyActual), [
      `${t('overviewSummaryKnown')} · ${coverage(summary.cost.coverage)}`,
      `${t('overviewSummaryAnnual')} ${money(summary.cost.yearlyActual)}`,
    ])}
    ${card(
      'expiry',
      'overviewSummaryExpiry',
      expiry.valid
        ? `${t('overviewSummaryExpired')} ${expiry.expired} · ${t('within7Days')} ${expiry.soon}`
        : t('overviewSummaryUnset'),
      [
        `${t('overviewSummaryUnset')} ${expiry.missing}/${total}`,
        statuses,
        ...expiry.entries.map(
          (entry) =>
            `${entry.name || entry.id} · ${entry.expired ? t('overviewSummaryExpired') : t('overviewSummaryRemaining')} ${Math.abs(entry.days)} ${t('overviewSummaryDays')}`,
        ),
      ],
    )}
  </div>`;
}
export function renderOverviewControls(status, sort, counts) {
  const statuses = OVERVIEW_STATUS_KEYS.map((key) => `<button type="button" data-overview-status="${key}" aria-pressed="${key === status}"><span>${escapeText(t(key === 'all' ? 'overviewAll' : key))}</span><b>${counts[key]}</b></button>`).join('');
  const sorts = OVERVIEW_SORT_KEYS.map((key) => `<button type="button" data-overview-sort="${key}" aria-pressed="${key === sort}">${escapeText(t(`overviewSort_${key}`))}</button>`).join('');
  return `<section class="overview-filter-sort" aria-label="${escapeText(t('overviewFilter'))}"><div role="group" aria-label="${escapeText(t('overviewStatusFilter'))}">${statuses}</div><div role="group" aria-label="${escapeText(t('overviewSortLabel'))}">${sorts}</div></section>`;
}
