import { state } from '../store/state.js';
import { LANGUAGE_PACKS, currentLanguage, t } from '../core/preferences.js';
import { toDisplay, calcResidualValue, getMonthlyPrice, sourceAmountToCny, getSourceCurrency, updateRateDisplay } from '../utils/currency.js';
import { getTrafficPct } from '../utils/traffic.js';
import { normalizePublicServer } from '../services/serverGroups.js';

const OVERVIEW_GROUP_FILTER_KEY = 'vps_overview_group_filter';

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

function summarizeMoonPanel(servers = []) {
  const rows = Array.isArray(servers) ? servers : [];
  const status = { total: rows.length, online: 0, warn: 0, offline: 0 };
  const expiry = { today: [], d3: [], d7: [] };
  const badNodes = [];
  const byRegion = new Map();
  const byProvider = new Map();
  let monthlyActual = 0;
  let yearlyActual = 0;

  for (const s of rows) {
    const cls = classifyStatus(s.status);
    status[cls] += 1;

    const monthlyEq = Number(getMonthlyPrice(s) || 0);
    const sourcePriceCny = sourceAmountToCny(s.price, getSourceCurrency(s));
    monthlyActual += monthlyEq;
    yearlyActual += monthlyEq * 12;

    const regionKey = s.location || s.city || s.region || s.country || t('unknownRegion');
    byRegion.set(regionKey, (byRegion.get(regionKey) || 0) + monthlyEq);
    const providerKey = s.provider || s.provider_guess || t('unknownProvider');
    byProvider.set(providerKey, (byProvider.get(providerKey) || 0) + monthlyEq);

    const d = daysUntilExpiry(s.expiry);
    if (d != null) {
      if (d === 0) expiry.today.push(s);
      if (d >= 0 && d <= 3) expiry.d3.push(s);
      if (d >= 0 && d <= 7) expiry.d7.push(s);
    }

    const pct = Number(getTrafficPct(s) || 0);
    if (cls !== 'online' || pct >= 85) badNodes.push({ server: s, pct, cls });
  }

  const sortCost = (map) => Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4);
  badNodes.sort((a, b) => (a.cls === 'offline' ? -1 : 0) - (b.cls === 'offline' ? -1 : 0) || b.pct - a.pct);

  return {
    status,
    expiry,
    cost: {
      monthlyActual,
      yearlyActual,
      byRegion: sortCost(byRegion),
      byProvider: sortCost(byProvider),
    },
    badNodes: badNodes.slice(0, 6),
  };
}

