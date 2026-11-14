import { state } from '../store/state.js';
import { LANGUAGE_PACKS, currentLanguage, t } from '../core/preferences.js';
import { toDisplay, calcResidualValue, sourceAmountToCny, getSourceCurrency, updateRateDisplay } from '../utils/currency.js';
import { getTrafficPct } from '../utils/traffic.js';
import { normalizePublicServer } from '../services/serverGroups.js';
import { createOverviewPingController, renderOverviewPing } from '../services/overviewPing.js';
import { summarizeOverview } from './overviewSummary.js';
import { renderOverviewSummary, renderOverviewControls } from './overviewTemplates.js';
import { OVERVIEW_STATUS_KEYS, OVERVIEW_SORT_KEYS, loadOverviewChoice, saveOverviewChoice, countOverviewStatuses, filterSortOverviewNodes } from './overviewFilterSort.js';
export { summarizeOverview };

const OVERVIEW_GROUP_FILTER_KEY = 'vps_overview_group_filter';
const OVERVIEW_STATUS_FILTER_KEY = 'vps_overview_status_filter';
const OVERVIEW_SORT_KEY = 'vps_overview_sort';
let overviewPingController = null;
let overviewRouteObserver = null;
let overviewPageRoot = null;
let overviewLifecycleWindow = null;
let overviewCostView = 'total';
const overviewExpandedDetails = new Set();
const overviewCardDisposers = [];

function checkOverviewRoute() {
  if (!overviewPageRoot?.isConnected || !overviewPageRoot.querySelector('.public-overview-page')) {
    destroyPublicOverviewPage();
  }
}

export function destroyPublicOverviewPage() {
  overviewPingController?.destroy();
  overviewPingController = null;
  overviewRouteObserver?.disconnect();
  overviewRouteObserver = null;
  overviewCardDisposers.splice(0).forEach((dispose) => dispose());
  overviewLifecycleWindow?.removeEventListener('pagehide', destroyPublicOverviewPage);
  overviewLifecycleWindow?.removeEventListener('popstate', checkOverviewRoute);
  overviewLifecycleWindow?.removeEventListener('hashchange', checkOverviewRoute);
  overviewLifecycleWindow = null;
  overviewPageRoot = null;
}

function mountOverviewPing(app, ids) {
  if (!overviewPingController) {
    overviewPingController = createOverviewPingController();
    overviewLifecycleWindow = window;
    window.addEventListener('pagehide', destroyPublicOverviewPage);
    window.addEventListener('popstate', checkOverviewRoute);
    window.addEventListener('hashchange', checkOverviewRoute);
    if (globalThis.MutationObserver) {
      overviewRouteObserver = new MutationObserver(checkOverviewRoute);
      overviewRouteObserver.observe(document.body, { childList: true, subtree: true });
    }
  }
  overviewPageRoot = app;
  overviewPingController.mount(app, ids);
}

function escText(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '\"':'&quot;', "'":'&#39;' }[c]));
}

function fmtResourceGb(value, zero = '0 B') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return zero;
  if (n >= 1024) return `${(n / 1024).toFixed(n >= 10240 ? 1 : 2)} TB`;
  if (n >= 1) return `${n.toFixed(n >= 10 ? 1 : 2)} GB`;
  return `${(n * 1024).toFixed(0)} MB`;
}

function classifyStatus(status) {
  return status === 'online' ? 'online' : status === 'warn' ? 'warn' : 'offline';
}

function daysUntilExpiry(expiry) {
  if (!expiry) return null;
  const t = new Date(expiry);
  if (Number.isNaN(t.getTime())) return null;
  return Math.ceil((t.getTime() - Date.now()) / 86400000);
}

function summarizeMoonPanel(servers = [], cost) {
  const rows = Array.isArray(servers) ? servers : [];
  const status = { total: rows.length, online: 0, warn: 0, offline: 0 };
  const expiry = { today: [], d3: [], d7: [] };
  const badNodes = [];

  for (const s of rows) {
    const cls = classifyStatus(s.status);
    status[cls] += 1;

    const d = daysUntilExpiry(s.expiry);
    if (d != null) {
      if (d === 0) expiry.today.push(s);
      if (d >= 0 && d <= 3) expiry.d3.push(s);
      if (d >= 0 && d <= 7) expiry.d7.push(s);
    }

    const pct = Number(getTrafficPct(s) || 0);
    if (cls !== 'online' || pct >= 85) badNodes.push({ server: s, pct, cls });
  }

  badNodes.sort((a, b) => (a.cls === 'offline' ? -1 : 0) - (b.cls === 'offline' ? -1 : 0) || b.pct - a.pct);

  return {
    status,
    expiry,
    cost,
    badNodes,
  };
}

function maskIpForOverview(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '—') return '—';
  const ipv4 = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?::(\d+))?$/);
  if (ipv4) return `${ipv4[1]}.*.*.***`;
  if (raw.includes(':')) return `${raw.split(':').filter(Boolean)[0] || '***'}:*:*:***`;
  if (raw.length > 3) return `${raw.slice(0, 3)}***`;
  return raw || '***';
}

function overviewMetricValue(server, key) {
  if (!server?.__liveMetricFlags?.[key]) return null;
  const value = server?.[key];
  if (value == null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : null;
}

function renderOverviewMetric(label, value, specification = '—') {
  const pct = value == null ? 0 : value;
  const text = value == null ? '—' : `${value.toFixed(0)}%`;
  return `<span class="overview-metric ${value == null ? 'is-missing' : ''}" style="--pct:${pct.toFixed(0)}"><b>${escText(label)}</b><strong class="overview-metric-value">${text}</strong><i></i><small class="overview-resource-spec">${escText(specification)}</small></span>`;
}

function overviewRateValue(server, key) {
  if (!server.__rawPresentFlags?.[key]) return '—';
  const value = Number(server[key]);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value >= 1024) return `${(value / 1024).toFixed(2)} MB/s`;
  return `${Number(value.toFixed(2))} KB/s`;
}

function overviewTrafficValue(server, key) {
  if (!server.__rawPresentFlags?.[key] || server[key] == null || server[key] === '') return '—';
  const value = Number(server[key]);
  return Number.isFinite(value) && value >= 0 ? fmtResourceGb(value) : '—';
}

function trafficResetDay(server, trafficData = null) {
  const raw = Number(trafficData?.reset_day ?? trafficData?.traffic_reset_day ?? server?.traffic_reset_day ?? 1);
  if (!Number.isFinite(raw)) return 1;
  return Math.max(1, Math.min(31, Math.trunc(raw)));
}

function nextTrafficResetDateLabel(resetDay, now = new Date()) {
  const day = Math.max(1, Math.min(31, Math.trunc(Number(resetDay) || 1)));
  const y = now.getFullYear();
  const m = now.getMonth();
  const effectiveDay = (year, month) => Math.min(day, new Date(year, month + 1, 0).getDate());
  let target = new Date(y, m, effectiveDay(y, m), 0, 0, 0, 0);
  if (target <= now) {
    const ny = m === 11 ? y + 1 : y;
    const nm = (m + 1) % 12;
    target = new Date(ny, nm, effectiveDay(ny, nm), 0, 0, 0, 0);
  }
  const mm = String(target.getMonth() + 1).padStart(2, '0');
  const dd = String(target.getDate()).padStart(2, '0');
  return `${mm}/${dd}`;
}

function formatTrafficResetText(server, trafficData = null, opts = {}) {
  const day = trafficResetDay(server, trafficData);
  // Same locale-ordering contract as the detail page: the day sits between a
  // translated prefix and suffix rather than inside a hardcoded Chinese template.
  const suffix = t('trafficResetMonthlySuffix');
  const prefix = opts.short
    ? `${day}${suffix}`
    : `${t('trafficResetMonthlyPrefix')} ${day} ${suffix}`.replace(/\s+/g, ' ').trim();
  return opts.next === false
    ? prefix
    : `${prefix} · ${t('trafficResetNext')} ${nextTrafficResetDateLabel(day)}`;
}