function mountDisplayPage() {
  document.body.classList.remove('front-login-page-mode');
  const app = document.getElementById('pageRoot');
  app.innerHTML = `
    <section class="display-page-fullscreen globe-only-page" id="page-globe">
      <div id="globe-container" class="display-globe-fullscreen immersive-globe-canvas-wrap three-globe-host"></div>
      <div class="photo-space-showcase" aria-hidden="true">
        <div class="photo-nebula-field"></div>
        <div class="photo-sun-star"></div>
        <div class="starship-gltf-stage" id="starship-gltf-stage"></div>
      </div>
      <div class="globe-overlay-layer">
        <div id="globeSunMount"></div>
        <div class="globe-tooltip" id="globeTooltip"></div>
        <div class="globe-moon-root" id="globeMoonRoot"><div id="globeMoonPanel"></div></div>      </div>
    </section>`;
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

function renderOverviewMetric(label, value) {
  const pct = value == null ? 0 : value;
  const text = value == null ? '—' : `${value.toFixed(0)}%`;
  return `<span class="overview-metric ${value == null ? 'is-missing' : ''}" style="--pct:${pct.toFixed(0)}"><b>${label}</b><strong class="overview-metric-value">${text}</strong><i></i></span>`;
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
  const prefix = opts.short ? `${day}日重置` : `每月 ${day} 日重置`;
  return opts.next === false ? prefix : `${prefix} · 下次 ${nextTrafficResetDateLabel(day)}`;
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

function renderCompactEmpty(text) {
  return `<div class="overview-empty-inline">${escText(text)}</div>`;
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

function renderOverviewNodeCard(s) {
  const cpuValue = overviewMetricValue(s, 'cpu_use');
  const ramValue = overviewMetricValue(s, 'ram_use');
  const diskValue = overviewMetricValue(s, 'disk_use');
  const trafficRaw = getTrafficPct(s);
  const trafficValue = trafficRaw == null || trafficRaw === '' ? null : Math.max(0, Math.min(100, Number(trafficRaw)));
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
  return `
    <article class="public-overview-card is-dense status-${statusCls}${master ? ' is-master' : ''}" data-id="${safeId}" data-group-key="${escText(group.id || `name:${group.name}`)}" role="link" tabindex="0" aria-label="${safeDisplayName}"${groupStyle}>
      <div class="public-overview-head">
        <div><span class="public-overview-flag">${safeFlag}</span><strong>${safeDisplayName}</strong>${master ? `<em class="overview-master-badge">${t('overviewMaster')}</em>` : ''}</div>
        <div class="public-overview-actions"><button class="public-money-btn" type="button" data-id="${safeId}" data-base="${baseValue}" data-name="${safeDisplayName}" aria-label="${safeDisplayName}">¥</button><span class="public-overview-status is-${statusCls}">${t(statusCls)}</span></div>
      </div>
      <div class="public-overview-meta"><span class="overview-group-chip">${escText(group.name)}</span> · ${safeProvider} · ${safeLocation}</div>
      <div class="public-overview-grid">
        ${renderOverviewMetric('CPU', cpuValue)}
        ${renderOverviewMetric('RAM', ramValue)}
        ${renderOverviewMetric('DISK', diskValue)}
        ${renderOverviewMetric('TRAF', Number.isFinite(trafficValue) ? trafficValue : null)}
      </div>
    </article>`;
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
  return `${hint}<div class="public-overview-list" id="overviewNodeGrid">${nodes.map(renderOverviewNodeCard).join('')}</div>`;
}

export function renderPublicOverviewPage() {
  const app = document.getElementById('pageRoot');
  const rows = Array.isArray(state.servers) ? state.servers : [];
  const summary = summarizeMoonPanel(rows);
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
  const filteredNodes = collectFilteredNodes(backendGroups, activeGroup);
  const filteredCount = filteredNodes.length;
  const groupTabs = [
    { key: 'all', name: t('overviewAll'), count: rows.length, color: '' },
    ...backendGroups.map((g) => ({ key: g.key, name: g.name, count: g.count, color: g.color, purpose: g.purpose })),
  ];
  const expSoonItems = summary.expiry.d7.slice(0, 12).map((s) => `<li><b>${escText(s.name)}</b><span>${daysUntilExpiry(s.expiry)} ${t('overviewExpiryIn')}</span></li>`).join('');
  const badNodeItems = summary.badNodes.slice(0, 12).map(({ server, pct, cls }) => `<li><b>${escText(server.name)}</b><span>${cls === 'offline' ? t('offline') : `${t('overviewTraffic')} ${pct.toFixed(0)}%`}</span></li>`).join('');
  const byRegion = summary.cost.byRegion.map(([k, v]) => `<li><b>${escText(k)}</b><span>¥${Math.round(v)}</span></li>`).join('');
  const byProvider = summary.cost.byProvider.map(([k, v]) => `<li><b>${escText(k)}</b><span>¥${Math.round(v)}</span></li>`).join('');
  const hasExpiry = summary.expiry.d7.length > 0;
  const hasAbnormal = summary.badNodes.length > 0;
  const hasCostSplit = summary.cost.byRegion.length > 0 || summary.cost.byProvider.length > 0;

  app.innerHTML = `
    <section class="public-overview-page starship-console-page overview-layout-p1">
      <div class="public-overview-floating-topbar" aria-label="资产总览导航与显示设置">
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

      <div class="public-overview-hero is-compact">
        <div class="public-overview-hero-copy">
          <div class="public-overview-kicker">${t('overviewKicker')}</div>
          <h1>${t('overviewTitle')}</h1>
          <div class="public-overview-meta-bar">
            <span>${t('dataUpdated')}：${updatedAtText}</span>
            <span class="overview-hero-count">${summary.status.total} ${t('overviewNodes')} · ${backendGroups.length} ${t('overviewGroups')}</span>
          </div>
        </div>
        <figure class="public-overview-visual is-compact" aria-label="资产网络主视觉">
          <img src="/assets/custom/overview-visual-transparent.png" alt="${t('overviewKicker')}" loading="eager" decoding="async" />
        </figure>
      </div>

      <div class="public-overview-kpi-strip" role="group" aria-label="资产关键指标">
        <div class="kpi-item"><span>${t('totalNodes')}</span><strong>${summary.status.total}</strong></div>
        <div class="kpi-item is-online"><span>${t('online')}</span><strong>${summary.status.online}</strong></div>
        <div class="kpi-item is-warn"><span>${t('warn')}</span><strong>${summary.status.warn}</strong></div>
        <div class="kpi-item is-offline"><span>${t('offline')}</span><strong>${summary.status.offline}</strong></div>
        <div class="kpi-item"><span>${t('monthlyTotalCost')}</span><strong>${toDisplay(summary.cost.monthlyActual)}</strong></div>
        <div class="kpi-item ${hasExpiry ? 'is-alert' : ''}"><span>${t('within7Days')}</span><strong>${summary.expiry.d7.length}</strong></div>
      </div>

      <div class="overview-group-filter" role="tablist" aria-label="按后台分组筛选节点资产">
        ${groupTabs.map((tab) => {
          const active = tab.key === activeGroup;
          const colorStyle = tab.color ? ` style="--group-color:${escText(tab.color)}"` : '';
          const title = tab.purpose ? ` title="${escText(tab.purpose)}"` : '';
          return `<button type="button" class="overview-group-tab ${active ? 'is-active' : ''}" role="tab" aria-selected="${active ? 'true' : 'false'}" data-group-key="${escText(tab.key)}"${colorStyle}${title}><span>${escText(tab.name)}</span><b>${tab.count}</b></button>`;
        }).join('')}
      </div>

      <div class="public-overview-main-grid ${filteredCount >= 4 || rows.length >= 4 ? 'is-many-nodes' : 'is-few-nodes'}">
        <section class="public-overview-primary" aria-label="节点列表">
          <div class="public-overview-section-head">
            <h2>${t('overviewNodeAssets')}</h2>
            <span>${filteredCount} ${t('overviewNodes')} · ${activeGroup === 'all' ? t('overviewFlatLayout') : `${t('overviewFilter')}：${escText(activeMeta.name)}`} · ${t('overviewMasterTop')}</span>
          </div>
          <div class="public-overview-flat-list" id="overviewGroupedList">
            ${renderFlatNodeList(filteredNodes, activeMeta)}
          </div>
        </section>

        <aside class="public-overview-side" aria-label="运营摘要">
          <section class="public-overview-panel public-overview-panel-fold ${hasExpiry ? 'open is-alert' : 'is-empty'}" data-panel="expiry">
            <button class="public-overview-panel-toggle" type="button" aria-expanded="${hasExpiry ? 'true' : 'false'}">
              <span class="public-overview-panel-title">${t('expiringNodes')} · ${summary.expiry.d7.length}</span>
              <span class="public-overview-panel-chevron">${hasExpiry ? '▾' : '▸'}</span>
            </button>
            <div class="public-overview-panel-body">
              ${expSoonItems ? `<ul class="public-overview-mini-list">${expSoonItems}</ul>` : renderCompactEmpty(t('noExpiring'))}
            </div>
          </section>

          <section class="public-overview-panel public-overview-panel-fold ${hasAbnormal ? 'open is-alert' : 'is-empty'}" data-panel="abnormal">
            <button class="public-overview-panel-toggle" type="button" aria-expanded="${hasAbnormal ? 'true' : 'false'}">
              <span class="public-overview-panel-title">${t('abnormalNodes')} · ${summary.badNodes.length}</span>
              <span class="public-overview-panel-chevron">${hasAbnormal ? '▾' : '▸'}</span>
            </button>
            <div class="public-overview-panel-body">
              ${badNodeItems ? `<ul class="public-overview-mini-list">${badNodeItems}</ul>` : renderCompactEmpty(t('noAbnormal'))}
            </div>
          </section>

          <section class="public-overview-panel ${hasCostSplit ? '' : 'is-empty'}">
            <div class="public-overview-panel-title">${t('monthlyByRegion')}</div>
            <div class="public-overview-panel-body always-open">
              ${byRegion ? `<ul class="public-overview-mini-list">${byRegion}</ul>` : renderCompactEmpty(t('noData'))}
            </div>
          </section>

          <section class="public-overview-panel ${hasCostSplit ? '' : 'is-empty'}">
            <div class="public-overview-panel-title">${t('monthlyByProvider')}</div>
            <div class="public-overview-panel-body always-open">
              ${byProvider ? `<ul class="public-overview-mini-list">${byProvider}</ul>` : renderCompactEmpty(t('noData'))}
            </div>
          </section>
        </aside>
      </div>

      ${renderOverviewNetworkTable(rows, { collapsed: true })}
    </section>`;

  updateRateDisplay();

  app.querySelectorAll('.overview-group-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-group-key') || 'all';
      saveOverviewGroupFilter(key);
      // re-render keeps page state simple and consistent with 10s refresh
      renderPublicOverviewPage();
    });
  });

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

  app.querySelectorAll('.public-money-btn').forEach((btn) => {
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPremiumCalculator({
        id: btn.dataset.id,
        name: btn.dataset.name,
        base: Number(btn.dataset.base || 0),
      });
    });
  });

  app.querySelectorAll('.public-overview-card').forEach((card) => {
    const openDetail = () => {
      const id = card.getAttribute('data-id');
      if (id) window.location.href = `/?server=${id}`;
    };
    card.addEventListener('click', openDetail);
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        openDetail();
      }
    });
  });
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