function formatOverviewTraffic(server) {
  const used = Number(server.traffic_used_gb ?? 0);
  const up = Number(server.traffic_up_gb ?? 0);
  const down = Number(server.traffic_down_gb ?? 0);
  const limit = Number(server.traffic_limit_gb ?? 0);
  const realUsed = used || (up + down);
  if (!realUsed && !limit) return '—';
  const usedText = fmtResourceGb(realUsed);
  const mainText = limit > 0 ? `${usedText} / ${fmtResourceGb(limit)}` : usedText;
  return `${mainText} · ${formatTrafficResetText(server, null, { short: true, next: false })}`;
}

function formatOverviewLoss(server) {
  const loss = server.packet_loss ?? server.loss_rate ?? server.ping_loss;
  if (loss == null || loss === '') return '—';
  const num = Number(loss);
  return Number.isFinite(num) ? `${num.toFixed(1)}%` : '—';
}

function renderOverviewNetworkTable(rows = [], { collapsed = true } = {}) {
  const tableRows = rows.map((server) => {
    const lossText = formatOverviewLoss(server);
    const lossValue = Number.parseFloat(lossText);
    const location = server.location || server.city || server.region || server.country || '—';
    const provider = server.provider_guess || server.provider || server.agent_config?.inventory_meta?.org || server.agent_config?.inventory_meta?.isp || '—';
    const ip = maskIpForOverview(server.ip || server.public_ip || server.agent_config?.inventory_meta?.ip || server.hostname || '—');
    return `
      <tr data-id="${server.id || ''}">
        <td><strong>${escText(server.name || '未命名节点')}</strong></td>
        <td>${escText(ip)}</td>
        <td>${escText(location)}</td>
        <td>${escText(provider)}</td>
        <td><span class="network-table-rate">${escText(formatOverviewTraffic(server))}</span></td>
        <td><span class="network-table-loss ${Number.isFinite(lossValue) && lossValue > 0.5 ? 'is-warn' : ''}">${escText(lossText)}</span></td>
      </tr>`;
  }).join('');
  return `
    <section class="overview-network-table ${collapsed ? 'is-collapsed' : ''}" aria-label="${t('nodeNetworkDetails')}">
      <button class="overview-network-table-toggle" type="button" aria-expanded="${collapsed ? 'false' : 'true'}">
        <div>
          <span class="overview-network-table-kicker">${t('networkDetails')}</span>
          <h2>${t('nodeNetworkDetails')}</h2>
        </div>
        <span class="public-overview-panel-chevron">${collapsed ? '▸' : '▾'}</span>
      </button>
      <div class="overview-network-table-scroll">
        <table>
          <thead><tr><th>${t('tableNodeId')}</th><th>IP</th><th>${t('geoLocation')}</th><th>${t('operator')}</th><th>${t('monthlyTraffic')}</th><th>${t('packetLoss')}</th></tr></thead>
          <tbody>${tableRows || `<tr><td colspan="6">${t('noNetworkData')}</td></tr>`}</tbody>
        </table>
      </div>
    </section>`;
}

function isMasterNode(server = {}) {
  const name = String(server?.name || '');
  const provider = String(server?.provider || server?.provider_guess || '');
  const role = String(server?.role || server?.node_role || server?.agent_config?.role || '').toLowerCase();
  const note = String(server?.note || server?.public_note || '');
  return (
    role === 'master' ||
    role === 'controller' ||
    /主控|master|controller/i.test(name) ||
    /local-master|主控/i.test(provider) ||
    /主控|master/i.test(note) ||
    Number(server?.id) === 1
  );
}

function compareOverviewNodes(a, b) {
  // Master always first so it stays findable when the fleet grows large.
  const ma = isMasterNode(a) ? 0 : 1;
  const mb = isMasterNode(b) ? 0 : 1;
  if (ma !== mb) return ma - mb;

  const rank = (s) => {
    const st = classifyStatus(s.status);
    return st === 'offline' ? 0 : st === 'warn' ? 1 : 2;
  };
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;

  const la = String(a.location || a.city || a.region || a.country || '');
  const lb = String(b.location || b.city || b.region || b.country || '');
  if (la !== lb) return la.localeCompare(lb, 'zh');
  return String(a.name || '').localeCompare(String(b.name || ''), 'zh');
}

function serverGroupMeta(server = {}) {
  const normalized = normalizePublicServer(server);
  const info = server.group_info && typeof server.group_info === 'object' ? server.group_info : null;
  return {
    id: info?.id != null ? String(info.id) : (server.group_id != null ? String(server.group_id) : ''),
    name: String(normalized.group || server.group_name || server.group || '默认分组').trim() || '默认分组',
    purpose: String(normalized.groupPurpose || info?.purpose || '').trim(),
    color: String(normalized.groupColor || info?.color || '').trim(),
    sort: Number(info?.sort_order ?? server.group_sort_order ?? 0) || 0,
  };
}

function loadOverviewGroupFilter() {
  try {
    const raw = localStorage.getItem(OVERVIEW_GROUP_FILTER_KEY);
    return raw && raw !== 'undefined' ? raw : 'all';
  } catch (_) {
    return 'all';
  }
}

function saveOverviewGroupFilter(value) {
  try { localStorage.setItem(OVERVIEW_GROUP_FILTER_KEY, value); } catch (_) {}
}

function buildBackendGroups(rows = []) {
  const map = new Map();
  for (const server of rows) {
    const meta = serverGroupMeta(server);
    const key = meta.id || `name:${meta.name}`;
    if (!map.has(key)) {
      map.set(key, { key, ...meta, count: 0, servers: [] });
    }
    const bucket = map.get(key);
    bucket.count += 1;
    bucket.servers.push(server);
    // keep first non-empty color/purpose/sort from backend
    if (!bucket.color && meta.color) bucket.color = meta.color;
    if (!bucket.purpose && meta.purpose) bucket.purpose = meta.purpose;
    if (!bucket.sort && meta.sort) bucket.sort = meta.sort;
  }
  return [...map.values()].sort((a, b) => {
    if (a.sort !== b.sort) return a.sort - b.sort;
    return a.name.localeCompare(b.name, 'zh');
  });
}

export function renderOverviewNodeCard(s) {
  const raw = s.__rawPresentFlags || {};
  const specification = (key) => {
    const value = Number(s[key]);
    if (!raw[key] || !Number.isFinite(value) || value < 0) return '—';
    return key === 'cpu' ? `${value} 核` : fmtResourceGb(value);
  };
  const cpuValue = overviewMetricValue(s, 'cpu_use');
  const ramValue = overviewMetricValue(s, 'ram_use');
  const diskValue = overviewMetricValue(s, 'disk_use');
  const hasTrafficUsed = raw.traffic_used_gb || (raw.traffic_up_gb && raw.traffic_down_gb);
  const trafficUsed = raw.traffic_used_gb ? Number(s.traffic_used_gb) : Number(s.traffic_up_gb) + Number(s.traffic_down_gb);
  const validTrafficUsed = hasTrafficUsed && Number.isFinite(trafficUsed) && trafficUsed >= 0;
  const trafficLimit = Number(s.traffic_limit_gb);
  const validTrafficLimit = raw.traffic_limit_gb && Number.isFinite(trafficLimit) && trafficLimit >= 0;
  const trafficRaw = validTrafficUsed && validTrafficLimit ? getTrafficPct({ ...s, traffic_used_gb: trafficUsed }) : null;
  const trafficValue = trafficRaw == null || trafficRaw === '' ? null : Math.max(0, Math.min(100, Number(trafficRaw)));
  const trafficSpec = `${validTrafficUsed ? fmtResourceGb(trafficUsed) : '—'}${validTrafficLimit ? ` / ${fmtResourceGb(trafficLimit)}` : ''}`;
  const residual = calcResidualValue(s);
  const baseValue = Number(residual.value || 0);
  const displayName = s.name || t('unknownNode');
  const statusCls = classifyStatus(s.status);
  const master = isMasterNode(s);
  const group = serverGroupMeta(s);
  const groupStyle = group.color ? ` style="--group-color:${escText(group.color)}"` : '';
  const safeId = Number.isSafeInteger(Number(s.id)) ? String(Number(s.id)) : '';
  const safeDisplayName = escText(displayName);
  const safeFlag = escText(s.flag || '🌐');
  const safeProvider = escText(s.provider_guess || s.provider || t('unknownProvider'));
  const safeLocation = escText(s.location || s.city || s.region || s.country || t('unknownRegion'));
  const expiryDays = daysUntilExpiry(s.expiry);
  const expiryText = expiryDays == null ? '—' : `${String(s.expiry).split('T')[0]} · ${expiryDays} 天`;
  const priceText = raw.price && Number.isFinite(Number(s.price))
    ? `${toDisplay(sourceAmountToCny(s.price, getSourceCurrency(s)))}${s.period ? ` / ${s.period}` : ''}` : '—';
  return `
    <article class="public-overview-card is-v2-card status-${statusCls}${master ? ' is-master' : ''}" data-id="${safeId}" data-group-key="${escText(group.id || `name:${group.name}`)}" role="link" tabindex="0" aria-label="${safeDisplayName}"${groupStyle}>
      <div class="public-overview-head">
        <div><span class="public-overview-flag">${safeFlag}</span><strong>${safeDisplayName}</strong>${master ? `<em class="overview-master-badge">${t('overviewMaster')}</em>` : ''}</div>
        <div class="public-overview-actions"><button class="public-money-btn" type="button" data-overview-interactive data-id="${safeId}" data-base="${baseValue}" data-name="${safeDisplayName}" aria-label="${safeDisplayName} 计算器">计算器</button><span class="public-overview-status is-${statusCls}">${s.status ? escText(t(statusCls)) : '—'}</span></div>
      </div>
      <div class="public-overview-meta"><span class="overview-group-chip">${escText(group.name)}</span> · ${safeProvider} · ${safeLocation}</div>
      <div class="overview-hostname">主机名 <span data-overview-field="hostname">${escText(raw.hostname ? s.hostname : '—')}</span></div>
      <div class="overview-card-facts">
        <span>系统 <b>${escText(s.os || '—')}</b></span>
        <span>到期 <b>${escText(expiryText)}</b></span>
        <span>在线时长 <b>${escText(s.uptime ?? '—')}</b></span>
        <span>资费 <b>${escText(priceText)}</b></span>
      </div>
      <div class="overview-resource-grid">
        ${renderOverviewMetric('CPU', cpuValue, specification('cpu'))}
        ${renderOverviewMetric('RAM', ramValue, specification('ram'))}
        ${renderOverviewMetric('DISK', diskValue, specification('disk'))}
        ${renderOverviewMetric('流量', Number.isFinite(trafficValue) ? trafficValue : null, trafficSpec)}
      </div>
      <div class="overview-card-stats">
        <div><span>即时网速</span><strong>↑ ${escText(overviewRateValue(s, 'net_up'))}</strong><strong>↓ ${escText(overviewRateValue(s, 'net_down'))}</strong></div>
        <div><span>本月 / 本周期流量</span><strong>↑ ${escText(overviewTrafficValue(s, 'traffic_up_gb'))}</strong><strong>↓ ${escText(overviewTrafficValue(s, 'traffic_down_gb'))}</strong></div>
        <div><span>剩余价值</span><button class="public-money-btn overview-residual-btn" type="button" data-overview-interactive data-id="${safeId}" data-base="${baseValue}" data-name="${safeDisplayName}" aria-label="${safeDisplayName} 剩余价值计算器">${escText(raw.price ? toDisplay(baseValue) : '—')}</button></div>
      </div>
      <div class="overview-ping" data-server-id="${safeId}">${renderOverviewPing({ id: safeId, ...overviewPingController?.getState(safeId) })}</div>
    </article>`;
}

export function bindOverviewCardEvents(card, { navigate, openCalculator }) {
  const interactiveSelector = 'button, select, input, textarea, a, .public-money-btn, [data-overview-interactive], [data-ping-region], [data-ping-hours], [data-ping-slot]';
  const handleEvent = (event) => {
    const control = event.target.closest?.(interactiveSelector);
    if (control && card.contains(control)) {
      event.stopPropagation();
      const calculator = event.target.closest?.('.public-money-btn');
      if (event.type === 'click' && calculator && card.contains(calculator)) {
        event.preventDefault();
        openCalculator({ id: calculator.dataset.id, name: calculator.dataset.name, base: Number(calculator.dataset.base || 0) });
      }
      return;
    }
    if (event.type === 'click' || (event.type === 'keydown' && (event.key === 'Enter' || event.key === ' '))) {
      const id = card.getAttribute('data-id');
      if (!id) return;
      event.preventDefault();
      navigate(`/?server=${encodeURIComponent(id)}`);
    }
  };
  for (const type of ['click', 'pointerover', 'keydown']) card.addEventListener(type, handleEvent);
  return () => {
    for (const type of ['click', 'pointerover', 'keydown']) card.removeEventListener(type, handleEvent);
  };
}

function collectFilteredNodes(groups = [], activeKey = 'all') {
  // Filter tabs own the grouping UX. Always render ONE flat card grid so we
  // don't double-express groups as both tabs and multi-section card blocks.
  const visible = activeKey === 'all' ? groups : groups.filter((g) => g.key === activeKey);
  return visible.flatMap((group) => group.servers || []).sort(compareOverviewNodes);
}

function renderFlatNodeList(nodes = [], activeMeta = null) {
  if (!nodes.length) {
    return `<div class="public-overview-empty">${t('overviewNoNodes')}</div>`;
  }
  const hint = activeMeta && activeMeta.key !== 'all'
    ? `<div class="overview-filter-hint">${t('overviewFilter')}：<b>${escText(activeMeta.name)}</b>${activeMeta.purpose ? ` · ${escText(activeMeta.purpose)}` : ''} · ${nodes.length} ${t('overviewNodes')}</div>`
    : '';
  return `${hint}<div class="public-overview-list overview-v2-list" id="overviewNodeGrid">${nodes.map(renderOverviewNodeCard).join('')}</div>`;
}

export function renderPublicOverviewPage(onRequestRerender) {
  const app = document.getElementById('pageRoot');
  if (!app) { destroyPublicOverviewPage(); return; }
  overviewCardDisposers.splice(0).forEach((dispose) => dispose());
  app.querySelectorAll('[data-overview-detail]').forEach((detail) => {
    const key = detail.getAttribute('data-overview-detail');
    if (detail.open) overviewExpandedDetails.add(key);
    else overviewExpandedDetails.delete(key);
  });
  const rows = Array.isArray(state.servers) ? state.servers : [];
  const assetSummary = summarizeOverview(rows);
  const summary = summarizeMoonPanel(rows, assetSummary.cost);
  const updatedAtText = state.serversUpdatedAt ? new Date(state.serversUpdatedAt).toLocaleString(currentLanguage === 'zh' ? 'zh-CN' : undefined, { hour12: false }) : t('overviewUpdatedMissing');
  const backendGroups = buildBackendGroups(rows);
  let activeGroup = loadOverviewGroupFilter();
  if (activeGroup !== 'all' && !backendGroups.some((g) => g.key === activeGroup)) {
    activeGroup = 'all';
    saveOverviewGroupFilter('all');
  }
  const activeMeta = activeGroup === 'all'
    ? { key: 'all', name: t('overviewAllNodes'), purpose: '', count: rows.length }
    : (backendGroups.find((g) => g.key === activeGroup) || { key: activeGroup, name: t('overviewCurrentGroup'), purpose: '', count: 0 });
  const groupedNodes = collectFilteredNodes(backendGroups, activeGroup);
  const activeStatus = loadOverviewChoice(localStorage, OVERVIEW_STATUS_FILTER_KEY, OVERVIEW_STATUS_KEYS, 'all');
  const activeSort = loadOverviewChoice(localStorage, OVERVIEW_SORT_KEY, OVERVIEW_SORT_KEYS, 'default');
  const statusCounts = countOverviewStatuses(groupedNodes);
  const filteredNodes = filterSortOverviewNodes(groupedNodes, activeStatus, activeSort, compareOverviewNodes);
  const requestRerender = typeof onRequestRerender === 'function' ? onRequestRerender : () => renderPublicOverviewPage();
  const groupTabs = [
    { key: 'all', name: t('overviewAll'), count: rows.length, color: '' },
    ...backendGroups.map((g) => ({ key: g.key, name: g.name, count: g.count, color: g.color, purpose: g.purpose })),
  ];
  app.innerHTML = `
    <section class="public-overview-page starship-console-page overview-layout-v2">
      <div class="public-overview-floating-topbar overview-compact-topbar" aria-label="资产总览导航与显示设置">
        <div class="overview-compact-heading">
          <h1>${t('overviewTitle')}</h1>
          <span>${t('dataUpdated')}：${updatedAtText} · ${summary.status.total} ${t('overviewNodes')} · ${backendGroups.length} ${t('overviewGroups')}</span>
        </div>
        <a class="public-overview-back" href="/">${t('back')}</a>
        <div class="detail-page-tools public-overview-tools">
          <button class="theme-toggle" id="themeToggle" type="button" aria-label="${t('themeAria')}">
            <span id="themeIcon">☾</span><span id="themeLabel">${document.documentElement.getAttribute('data-theme') === 'light' ? t('daylight') : t('bridge')}</span>
          </button>
          <select class="language-select" id="languageSelect" aria-label="${t('langAria')}">
            ${Object.entries(LANGUAGE_PACKS).map(([code, pack]) => `<option value="${code}" ${currentLanguage === code ? 'selected' : ''}>${pack.name}</option>`).join('')}
          </select>
          <div class="currency-switch detail-currency-switch">
            <button class="currency-btn ${state.currency === 'CNY' ? 'active' : ''}" data-currency="CNY">CNY</button>
            <button class="currency-btn ${state.currency === 'USD' ? 'active' : ''}" data-currency="USD">USD</button>
            <button class="currency-btn ${state.currency === 'EUR' ? 'active' : ''}" data-currency="EUR">EUR</button>
          </div>
          <div class="rate-display" id="rateDisplay"></div>
        </div>
      </div>

      <div class="overview-group-filter" role="tablist" aria-label="按后台分组筛选节点资产">
        ${groupTabs.map((tab) => {
          const active = tab.key === activeGroup;
          const colorStyle = tab.color ? ` style="--group-color:${escText(tab.color)}"` : '';
          const title = tab.purpose ? ` title="${escText(tab.purpose)}"` : '';
          return `<button type="button" class="overview-group-tab ${active ? 'is-active' : ''}" role="tab" aria-selected="${active ? 'true' : 'false'}" data-group-key="${escText(tab.key)}"${colorStyle}${title}><span>${escText(tab.name)}</span><b>${tab.count}</b></button>`;
        }).join('')}
      </div>

      ${renderOverviewSummary(assetSummary, { panel: summary, costView: overviewCostView, expandedDetails: overviewExpandedDetails })}

      ${renderOverviewControls(activeStatus, activeSort, statusCounts)}

      <div class="public-overview-main-grid">
        <section class="public-overview-primary" aria-label="节点列表">
          <div class="public-overview-flat-list" id="overviewGroupedList">
            ${renderFlatNodeList(filteredNodes, activeMeta)}
          </div>
        </section>


      </div>

      ${renderOverviewNetworkTable(rows, { collapsed: true })}
    </section>`;

  updateRateDisplay();

  app.querySelectorAll('[data-overview-cost-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const view = button.getAttribute('data-overview-cost-view');
      if (!['total', 'region', 'provider'].includes(view)) return;
      overviewCostView = view;
      requestRerender();
    });
  });

  app.querySelectorAll('.overview-group-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.getAttribute('data-group-key');
      const key = value === 'all' || buildBackendGroups(Array.isArray(state.servers) ? state.servers : []).some((group) => group.key === value) ? value : 'all';
      saveOverviewGroupFilter(key);
      requestRerender();
    });
  });

  for (const [attribute, storageKey, keys, fallback] of [
    ['data-overview-status', OVERVIEW_STATUS_FILTER_KEY, OVERVIEW_STATUS_KEYS, 'all'],
    ['data-overview-sort', OVERVIEW_SORT_KEY, OVERVIEW_SORT_KEYS, 'default'],
  ]) {
    app.querySelectorAll(`[${attribute}]`).forEach((button) => {
      button.addEventListener('click', () => {
        saveOverviewChoice(localStorage, storageKey, button.getAttribute(attribute), keys, fallback);
        requestRerender();
      });
    });
  }

  app.querySelectorAll('.public-overview-panel-fold').forEach((panel) => {
    const btn = panel.querySelector('.public-overview-panel-toggle');
    btn?.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      const chevron = btn.querySelector('.public-overview-panel-chevron');
      if (chevron) chevron.textContent = open ? '▾' : '▸';
    });
  });

  const networkToggle = app.querySelector('.overview-network-table-toggle');
  networkToggle?.addEventListener('click', () => {
    const table = app.querySelector('.overview-network-table');
    if (!table) return;
    const open = table.classList.toggle('is-collapsed') === false;
    networkToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const chevron = networkToggle.querySelector('.public-overview-panel-chevron');
    if (chevron) chevron.textContent = open ? '▾' : '▸';
  });

  app.querySelectorAll('.public-overview-card').forEach((card) => {
    overviewCardDisposers.push(bindOverviewCardEvents(card, {
      navigate: (href) => { destroyPublicOverviewPage(); window.location.href = href; },
      openCalculator: openPremiumCalculator,
    }));
  });
  mountOverviewPing(app, filteredNodes.map((server) => server.id));
}


function openPremiumCalculator({ id, name, base }) {
  let modal = document.getElementById('premiumCalcModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.className = 'premium-calc-modal';
    modal.id = 'premiumCalcModal';
    modal.hidden = true;
    document.body.appendChild(modal);
  }
  const safeName = escText(name || '未命名节点');
  const baseValue = Math.max(0, Number(base || 0));
  modal.hidden = false;
  modal.innerHTML = `
    <div class="premium-calc-backdrop" aria-hidden="true"></div>
    <section class="premium-calc-card" role="dialog" aria-modal="true" aria-label="VPS 溢价折价计算器">
      <button class="premium-calc-close" type="button" data-close="button" aria-label="关闭计算器">×</button>
      <div class="premium-calc-kicker">VPS PRICE ADJUSTER</div>
      <h2>溢价 / 折价计算器</h2>
      <p class="premium-calc-node">${safeName}</p>
      <div class="premium-calc-base"><span>剩余价值底数</span><strong id="premiumBaseText">${toDisplay(baseValue)}</strong></div>
      <div class="premium-calc-grid">
        <label><span>溢价/折价比例（%）</span><input id="premiumRatioInput" type="number" step="0.1" value="0" placeholder="例如 20 或 -15"></label>
        <label><span>最终金额</span><input id="premiumFinalInput" type="number" step="1" value="${Math.round(baseValue)}" placeholder="也可直接输入成交价"></label>
      </div>
      <div class="premium-calc-result">
        <div><span>按比例结果</span><strong id="premiumFinalText">${toDisplay(baseValue)}</strong></div>
        <div><span>反推比例</span><strong id="premiumRatioText">0.0%</strong></div>
      </div>
      <div class="premium-calc-note">公式：最终金额 = 剩余价值 × (1 + 比例/100)。比例可为负数，即折价。</div>
    </section>`;

  const ratioInput = modal.querySelector('#premiumRatioInput');
  const finalInput = modal.querySelector('#premiumFinalInput');
  const finalText = modal.querySelector('#premiumFinalText');
  const ratioText = modal.querySelector('#premiumRatioText');
  const syncFromRatio = () => {
    const ratio = Number(ratioInput.value || 0);
    const final = Math.max(0, baseValue * (1 + ratio / 100));
    finalInput.value = String(Math.round(final));
    finalText.textContent = toDisplay(final);
    ratioText.textContent = `${ratio.toFixed(1)}%`;
  };
  const syncFromFinal = () => {
    const final = Math.max(0, Number(finalInput.value || 0));
    const ratio = baseValue > 0 ? ((final / baseValue) - 1) * 100 : 0;
    ratioInput.value = ratio.toFixed(1);
    finalText.textContent = toDisplay(final);
    ratioText.textContent = `${ratio.toFixed(1)}%`;
  };
  const closePremiumCalculator = () => {
    modal.hidden = true;
    modal.replaceChildren();
  };
  modal.onclick = (event) => {
    event.stopPropagation();
  };
  modal.querySelector('.premium-calc-close')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    closePremiumCalculator();
  });
  modal.querySelector('.premium-calc-card')?.addEventListener('click', (event) => event.stopPropagation());
  ratioInput?.addEventListener('input', syncFromRatio);
  finalInput?.addEventListener('input', syncFromFinal);
}
