import './globals/dashboardGlobals.js';
import { login as publicLogin, getOAuthProviders, oauthLoginUrl, verifyEmailToken, resetPasswordWithToken } from './api/auth.js';
import './styles/main.css';
import './styles/detail-starfleet-console.css';

import { state } from './store/state.js';
import { listServersPublic } from './api/public.js';
import { CesiumGlobe } from './components/CesiumGlobe.js';
import { ThreeGlobe } from './components/ThreeGlobe.js';
import { StarshipShowcase } from './components/StarshipShowcase.js';
import { TrafficChart } from './components/TrafficChart.js';
import { mountGlobeStarmap } from './components/GlobeStarmapMount.jsx';
import { toDisplay, calcResidualValue, getMonthlyPrice, getBillingMonths, sourceAmountToCny, getSourceCurrency, updateRateDisplay, refreshExchangeRates } from './utils/currency.js';
import { fmtGb, getTrafficPct, getTrafficUsed } from './utils/traffic.js';
import { renderSunBadge, renderMoonPanel } from './ui/sunMoonEntry.js';
import { fetchJson, fetchPing, fetchPingTargetHistory, fetchPingTargets, fetchServerHistory, enrichServersWithIpGeo, normalizeServer } from './services/displayData.js';
import { LANGUAGE_PACKS, applyLanguage, configureLanguageSwitcher, currentLanguage, safeStorageGet, safeStorageRemove, safeStorageSet, setLanguage, setTheme, t, toggleTheme } from './core/preferences.js';
import { renderPublicOverviewPage as renderPublicOverviewPageModule } from './pages/overviewPage.js';
import { detailLoadingShell, renderDetailConsole, renderDetailNotFound } from './pages/detailPage.js';
import { initNetworkTooltip, renderDetailMonitorCharts as renderDetailMonitorChartsModule } from './pages/detailCharts.js';
import { getDetailHistoryDays, getDetailHistoryBucketMinutes, setDetailHistoryDays as setDetailHistoryDaysModule, syncDetailHistoryStateFromStorage } from './detail/historyRange.js';
import { getDetailHeavyRefreshAt, getDetailPingTargetsFetchedAt, setDetailHeavyRefreshAt, setDetailPingTargetsFetchedAt, startDetailRefreshTimer, stopDetailRefreshTimer } from './detail/refreshState.js';
import { detailCache } from './detail/detailCache.js';
import { createDetailPingSampleCache, createDetailTelemetrySampleCache } from './detail/sampleCache.js';
import { getGlobeRuntimeDebug } from './utils/debugState.js';
import { buildClusterFanout, resolveClusterSelection } from './components/globe/vpsClusterInteraction.js';
import { groupClusterMembers } from './services/serverGroups.js';
import { clusterServersByCoordinate } from './components/globe/vpsClusters.js';

let globe = null;
let starshipShowcase = null;
function useSingleRendererGlobe() {
  return new URLSearchParams(window.location.search).get('renderer') === 'single';
}
function applySingleRendererPageMode() {
  if (!useSingleRendererGlobe()) return;
  document.body.classList.add('single-renderer-globe-page');
  const starfield = document.getElementById('starfield');
  if (starfield) {
    starfield.style.display = 'none';
    starfield.setAttribute('aria-hidden', 'true');
  }
}
const serversChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('vps-servers') : null;
window.__DBG__.STATE = state;
const detailCharts = new TrafficChart();
let detailStarmapUnmount = null;
const route = new URLSearchParams(window.location.search);
const loginMode = route.get('login') === '1';
const overviewMode = route.get('overview') === '1';
const loginNext = route.get('next') || '';

const selectedServerId = Number(route.get('server') || 0) || null;

function getOneTimeUrlToken() {
  const hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  const token = hashParams.get('token') || route.get('token') || '';
  if (window.location.hash && hashParams.has('token')) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return token.trim();
}

function renderTokenActionShell(title, message, extra = '') {
  const app = document.getElementById('app');
  document.body.classList.add('front-login-page-mode');
  if (!app) return null;
  app.innerHTML = `
    <main class="standalone-login-scene login-orbital-scene" aria-label="${escapeHtml(title)}">
      <div class="login-cosmos-gradient"></div><div class="login-orbit-grid"></div><div class="login-login-sun"></div>
      <section class="modal front-login-modal astro-login-modal" style="position:relative;margin:12vh auto;max-width:520px">
        <div class="astro-login-kicker">VPS Star Atlas</div>
        <h3 class="modal-title astro-login-title">${escapeHtml(title)}</h3>
        <div id="tokenActionMsg" class="front-login-desc astro-login-desc">${escapeHtml(message)}</div>
        ${extra}
        <div class="front-login-actions" style="margin-top:18px"><a class="add-btn primary" href="/?login=1">返回登录</a></div>
      </section>
    </main>`;
  return app.querySelector('#tokenActionMsg');
}

async function handleEmailVerificationRoute() {
  const token = getOneTimeUrlToken();
  const msg = renderTokenActionShell('邮箱验证', token ? '正在验证邮箱…' : '验证链接缺少 token');
  if (!token || !msg) return;
  try {
    const res = await verifyEmailToken(token);
    msg.textContent = res.msg || '邮箱验证成功，现在可以登录了';
  } catch (e) {
    msg.textContent = e.message || '验证失败，请重新申请验证邮件';
  }
}

function handlePasswordResetRoute() {
  const token = getOneTimeUrlToken();
  const form = token ? `
    <div class="front-login-form" style="margin-top:18px">
      <input id="resetPass1" class="front-login-input" type="password" autocomplete="new-password" placeholder="新密码" />
      <input id="resetPass2" class="front-login-input" type="password" autocomplete="new-password" placeholder="再次输入新密码" />
      <button id="resetPassSubmit" class="add-btn primary" type="button">设置新密码</button>
    </div>` : '';
  const msg = renderTokenActionShell('重置密码', token ? '请输入新密码。' : '重置链接缺少 token', form);
  const btn = document.getElementById('resetPassSubmit');
  if (!token || !btn || !msg) return;
  btn.addEventListener('click', async () => {
    const p1 = document.getElementById('resetPass1')?.value || '';
    const p2 = document.getElementById('resetPass2')?.value || '';
    if (!p1 || p1 !== p2) { msg.textContent = '两次密码不一致'; return; }
    btn.disabled = true;
    msg.textContent = '正在提交…';
    try {
      const res = await resetPasswordWithToken(token, p1);
      msg.textContent = res.msg || '密码重置成功，请使用新密码登录';
    } catch (e) {
      msg.textContent = e.message || '重置失败，请重新申请链接';
      btn.disabled = false;
    }
  });
}


configureLanguageSwitcher({
  isOverviewMode: () => overviewMode,
  getSelectedServerId: () => selectedServerId,
  renderOverview: () => renderPublicOverviewPage(),
  renderDetail: (serverId) => renderDetailPage(serverId),
});

let detailHistoryDays = syncDetailHistoryStateFromStorage(0);
window.__DBG__.DETAIL_HISTORY_DAYS = detailHistoryDays; // debug/read-only compatibility
function setDetailHistoryDays(days) {
  detailHistoryDays = setDetailHistoryDaysModule(days, renderDetailPage);
}

function setCurrency(currency) {
  state.currency = currency;
  document.querySelectorAll('.currency-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.currency || btn.textContent.trim()) === currency);
  });
  updateRateDisplay();
  if (selectedServerId) renderDetailPage(selectedServerId);
  else if (overviewMode) renderPublicOverviewPage();
}

function bindTopbarEvents(root = document) {
  const themeButton = root.querySelector?.('#themeToggle');
  themeButton?.addEventListener('click', (event) => {
    event.preventDefault();
    toggleTheme();
  });
  const languageSelect = root.querySelector?.('#languageSelect');
  languageSelect?.addEventListener('change', (event) => {
    setLanguage(event.target?.value);
  });
  root.querySelectorAll?.('.currency-btn[data-currency]').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      setCurrency(button.dataset.currency);
    });
  });
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
        <div class="globe-focus-badge" id="globeFocusBadge"></div>
        <div class="globe-tooltip" id="globeTooltip"></div>
        <div class="globe-moon-root" id="globeMoonRoot"><div id="globeMoonPanel"></div></div>
      </div>
    </section>`;
}

function renderPublicOverviewPage() {
  const result = renderPublicOverviewPageModule();
  bindTopbarEvents(document);
  return result;
}
function initStarshipShowcase() {
  if (useSingleRendererGlobe()) {
    const showcase = document.querySelector('.photo-space-showcase');
    if (showcase) showcase.style.display = 'none';
    if (starshipShowcase) { starshipShowcase.destroy(); starshipShowcase = null; }
    return;
  }
  const globeHost = document.getElementById('globe-container');
  const showcase = document.querySelector('.photo-space-showcase');
  if (globeHost && showcase && showcase.parentElement !== globeHost) {
    globeHost.appendChild(showcase);
    showcase.classList.add('is-globe-background-layer');
  }
  const stage = document.getElementById('starship-gltf-stage');
  if (!stage) return;
  if (starshipShowcase) starshipShowcase.destroy();
  starshipShowcase = new StarshipShowcase(stage, {
    modelUrl: '/globe/star_trek_dsc_enterprise_user.glb',
  });
  window.__DBG__.starshipShowcase = starshipShowcase;
}

let clusterPicker = null;

function closeClusterInteraction() {
  globe?.clearClusterFanout?.();
  clusterPicker?.remove();
  clusterPicker = null;
}

function navigateToServer(server) {
  if (server?.id != null) window.location.href = `/?server=${server.id}`;
}

function showClusterMemberPicker(members) {
  clusterPicker?.remove();
  const panel = document.createElement('section');
  panel.className = 'cluster-member-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', '同一位置的节点');
  const heading = document.createElement('h2');
  heading.textContent = `同一位置的 ${members.length} 个节点`;
  panel.appendChild(heading);
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'cluster-picker-close'; closeButton.textContent = '关闭';
  closeButton.addEventListener('click', closeClusterInteraction);
  panel.appendChild(closeButton);
  for (const group of groupClusterMembers(members)) {
    const groupHeading = document.createElement('h3'); groupHeading.textContent = group.name; panel.appendChild(groupHeading);
    if (group.purpose) { const purposeHeading = document.createElement('h4'); purposeHeading.textContent = group.purpose; panel.appendChild(purposeHeading); }
    const list = document.createElement('ul');
    for (const member of group.members) {
        const item = document.createElement('li');
        const name = document.createElement('span'); name.textContent = String(member.name || `VPS-${member.id || ''}`);
        const select = document.createElement('button'); select.type = 'button'; select.textContent = '查看详情';
        select.addEventListener('click', () => navigateToServer(member));
        item.append(name, select); list.appendChild(item);
    }
    panel.appendChild(list);
  }
  document.body.appendChild(panel);
  clusterPicker = panel;
  closeButton.focus();
}

function showClusterFanout(cluster, members) {
  const fanout = buildClusterFanout({ lat: cluster.lat, lon: cluster.lon, members })
    .map((item) => ({ ...item, centerLat: cluster.lat, centerLon: cluster.lon }));
  globe?.expandClusterFanout?.({ clusterKey: cluster.key, lat: cluster.lat, lon: cluster.lon, fanout, onMemberClick: navigateToServer });
}

function handleGlobeNodeSelection(server, clusterMembers, cluster) {
  const canonicalCluster = clusterServersByCoordinate(state.servers)
    .find((candidate) => candidate.members.some((member) => String(member.id) === String(server?.id)));
  const inferredMembers = canonicalCluster?.members || (clusterMembers?.length ? clusterMembers : [server]);
  const selection = resolveClusterSelection(inferredMembers);
  if (selection.type === 'navigate') { closeClusterInteraction(); navigateToServer(selection.member); return; }
  if (clusterPicker) { closeClusterInteraction(); return; }
  // Labels and Cesium picks only carry lightweight cluster metadata. Always use the
  // canonical live cluster for a valid centroid before creating visual-only fanout.
  const fanoutCluster = canonicalCluster || cluster;
  if (typeof globe?.expandClusterFanout === 'function' && fanoutCluster?.valid) showClusterFanout(fanoutCluster, selection.members);
  showClusterMemberPicker(selection.members);
}

function getGlobe() {
  applySingleRendererPageMode();
  if (globe) return globe;
  if (useSingleRendererGlobe() || new URLSearchParams(window.location.search).get('renderer') === 'three') {
    globe = new ThreeGlobe('#globe-container', state.servers, {
      enableStarship: useSingleRendererGlobe(),
      starshipModelUrl: '/globe/star_trek_dsc_enterprise_user.glb',
      defaultDistance: 2.35,
      minDistance: 1.55,
      maxDistance: 5.8,
      onNodeClick: handleGlobeNodeSelection,
      onBlankClick: closeClusterInteraction,
    });
    globe.start();
    getGlobeRuntimeDebug().globeMode = 'three-fallback';
  } else {
    globe = new CesiumGlobe('#globe-container', state.servers, { onNodeClick: handleGlobeNodeSelection, onBlankClick: closeClusterInteraction });
    getGlobeRuntimeDebug().globeMode = 'cesium-default-no-ion-terrain';
  }
  renderSunBadge();
  renderMoonPanel();
  initStarshipShowcase();
  window.__DBG__.globe = globe;
  return globe;
}

function initGlobe() {
  const instance = getGlobe();
  instance.updateServers(state.servers);
  renderSunBadge();
  renderMoonPanel();
  initStarshipShowcase();
}

const API_ROOT = window.__DBG__.API_ROOT || (location.port === "5000" ? `${location.protocol}//${location.hostname}:5000` : location.origin);


function renderFrontLoginPage() {
  const app = document.getElementById('app');
  document.body.classList.add('front-login-page-mode');
  if (app) {
    app.innerHTML = `
      <main class="standalone-login-scene login-orbital-scene" aria-label="VPS 星图登录界面">
        <div class="login-cosmos-gradient"></div>
        <div class="login-orbit-grid"></div>
        <div class="login-dawn-planet">
          <span class="login-planet-glow"></span>
          <span class="login-planet-surface"></span>
          <span class="login-planet-night"></span>
        </div>
        <div class="login-orbital-path path-a"></div>
        <div class="login-orbital-path path-b"></div>
        <div class="login-login-sun"></div>
        <div class="login-noise-vignette"></div>
      </main>`;
  }
  const overlay = ensureFrontLoginOverlay();
  overlay.classList.add('open', 'standalone');
}


function statusLabel(status) {
  return status === 'online' ? '在线' : status === 'warn' ? '波动' : '离线';
}

function metric(label, value, suffix = '') {
  return `<div class="metric-card"><span>${label}</span><strong>${value}${suffix}</strong></div>`;
}

function escText(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function kbpsToMbps(kb) {
  const n = Number(kb);
  return Number.isFinite(n) && n > 0 ? (n * 8 / 1024) : 0;
}

function fmtAxisMbps(value) {
  const n = Number(value) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}G`;
  if (n >= 10) return `${n.toFixed(0)}M`;
  if (n >= 1) return `${n.toFixed(1).replace(/\.0$/, '')}M`;
  if (n > 0) return `${Math.round(n * 1000)}K`;
  return '0';
}

function fmtAxis(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (Math.abs(n) >= 10) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}


function kbpsToMBs(kb) {
  const n = Number(kb);
  return Number.isFinite(n) && n > 0 ? (n / 1024) : 0;
}

function fmtAxisMBs(value) {
  const n = Number(value) || 0;
  if (n <= 0) return '0';
  if (n < 1) return `${Math.round(n * 1024)}K`;
  return `${Math.round(n)}M`;
}

function rateAxisTicksMBs(maxMBs) {
  // Fixed user-requested ladder: 0,50K,100K,200K,500K,1M,50M,100M,200M,500M,1000M.
  // Internally this chart is MB/s; K labels are represented as fractions of 1 MB/s.
  const ladder = [0, 50/1024, 100/1024, 200/1024, 500/1024, 1, 50, 100, 200, 500, 1000];
  const needed = Math.max(1, Number(maxMBs) || 0);
  const top = ladder.find(v => v >= needed * 1.08) || 1000;
  return ladder.filter(v => v <= top || v === 0);
}

function rateStepPosition(value, ticks) {
  const v = Math.max(0, Number(value) || 0);
  if (!ticks.length || v <= ticks[0]) return 0;
  for (let i = 1; i < ticks.length; i += 1) {
    if (v <= ticks[i]) {
      const prev = ticks[i - 1];
      const next = ticks[i];
      const ratio = next > prev ? (v - prev) / (next - prev) : 0;
      return (i - 1 + Math.max(0, Math.min(1, ratio))) / Math.max(1, ticks.length - 1);
    }
  }
  return 1;
}


function rowTimeMs(row, fallback = null) {
  const raw = row?.ts || row?.time || row?.timestamp || row?.created_at || row?.date;
  if (!raw) return fallback;
  let text = String(raw).trim();
  // Backend public telemetry emits UTC timestamps without a timezone suffix.
  // Browser Date.parse treats timezone-less ISO strings as local time, which can
  // make data freshness look hours stale. Treat ISO-like telemetry as UTC.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)) text += 'Z';
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : fallback;
}

function normalizeHistory24h(rows = []) {
  const now = Date.now();
  const start = now - 12 * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : [])
    .map((row, idx, arr) => {
      const fallback = NaN;
      return { ...row, __timeMs: rowTimeMs(row, fallback) };
    })
    .filter(row => Number.isFinite(row.__timeMs) && row.__timeMs >= start && row.__timeMs <= now + 60 * 1000)
    .sort((a, b) => a.__timeMs - b.__timeMs);
}

function formatHourTick(ms) {
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTooltipClock(ms) {
  const d = new Date(ms);
  return d.toLocaleString([], { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatHourTickWithDate(ms) {
  const d = new Date(ms);
  return d.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function normalizeTimelineRows(rows = [], latestRow = null, hours = 12) {
  const start = Date.now() - hours * 60 * 60 * 1000;
  const bucket = new Map();
  const source = Array.isArray(rows) ? rows.slice() : [];
  if (latestRow) {
    const liveTime = latestRow.__timeMs || latestRow.last_probe_at || latestRow.last_seen_at || latestRow.updated_at || latestRow.created_at;
    if (liveTime) source.push({ ...latestRow, created_at: liveTime });
  }
  source.forEach((row, idx) => {
    const parsed = rowTimeMs(row, NaN);
    if (!Number.isFinite(parsed) || parsed < start) return;
    const key = String(Math.round(parsed / 1000));
    const prev = bucket.get(key);
    if (!prev || idx > prev.idx) bucket.set(key, { idx, row, t: parsed });
  });
  return Array.from(bucket.values()).sort((a, b) => a.t - b.t).map(({ row, t }) => ({ row, t }));
}

function seriesWindowFromRows(rows = [], key, hours = 12, latestRow = null) {
  const points = normalizeTimelineRows(rows, latestRow, hours)
    .map(({ row, t }) => {
      const raw = row?.[key];
      return { x: t, y: raw == null || raw === '' ? NaN : Number(raw) };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length && latestRow && Number.isFinite(Number(latestRow?.[key]))) {
    const t = rowTimeMs({ ts: latestRow.__timeMs || latestRow.last_probe_at || latestRow.last_seen_at || latestRow.updated_at || latestRow.created_at }, NaN);
    if (Number.isFinite(t)) return [{ x: t, y: Number(latestRow[key]) }];
  }
  return points;
}

function latestTimelineMs(rows = [], latestRow = null) {
  const points = normalizeTimelineRows(rows, latestRow, 24).map(({ t }) => t).filter(Number.isFinite);
  return points.length ? points[points.length - 1] : NaN;
}

function freshnessWindowFromRows(rows = [], hours = 12, latestRow = null) {
  const sorted = normalizeTimelineRows(rows, latestRow, hours).map(({ t }) => t);
  const out = [];
  for (let i = 1; i < sorted.length; i += 1) {
    out.push({ x: sorted[i], y: Math.max(0, (sorted[i] - sorted[i - 1]) / 1000) });
  }
  if (sorted.length === 1) return [];
  return out;
}

function downsampleDisplayPoints(points = [], maxPoints = 720) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const out = [];
  const bucket = Math.ceil(points.length / maxPoints);
  for (let i = 0; i < points.length; i += bucket) {
    const slice = points.slice(i, i + bucket);
    if (!slice.length) continue;
    const first = slice[0];
    const last = slice[slice.length - 1];
    const min = slice.reduce((a, b) => Number(b.y) < Number(a.y) ? b : a, first);
    const max = slice.reduce((a, b) => Number(b.y) > Number(a.y) ? b : a, first);
    for (const p of [first, min, max, last]) {
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out.sort((a, b) => Number(a.x) - Number(b.x));
}

function fitSeriesToRollingAxis(points = [], bounds = null, maxPoints = 720) {
  const clean = (Array.isArray(points) ? points : [])
    .filter(p => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y)))
    .sort((a, b) => Number(a.x) - Number(b.x));
  if (!clean.length) return clean;
  // Keep real timestamps. Do not stretch sparse/cold-start data to fill the full chart.
  return downsampleDisplayPoints(clean.map(p => ({ ...p, rawX: Number(p.x), x: Number(p.x) })), maxPoints);
}

function telemetryTooltipTime(item) {
  const raw = item?.raw?.rawX ?? item?.raw?.x;
  return Number.isFinite(Number(raw)) ? formatTooltipClock(Number(raw)) : '';
}


function adaptiveRollingBounds(pointGroups = [], hours = 12) {
  const fullSpan = hours * 60 * 60 * 1000;
  const xs = pointGroups.flat().map((point) => Number(point?.x)).filter(Number.isFinite).sort((a, b) => a - b);
  const dataFirst = xs.length ? xs[0] : 0;
  const dataLast = xs.length ? xs[xs.length - 1] : dataFirst;
  const coldMax = dataFirst + fullSpan;
  const rolling = dataLast >= coldMax;
  const min = rolling ? dataLast - fullSpan : dataFirst;
  const max = rolling ? dataLast : coldMax;
  const span = Math.max(1, max - min);
  return {
    min,
    max,
    step: Math.max(60 * 1000, Math.round(span / 4)),
    mode: rolling ? 'rolling-after-full-window' : 'accumulating-from-first-sample',
    dataFirst,
    dataLast,
    dataSpanMs: xs.length ? Math.max(0, dataLast - dataFirst) : 0,
    fullSpanMs: fullSpan,
    elapsedFromFirstMs: Math.max(0, dataLast - dataFirst),
  };
}


function pingTargetsFromRows(rows = [], pingTargetsData = null) {
  const names = new Set();
  const targetRows = Array.isArray(pingTargetsData?.targets) ? pingTargetsData.targets : [];
  for (const t of targetRows) {
    const name = t?.name || t?.label || t?.host || t?.target || t?.domain;
    if (name) names.add(String(name));
  }
  for (const row of rows || []) {
    for (const [k,v] of Object.entries(row || {})) {
      if (/(latency|ping|rtt)/i.test(k) && !/^latency_ms$/i.test(k) && typeof v !== 'object') names.add(k);
    }
  }
  return [...names];
}

function recordLivePingSamples(pingTargetsData = null, fetchedAt = Date.now(), serverId = null) {
  if (pingTargetsData?.unavailable) {
    detailPingSamples.setUnavailable(serverId || pingTargetsData?.server_id);
    return;
  }
  const targets = (Array.isArray(pingTargetsData?.targets) ? pingTargetsData.targets : []).filter(t => t.type !== 'peer');
  const cutoff = fetchedAt - DETAIL_PING_SAMPLE_WINDOW_MS;
  for (const target of targets) {
    const key = String(target?.key || target?.host || target?.label || target?.target || target?.domain || 'unknown');
    const label = target?.label || target?.name || target?.host || target?.target || target?.domain || key;
    const protocol = target?.protocol || 'icmp';
    const lossPct = Number(target?.stats?.loss_pct ?? 0);
    const rows = Array.isArray(target?.results) ? target.results : [];
    const samples = detailPingSamples.ensure(key);
    for (const row of rows) {
      const rawMs = Number(row?.latency_ms);
      if (!row?.success || !Number.isFinite(rawMs)) continue;
      const seq = Number(row?.seq || 1);
      const x = fetchedAt - Math.max(0, rows.length - seq) * 2500;
      const exists = samples.some(p => Math.abs(p.x - x) < 900 && Math.abs(p.rawMs - rawMs) < 0.05);
      if (!exists) samples.push({ x, y: pingStepValue(rawMs), rawMs, success: true, label, key, protocol, lossPct });
    }
    samples.sort((a, b) => a.x - b.x);
    detailPingSamples.prune(key, cutoff);
  }
  detailPingSamples.expose();
  detailPingSamples.saveStored(serverId || pingTargetsData?.server_id);
}

function buildLivePingDatasets(pingTargetsData = null, hours = 12) {
  if (pingTargetsData?.unavailable) return [];
  const targets = Array.isArray(pingTargetsData?.targets) ? pingTargetsData.targets : [];
  const palette = ['#68f6ff','#ffd66b','#ff6b8a','#b7ff7a','#d8a8ff','#7ab8ff','#ff9d4d','#7dffc1','#ff5ef1','#a2ff4d','#4dd8ff','#ffdf4d'];
  const now = Date.now();
  const cutoff = now - Math.max(1, hours) * 60 * 60 * 1000;
  return targets.map((target, idx) => {
    const key = String(target?.key || target?.host || target?.label || target?.target || target?.domain || `target-${idx}`);
    const label = target?.label || target?.name || target?.host || target?.target || target?.domain || `目标 ${idx + 1}`;
    const cached = (detailPingSamples.store[key] || []).filter(p => p.x >= cutoff && Number.isFinite(p.rawMs));
    const data = cached.map(p => ({ ...p, y: pingStepValue(p.rawMs), label, protocol: p.protocol || target?.protocol }));
    return {
      label,
      borderColor: palette[idx % palette.length],
      backgroundColor: idx === 0 ? 'rgba(104,246,255,0.04)' : 'rgba(255,214,107,0.04)',
      fill: false,
      showLine: true,
      spanGaps: false,
      tension: 0.12,
      pointRadius: 0,
      pointHoverRadius: 6,
      borderWidth: 3,
      data,
    };
  }).filter(ds => ds.data.length);
}

function buildPersistedPingTargetDatasets(pingTargetHistoryData = null, hours = 12) {
  if (pingTargetHistoryData?.unavailable) return [];
  const targets = Array.isArray(pingTargetHistoryData?.targets) ? pingTargetHistoryData.targets : [];
  const palette = ['#68f6ff','#ffd66b','#ff6b8a','#b7ff7a','#d8a8ff','#7ab8ff','#ff9d4d','#7dffc1','#ff5ef1','#a2ff4d','#4dd8ff','#ffdf4d'];
  const now = Date.now();
  const cutoff = now - Math.max(1, hours) * 60 * 60 * 1000;
  return targets.map((target, idx) => {
    const label = target?.label || target?.host || target?.key || `目标 ${idx + 1}`;
    const points = Array.isArray(target?.points) ? target.points : [];
    const data = points.map(point => {
      const rawMs = Number(point?.latency_ms ?? point?.rawMs);
      const x = rowTimeMs({ created_at: point?.x || point?.created_at || point?.time || point?.timestamp }, NaN);
      if (!Number.isFinite(rawMs) || !Number.isFinite(x) || x < cutoff || x > now + 60000) return null;
      return { x, y: pingStepValue(rawMs), rawMs, label, key: point?.key || target?.key, protocol: point?.protocol || target?.protocol, success: true, lossPct: point?.loss_pct ?? point?.lossPct ?? 0 };
    }).filter(Boolean).sort((a, b) => a.x - b.x);
    return {
      label,
      borderColor: palette[idx % palette.length],
      backgroundColor: idx === 0 ? 'rgba(104,246,255,0.04)' : 'rgba(255,214,107,0.04)',
      fill: false,
      showLine: true,
      spanGaps: false,
      tension: 0.12,
      pointRadius: 0,
      pointHoverRadius: 6,
      borderWidth: 3,
      data,
    };
  }).filter(ds => ds.data.length);
}

function buildPingDatasets(rows = [], hours = 24, pingTargetsData = null, pingTargetHistoryData = null) {
  if (pingTargetsData?.unavailable || pingTargetHistoryData?.unavailable) return [];
  const norm = normalizeWindowRows(rows, hours);
  const persistedTargetDatasets = buildPersistedPingTargetDatasets(pingTargetHistoryData, hours);
  if (persistedTargetDatasets.length) return persistedTargetDatasets;
  const liveTargetDatasets = buildLivePingDatasets(pingTargetsData, hours);
  if (Array.isArray(pingTargetsData?.targets) && pingTargetsData.targets.length && liveTargetDatasets.length) return liveTargetDatasets;
  const keys = pingTargetsFromRows(norm, pingTargetsData);
  const palette = ['#68f6ff','#ffd66b','#ff6b8a','#b7ff7a','#d8a8ff','#7ab8ff','#ff9d4d','#7dffc1','#ff5ef1','#a2ff4d','#4dd8ff','#ffdf4d'];
  const aliasOf = (row, key) => {
    if (row == null) return null;
    if (row[key] != null) return row[key];
    const lk = String(key).toLowerCase();
    for (const [rk, rv] of Object.entries(row)) {
      if (typeof rv === 'object') continue;
      const rr = String(rk).toLowerCase();
      if (rr === lk) return rv;
      if (rr.replace(/[^a-z0-9]/g,'') === lk.replace(/[^a-z0-9]/g,'')) return rv;
      if (rr.includes(lk) || lk.includes(rr)) return rv;
    }
    return null;
  };
  const historyDatasets = keys.map((key, idx) => ({
    label: key,
    borderColor: palette[idx % palette.length],
    backgroundColor: idx === 0 ? 'rgba(104,246,255,0.04)' : 'rgba(255,214,107,0.04)',
    fill: false,
    tension: 0.12,
    pointRadius: 0,
    borderWidth: 3,
    data: norm.map(r => {
      const raw = aliasOf(r, key);
      if (raw == null || raw === '') return null;
      const rawMs = Number(raw);
      if (!Number.isFinite(rawMs)) return null;
      return { x: r.__timeMs, y: pingStepValue(rawMs), rawMs };
    }).filter(Boolean).filter(p => Number.isFinite(p.rawMs) && Number.isFinite(p.x)).sort((a, b) => a.x - b.x),
  })).filter(ds => ds.data.length);
  return historyDatasets.length ? historyDatasets : [];
}

const PING_AXIS_STEPS_MS = [0, 20, 50, 100, 200, 300, 400, 500];
function pingStepValue(ms) {
  const v = Math.max(0, Math.min(500, Number(ms) || 0));
  const steps = PING_AXIS_STEPS_MS;
  for (let i = 1; i < steps.length; i += 1) {
    if (v <= steps[i]) {
      const prev = steps[i - 1];
      const next = steps[i];
      const ratio = next > prev ? (v - prev) / (next - prev) : 0;
      return (i - 1) + Math.max(0, Math.min(1, ratio));
    }
  }
  return steps.length - 1;
}
function pingStepLabel(pos) {
  const idx = Math.max(0, Math.min(PING_AXIS_STEPS_MS.length - 1, Math.round(Number(pos) || 0)));
  return `${PING_AXIS_STEPS_MS[idx]}ms`;
}

function normalizeWindowRows(rows = [], hours = 12) {
  const now = Date.now();
  const start = now - hours * 60 * 60 * 1000;
  return (Array.isArray(rows) ? rows : [])
    .map((row, idx, arr) => {
      const fallback = NaN;
      return { ...row, __timeMs: rowTimeMs(row, fallback) };
    })
    .filter(row => Number.isFinite(row.__timeMs) && row.__timeMs >= start && row.__timeMs <= now + 60 * 1000)
    .sort((a, b) => a.__timeMs - b.__timeMs);
}

function numericMetricSeries(rows = [], key) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => row?.[key])
    .filter(value => value != null && value !== '')
    .map(Number)
    .filter(Number.isFinite);
}

function accumulatingAxisBoundsFromTimes(times = [], hours = 12, minVisualMs = null) {
  const fullSpan = hours * 60 * 60 * 1000;
  const xs = (Array.isArray(times) ? times : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const dataFirst = xs.length ? xs[0] : 0;
  const dataLast = xs.length ? xs[xs.length - 1] : dataFirst;
  const coldMax = dataFirst + fullSpan;
  const rolling = dataLast >= coldMax;
  const min = rolling ? dataLast - fullSpan : dataFirst;
  const max = rolling ? dataLast : Math.max(coldMax, dataLast + Math.max(0, Number(minVisualMs) || 0));
  return { min, max, mode: rolling ? 'rolling-after-full-window' : 'accumulating-from-first-sample', dataFirst, dataLast, fullSpanMs: fullSpan };
}


function dualRateSparkline(upValues = [], downValues = [], opts = {}) {
  const labels = Array.isArray(opts.labels) ? opts.labels : [];
  const now = Date.now();
  const fullStartMs = now - 12 * 60 * 60 * 1000;
  const upRaw = Array.isArray(upValues) ? upValues : [];
  const downRaw = Array.isArray(downValues) ? downValues : [];
  const n = Math.max(upRaw.length, downRaw.length, labels.length);
  const rows = Array.from({ length: n }).map((_, i) => {
    const fallback = NaN;
    const t = rowTimeMs({ ts: labels[i] }, fallback);
    return { t, up: kbpsToMBs(upRaw[i] || 0), down: kbpsToMBs(downRaw[i] || 0) };
  }).filter(r => Number.isFinite(r.t) && r.t >= fullStartMs && r.t <= now + 60 * 1000)
    .sort((a, b) => a.t - b.t);
  const axis = accumulatingAxisBoundsFromTimes(rows.map(r => r.t), 12);
  const startMs = axis.min;
  const endMs = axis.max;
  const w = 760, h = 238, padL = 78, padR = 20, padT = 18, padB = 34;
  if (rows.length < 3) return `<svg class="mini-linechart mini-linechart-axis network-dual-chart no-live-data" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><text class="empty-label" x="${w/2}" y="${h/2}">暂无12小时吞吐数据</text></svg>`;
  const maxV = Math.max(...rows.flatMap(r => [r.up, r.down]), 1);
  const ticks = rateAxisTicksMBs(maxV);
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  const xOfTime = (t) => padL + Math.max(0, Math.min(1, (t - startMs) / Math.max(1, endMs - startMs))) * plotW;
  const yOf = (v) => h - padB - rateStepPosition(v, ticks) * plotH;
  const pts = (key) => rows.map((r) => `${xOfTime(r.t).toFixed(1)},${yOf(r[key]).toFixed(1)}`).join(' ');
  const upPts = pts('up');
  const downPts = pts('down');
  const firstX = xOfTime(rows[0].t).toFixed(1);
  const lastX = xOfTime(rows[rows.length - 1].t).toFixed(1);
  const gridY = ticks.map(v => `<line class="grid-line" x1="${padL}" y1="${yOf(v).toFixed(1)}" x2="${w-padR}" y2="${yOf(v).toFixed(1)}"></line>`).join('');
  const hourTicks = Array.from({ length: 5 }, (_, i) => startMs + (i / 4) * (endMs - startMs));
  const gridX = hourTicks.map(t => `<line class="grid-line xgrid" x1="${xOfTime(t).toFixed(1)}" y1="${padT}" x2="${xOfTime(t).toFixed(1)}" y2="${h-padB}"></line>`).join('');
  const yLabels = ticks.map(v => `<text class="axis-label axis-y" x="6" y="${Math.max(padT+4, Math.min(h-padB, yOf(v))).toFixed(1)}">${fmtAxisMBs(v)}</text>`).join('');
  const xLabels = hourTicks.map((t, i) => {
    const label = formatHourTick(t);
    const cls = i === 4 ? 'axis-x end' : (i === 2 ? 'axis-x mid' : 'axis-x');
    return `<text class="axis-label ${cls}" x="${xOfTime(t).toFixed(1)}" y="${h-8}">${label}</text>`;
  }).join('');
  return `<svg class="mini-linechart mini-linechart-axis network-dual-chart" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="12小时网络吞吐量">
    ${gridY}${gridX}
    <line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${h-padB}"></line>
    <line class="axis-line" x1="${padL}" y1="${h-padB}" x2="${w-padR}" y2="${h-padB}"></line>
    <polyline class="up-line" points="${upPts}"></polyline><polyline class="down-line" points="${downPts}"></polyline>
    ${yLabels}<text class="axis-label axis-unit" x="6" y="10">12h</text>${xLabels}
  </svg>`;
}

function formatSparkTime(label, fallback) {
  if (!label) return fallback;
  const d = new Date(label);
  if (Number.isFinite(d.getTime())) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return String(label).slice(0, 5);
}

function sparkline(values = [], opts = {}) {
  const isRate = opts.rateAxis === true;
  const labels = Array.isArray(opts.labels) ? opts.labels : [];
  const sourceRows = (Array.isArray(values) ? values : []).map(Number).filter(v => Number.isFinite(v) && v >= 0).slice(-24);
  const rows = isRate ? sourceRows.map(kbpsToMbps) : sourceRows;
  const w = isRate ? 420 : 260, h = isRate ? 156 : 82, padL = isRate ? 58 : 34, padR = 14, padT = 12, padB = isRate ? 26 : 18;
  if (rows.length < 3) {
    return `<svg class="mini-linechart mini-linechart-axis no-live-data" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="暂无实时数据">
      <line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${h-padB}"></line>
      <line class="axis-line" x1="${padL}" y1="${h-padB}" x2="${w-padR}" y2="${h-padB}"></line>
      <text class="axis-label axis-y" x="6" y="${padT+4}">—</text>
      <text class="axis-label axis-y" x="6" y="${h-padB}">0</text>
      <text class="axis-label axis-x" x="${padL}" y="${h-6}">过去</text>
      <text class="axis-label axis-x end" x="${w-padR}" y="${h-6}">现在</text>
      <text class="empty-label" x="${(padL+w-padR)/2}" y="${(padT+h-padB)/2}">暂无实时数据</text>
    </svg>`;
  }
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;
  let min = 0;
  let max = Math.max(...rows, 1);
  let ticks;
  if (isRate) {
    ticks = rateAxisTicks(max);
    max = ticks[ticks.length - 1];
  } else {
    const rawMin = Math.min(...rows);
    const rawMax = Math.max(...rows);
    const range = Math.max(rawMax - rawMin, Math.max(Math.abs(rawMax), 1) * 0.02);
    min = rawMin;
    max = rawMin + range;
    ticks = [max, min + (max - min) / 2, min];
  }
  const yOf = (v) => h - padB - ((v - min) / Math.max(max - min, 1)) * plotH;
  const pts = rows.map((v, i) => {
    const x = padL + (rows.length === 1 ? 0 : (i / (rows.length - 1)) * plotW);
    const y = yOf(v);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const area = `${padL},${h-padB} ${pts.join(' ')} ${w-padR},${h-padB}`;
  const grid = ticks.map((v) => `<line class="grid-line" x1="${padL}" y1="${yOf(v).toFixed(1)}" x2="${w-padR}" y2="${yOf(v).toFixed(1)}"></line>`).join('');
  const yLabels = ticks.map((v) => `<text class="axis-label axis-y" x="6" y="${Math.max(padT+4, Math.min(h-padB, yOf(v))).toFixed(1)}">${isRate ? fmtAxisMbps(v) : fmtAxis(v)}</text>`).join('');
  const midIdx = Math.floor((rows.length - 1) / 2);
  const x0 = formatSparkTime(labels[labels.length - rows.length] || labels[0], '过去');
  const x1 = formatSparkTime(labels[labels.length - rows.length + midIdx] || labels[midIdx], '中段');
  const x2 = formatSparkTime(labels[labels.length - 1], '现在');
  return `<svg class="mini-linechart mini-linechart-axis ${isRate ? 'rate-axis' : ''}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img">
    ${grid}
    <line class="axis-line" x1="${padL}" y1="${padT}" x2="${padL}" y2="${h-padB}"></line>
    <line class="axis-line" x1="${padL}" y1="${h-padB}" x2="${w-padR}" y2="${h-padB}"></line>
    <polygon points="${area}"></polygon><polyline points="${pts.join(' ')}"></polyline>
    ${yLabels}
    ${isRate ? `<text class="axis-label axis-unit" x="6" y="8">Mbps</text>` : ''}
    <text class="axis-label axis-x" x="${padL}" y="${h-6}">${escText(x0)}</text>
    <text class="axis-label axis-x mid" x="${padL + plotW/2}" y="${h-6}">${escText(x1)}</text>
    <text class="axis-label axis-x end" x="${w-padR}" y="${h-6}">${escText(x2)}</text>
  </svg>`;
}

function detailMetricValue(series, fallback, suffix = '') {
  const clean = (Array.isArray(series) ? series : []).map(Number).filter(v => Number.isFinite(v) && Math.abs(v) > 0.01);
  const v = clean.length ? clean[clean.length - 1] : Number(fallback || 0);
  return `${Number.isFinite(v) ? v.toFixed(1) : '0.0'}${suffix}`;
}

function detailRateValue(series, fallback) {
  const clean = (Array.isArray(series) ? series : []).map(Number).filter(v => Number.isFinite(v) && Math.abs(v) > 0.01);
  const v = clean.length ? clean[clean.length - 1] : Number(fallback || 0);
  return fmtRate(v);
}

function detailSampleAgeText(rows = []) {
  const last = [...(rows || [])].reverse().find((row) => row?.created_at || row?.ts || row?.time || row?.timestamp);
  const raw = last?.created_at || last?.ts || last?.time || last?.timestamp;
  const t0 = raw ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t0)) return '—';
  const age = Math.max(0, Math.round((Date.now() - t0) / 1000));
  if (age < 60) return `${age}s`;
  return `${Math.floor(age / 60)}m ${age % 60}s`;
}

function detailSampleIntervalSeries(rows = []) {
  const ts = (rows || [])
    .map((row) => rowTimeMs(row, NaN))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < ts.length; i += 1) {
    const sec = (ts[i] - ts[i - 1]) / 1000;
    if (sec > 0.05 && sec < 300) intervals.push(sec);
  }
  return intervals.length ? intervals.slice(-48) : [0];
}


function formatZhDuration(raw, fallbackAt = null) {
  if ((!raw || raw === "—" || raw === "") && fallbackAt) {
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(fallbackAt).getTime()) / 1000));
    const days = Math.floor(diffSec / 86400);
    const hours = Math.floor((diffSec % 86400) / 3600);
    const minutes = Math.floor((diffSec % 3600) / 60);
    if (days || hours || minutes) return `${days ? `${days} 天` : ""}${hours ? ` ${hours} 小时` : ""}${minutes ? ` ${minutes} 分钟` : ""}`.trim();
    return diffSec + " 秒";
  }
  if (!raw) return "—";
  const text = String(raw);
  const day = text.match(/(\d+)\s*days?/i)?.[1];
  const hour = text.match(/(\d+)\s*hours?/i)?.[1];
  const minute = text.match(/(\d+)\s*minutes?/i)?.[1];
  if (day || hour || minute) return `${day ? `${day} 天` : ""}${hour ? ` ${hour} 小时` : ""}${minute ? ` ${minute} 分钟` : ""}`.trim();
  return text.replace(/days?/ig,"天").replace(/hours?/ig,"小时").replace(/minutes?/ig,"分钟");
}
function backendTelemetryRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter(row => !row?.__frontendCache);
}

function detailFreshnessMeta(rows = [], server = null) {
  const backendRows = backendTelemetryRows(rows);
  const latestMs = latestTimelineMs(backendRows, server);
  const ageSec = Number.isFinite(latestMs) ? Math.max(0, Math.round((Date.now() - latestMs) / 1000)) : null;
  const interval = detailSampleIntervalSeries(backendRows).filter(v => Number.isFinite(v) && v > 0);
  const sampleSec = interval.length ? Math.round(interval[interval.length - 1]) : (window.__DBG__.DETAIL_SOURCE_SAMPLE_MS ? Math.round(window.__DBG__.DETAIL_SOURCE_SAMPLE_MS / 1000) : null);
  if (sampleSec) window.__DBG__.DETAIL_SOURCE_SAMPLE_MS = sampleSec * 1000;
  const freshClass = ageSec == null ? 'unknown' : (ageSec <= 30 ? 'ok' : (ageSec <= 180 ? 'warn' : 'danger'));
  const ageText = ageSec == null ? '无采样' : (ageSec < 60 ? `${ageSec} 秒前` : `${Math.floor(ageSec/60)} 分 ${ageSec%60} 秒前`);
  return { latestMs, ageSec, ageText, sampleSec, freshClass };
}

function detailHealthStatus(server, probeRows = [], pingTargetsData = null) {
  const cpu = Number(server?.cpu_use || 0);
  const ram = Number(server?.ram_use || 0);
  const disk = Number(server?.disk_use || 0);
  const targets = Array.isArray(pingTargetsData?.targets) ? pingTargetsData.targets : [];
  const loss = Math.max(0, ...targets.map(t => Number(t?.stats?.loss_pct ?? 0)).filter(Number.isFinite), 0);
  const latest = detailFreshnessMeta(probeRows, server);
  const online = String(server?.status || '').toLowerCase() === 'online';
  const warnCount = [cpu >= 85, ram >= 85, disk >= 85, loss >= 5, latest.freshClass === 'warn'].filter(Boolean).length;
  const dangerCount = [!online, cpu >= 95, ram >= 95, disk >= 95, loss >= 20, latest.freshClass === 'danger'].filter(Boolean).length;
  const state = dangerCount ? 'danger' : (warnCount ? 'warn' : 'ok');
  return { state, online, warnCount, dangerCount, latest, loss };
}

function renderHealthSummary(server, probeRows = [], pingTargetsData = null, cpuSeries = [], ramSeries = []) {
  const h = detailHealthStatus(server, probeRows, pingTargetsData);
  const cpu = detailMetricValue(cpuSeries, server.cpu_use, '%');
  const mem = detailMetricValue(ramSeries, server.ram_use, '%');
  const disk = `${pctFmt(server.disk_use)}%`;
  const heartbeat = h.online ? 'Agent 在线' : 'Agent 离线';
  const statusText = h.state === 'danger' ? '异常' : (h.state === 'warn' ? '需关注' : '健康');
  const alertText = h.dangerCount ? `${h.dangerCount} 严重` : (h.warnCount ? `${h.warnCount} 提醒` : '0 告警');
  return `<section class="detail-health-summary is-${h.state}" aria-label="运行健康摘要">
    <div class="health-main"><span>健康状态</span><strong>${statusText}</strong><em>${heartbeat} · ${alertText}</em></div>
    <div><span>最新采样</span><strong>${h.latest.ageText}</strong><em>后端采样间隔 ${h.latest.sampleSec ? `${h.latest.sampleSec}s` : '—'}</em></div>
    <div><span>资源</span><strong>CPU ${cpu}</strong><em>内存 ${mem} · 磁盘 ${disk}</em></div>
    <div><span>链路</span><strong>${pingTargetsData?.unavailable ? '—' : `丢包 ${Number(h.loss || 0).toFixed(0)}%`}</strong><em>${pingTargetsData?.unavailable ? '暂无真实节点侧互探采样' : `${(pingTargetsData?.targets || []).length || 0} 个探测目标`}</em></div>
  </section>`;
}

function renderCompactNodeFacts(server) {
  const uuid = String(server?.uuid || '—');
  const shortUuid = uuid.length > 18 ? `${uuid.slice(0, 8)}…${uuid.slice(-6)}` : uuid;
  return `<details class="detail-more-facts">
    <summary>更多低频信息 / 复制字段</summary>
    <div><span>地理坐标</span><code>${escText(detailCoord(server))}</code></div>
    <div><span>UUID</span><code title="${escText(uuid)}">${escText(shortUuid)}</code></div>
  </details>`;
}


function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function fmtResourceGb(value, zero = '0 B') {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return zero;
  if (n >= 1024) return `${(n / 1024).toFixed(n >= 10240 ? 1 : 2)} TB`;
  if (n >= 1) return `${n.toFixed(n >= 10 ? 1 : 2)} GB`;
  return `${(n * 1024).toFixed(0)} MB`;
}

function fmtRate(value) {
  // Backend agent stores net_up/net_down in KB/s, not MB/s.
  const kb = Number(value);
  if (!Number.isFinite(kb) || Math.abs(kb) < 0.05) return '0 KB/s';
  if (Math.abs(kb) >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(2)} GB/s`;
  if (Math.abs(kb) >= 1024) return `${(kb / 1024).toFixed(2)} MB/s`;
  return `${kb.toFixed(kb >= 100 ? 0 : 1)} KB/s`;
}

function resourceUsageFromTotal(total, pct) {
  const t = Number(total);
  const p = clampPct(pct);
  return Number.isFinite(t) && t > 0 ? (t * p / 100) : 0;
}

function renderProbeMeter(label, value, total, pct, extra = '') {
  const p = clampPct(pct);
  return `<div class="probe-meter-row" data-meter="${label}">
    <div class="probe-meter-top"><span>${label}</span><strong>${value}${total ? ` / ${total}` : ''}</strong></div>
    <div class="probe-meter-track"><i style="width:${p}%"></i></div>
    ${extra ? `<div class="probe-meter-extra">${extra}</div>` : ''}
  </div>`;
}

function renderResourceLine(label, value, pct, extra = '') {
  const p = clampPct(pct);
  return `<div class="probe-resource-line" data-resource="${label}">
    <span class="probe-resource-pill">${label}</span>
    <strong>${value}</strong>
    <div class="probe-resource-track"><i style="width:${p}%"></i></div>
    <em>${extra}</em>
  </div>`;
}

function smoothNumericSeries(values = [], windowSize = 5) {
  const rows = Array.isArray(values) ? values.map(Number).filter(v => Number.isFinite(v) && v >= 0) : [];
  if (!rows.length) return [];
  return rows.map((_, idx) => {
    const start = Math.max(0, idx - windowSize + 1);
    const slice = rows.slice(start, idx + 1);
    const sorted = slice.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  });
}

function stableLatestRate(series = [], fallback = 0) {
  const smoothed = smoothNumericSeries(series, 5);
  if (smoothed.length) return smoothed[smoothed.length - 1];
  const f = Number(fallback || 0);
  return Number.isFinite(f) && f >= 0 ? f : 0;
}

function renderRealtimeResourcePanels(server, trafficData, upSeries = [], downSeries = [], cpuSeries = [], ramSeries = [], runtimeEnvironmentCard = '') {
  const cpuPct = Number(cpuSeries?.length ? cpuSeries[cpuSeries.length - 1] : server.cpu_use || 0);
  const ramPct = Number(ramSeries?.length ? ramSeries[ramSeries.length - 1] : server.ram_use || 0);
  const diskPct = Number(server.disk_use || 0);
  const cpuCores = Number(server.cpu || server.cpu_cores || 0);
  const ramTotal = Number(server.ram || server.ram_gb || 0);
  const diskTotal = Number(server.disk || server.disk_gb || 0);
  const ramUsed = resourceUsageFromTotal(ramTotal, ramPct);
  const diskUsed = resourceUsageFromTotal(diskTotal, diskPct);
  const latestUp = stableLatestRate(upSeries, server.net_up);
  const latestDown = stableLatestRate(downSeries, server.net_down);
  const upGb = Number(trafficData?.up_gb ?? server.traffic_up_gb ?? 0);
  const downGb = Number(trafficData?.down_gb ?? server.traffic_down_gb ?? 0);
  const usedGb = Number(trafficData?.used_gb ?? server.traffic_used_gb ?? (upGb + downGb));
  const limitGb = Number(trafficData?.limit_gb ?? server.traffic_limit_gb ?? 0);
  const trafficPct = limitGb > 0 ? clampPct((usedGb / limitGb) * 100) : 0;
  const loadGuess = Number.isFinite(cpuPct) && cpuCores > 0 ? (cpuPct / 100 * cpuCores).toFixed(2) : '—';
  return `<section class="probe-observability-grid" id="detailRealtimePanels" aria-label="实时资源监控">
    ${runtimeEnvironmentCard}
    <div class="probe-card allocation-card">
      <div class="probe-card-head"><h2 data-i18n="allocation">${t('allocation')}</h2><span>ALC • 02</span></div>
      <div class="probe-meter-list allocation-meter-list">
        ${renderProbeMeter(t('memory').toUpperCase(), fmtResourceGb(ramUsed), fmtResourceGb(ramTotal), ramTotal ? (ramUsed / ramTotal * 100) : ramPct)}
        ${renderProbeMeter(t('disk').toUpperCase(), fmtResourceGb(diskUsed), fmtResourceGb(diskTotal), diskTotal ? (diskUsed / diskTotal * 100) : diskPct)}
        ${renderProbeMeter(t('swap').toUpperCase(), '0 B', '—', 0)}
      </div>
      <div class="allocation-badge-slot">${renderFleetInsignia()}</div>
    </div>
    <div class="probe-card resources-card">
      <div class="probe-card-head"><h2 data-i18n="resources">${t('resources')}</h2><span>RES • 03</span></div>
      <div class="probe-resource-list">
        ${renderResourceLine(t('cpu').toUpperCase(), `${pctFmt(cpuPct)}%`, cpuPct, `${cpuCores || '—'} ${t('cores')}`)}
        ${renderResourceLine(t('mem').toUpperCase(), `${pctFmt(ramPct)}%`, ramPct, `${fmtResourceGb(ramUsed)} / ${fmtResourceGb(ramTotal)}`)}
        ${renderResourceLine(t('disk').toUpperCase(), `${pctFmt(diskPct)}%`, diskPct, `${fmtResourceGb(diskUsed)} / ${fmtResourceGb(diskTotal)}`)}
        ${renderResourceLine(t('load').toUpperCase(), loadGuess, cpuCores ? clampPct((Number(loadGuess) / cpuCores) * 100) : 0, `1m / ${loadGuess}`)}
      </div>
    </div>
    <div class="probe-card bandwidth-card">
      <div class="probe-card-head"><h2 data-i18n="bandwidth">${t('bandwidth')}</h2><span>NET • 04 · 实时速率5点平滑</span></div>
      <div class="probe-bandwidth-now">
        <div><span data-i18n="uplink">${t('uplink')}</span><strong>↑ ${fmtRate(latestUp)}</strong></div>
        <div><span data-i18n="downlink">${t('downlink')}</span><strong>↓ ${fmtRate(latestDown)}</strong></div>
      </div>
      <div class="probe-meter-list compact">
        ${renderProbeMeter('TRAFFIC 累计流量', fmtResourceGb(usedGb), limitGb > 0 ? fmtResourceGb(limitGb) : '不限', trafficPct, `累计上传 ${fmtResourceGb(upGb)} · 累计下载 ${fmtResourceGb(downGb)} · ${formatTrafficResetText(server, trafficData)}`)}
      </div>
    </div>
  </section>`;
}

function renderInventoryRows(rows = []) {
  const list = rows.slice(0, 5);
  return list.map((row, idx) => `<tr><td>ASSET-${idx + 1}</td><td>${row.name}</td><td>${row.city || row.location || 'vector'}</td><td>${statusShortLabel(row.status)}</td><td>${(row.uuid || `phase-${idx + 1}`).slice(0, 13)}</td></tr>`).join('');
}

function formatExpiryCountdown(expiry) {
  const d = daysUntilExpiry(expiry);
  if (d == null) return '未设置到期';
  if (d < 0) return `已过期 ${Math.abs(d)} 天`;
  if (d == 0) return '今日到期';
  return `${d} 天后到期`;
}

function renderTagChips(tags) {
  const rows = Array.isArray(tags) ? tags.filter(Boolean) : [];
  return rows.length ? rows.map(tag => `<span class="detail-tag">${tag}</span>`).join('') : '<span class="detail-tag is-empty">暂无标签</span>';
}

function renderSummaryStats() {
  const rows = Array.isArray(state.servers) ? state.servers : [];
  const total = rows.length;
  const online = rows.filter(s => s.status === 'online').length;
  const warn = rows.filter(s => s.status === 'warn').length;
  const offline = rows.filter(s => s.status !== 'online' && s.status !== 'warn').length;
  return `<div class="detail-metrics-grid compact detail-metrics-grid-dense">${metric('总节点', total)}${metric('在线', online)}${metric('波动', warn)}${metric('离线', offline)}</div>`;
}


function statusShortLabel(status) {
  return status === 'online' ? 'ONLINE' : status === 'warn' ? 'WARN' : 'OFFLINE';
}

function describeRuleType(ruleType) {
  const map = {
    offline: '离线告警',
    cpu: 'CPU 告警',
    memory: '内存告警',
    disk: '磁盘告警',
    traffic: '流量告警',
    bandwidth: '带宽告警',
    ping: '延迟告警',
  };
  return map[ruleType] || (ruleType || '未知规则');
}

function buildAssetNarrative(server, rv, pct, pingData) {
  const provider = server.provider || server.provider_guess || '未知供应商';
  const loc = server.location || server.city || server.region || server.country || '未知地区';
  const latency = pingData?.stats?.avg_ms != null ? `${pingData.stats.avg_ms}ms` : '暂无 TCP 采样';
  return `${server.name} 当前位于 ${loc}，供应商 ${provider}，月均成本 ${toDisplay(getMonthlyPrice(server))}，剩余价值 ${toDisplay(rv.value)}，流量使用 ${pct.toFixed(1)}%，链路表现 ${latency}。`;
}

function buildAssetRiskChips(server, rv, pct, heartbeatPct, pingData) {
  const chips = [statusLabel(server.status), formatExpiryCountdown(server.expiry)];
  if (pct >= 85) chips.push('流量偏高');
  if (Number(heartbeatPct || 0) < 95) chips.push('稳定率偏低');
  if ((pingData?.stats?.loss_pct || 0) > 0) chips.push('存在丢包');
  if (rv.daysLeft <= 7) chips.push('临近续费');
  return chips;
}

function buildHealthNarrative(server, heartbeatPct, cpuSeries, ramSeries, latencySeries, pingData) {
  const cpu = cpuSeries.length ? cpuSeries[cpuSeries.length - 1].toFixed(1) : '—';
  const ram = ramSeries.length ? ramSeries[ramSeries.length - 1].toFixed(1) : '—';
  const lat = pingData?.stats?.avg_ms ?? (latencySeries.filter(v => v != null).slice(-1)[0] ?? '—');
  return `最近 1 小时稳定率 ${heartbeatPct}% ，CPU ${cpu}% ，内存 ${ram}% ，TCP 延迟 ${lat}${lat !== '—' ? 'ms' : ''}。`;
}

function buildTrendNarrative(cpuSeries, ramSeries, historySeries) {
  const cpuMax = cpuSeries.length ? Math.max(...cpuSeries).toFixed(1) : '—';
  const ramMax = ramSeries.length ? Math.max(...ramSeries).toFixed(1) : '—';
  const bwMax = historySeries.length ? Math.max(...historySeries).toFixed(2) : '—';
  return `近 1 小时峰值：CPU ${cpuMax}% 、内存 ${ramMax}% 、带宽 ${bwMax} MB/s。`;
}

function buildRuleNarrative(rules) {
  const rows = Array.isArray(rules) ? rules : [];
  if (!rows.length) return '当前节点暂无启用中的 Telegram 规则。';
  return `当前关联 ${rows.length} 条规则，覆盖 ${rows.map(r => describeRuleType(r.rule_type)).join(' / ')}。`;
}

function pctFmt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(1) : Number(fallback).toFixed(1);
}

function detailCoord(server) {
  const lat = Number(server.latitude);
  const lon = Number(server.longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) ? `${lat.toFixed(4)}, ${lon.toFixed(4)}` : '—';
}

const DETAIL_HTML_IMAGES = {
  ship: 'data:image/jpeg;base64,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',
  badge: 'data:image/jpeg;base64,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',
  globe: 'data:image/jpeg;base64,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',
};

function renderFleetShip() {
  return `<div class="fleet-reference-asset fleet-reference-ship fleet-ufo-node" aria-label="USS Enterprise hologram">
    <img src="/assets/detail-reference/enterprise-hologram-transparent.png" alt="USS Enterprise hologram" loading="eager" decoding="async" />
  </div>`;
}

function renderFleetInsignia() {
  return `<div class="fleet-reference-asset fleet-reference-badge fleet-delta-badge" aria-label="Starfleet delta badge">
    <img src="/assets/detail-reference/starfleet-badge-transparent.png" alt="Starfleet delta badge" loading="eager" decoding="async" />
  </div>`;
}

function renderQuantumGlobe(server, rows = []) {
  const safeId = String(server?.id ?? 'node').replace(/[^a-zA-Z0-9_-]/g, '');
  return `<div class="quantum-globe-wrap quantum-doc-globe" data-doc-globe="1">
    <canvas id="detailProbeGlobeCanvas-${safeId}" class="detail-probe-globe-canvas" width="720" height="520" aria-label="interactive node probe globe"></canvas>
    <div class="quantum-globe-copy top"><strong>${server.hostname || server.name || 'NODE'}</strong><span>LIVE PROBE VECTOR</span><em>${maskIpForPublicDisplay(server.ip || 'IPv4 —')}</em></div>
    <div class="quantum-globe-copy bottom"><strong>${server.provider_guess || server.provider || 'probe-net'}</strong><span>${detailCoord(server)}</span></div>
    <div class="detail-probe-globe-tooltip" id="detailProbeGlobeTip-${safeId}"></div>
  </div>`;
}

function initQuantumProbeGlobe(server, rows = []) {
  const safeId = String(server?.id ?? 'node').replace(/[^a-zA-Z0-9_-]/g, '');
  const canvas = document.getElementById(`detailProbeGlobeCanvas-${safeId}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const tip = document.getElementById(`detailProbeGlobeTip-${safeId}`);
  if (window.__DBG__.DETAIL_PROBE_GLOBE_ANIM) cancelAnimationFrame(window.__DBG__.DETAIL_PROBE_GLOBE_ANIM);
  const stateGlobe = { rotY: 0.40, rotX: -0.40, zoom: 1, dragging: false, lastX: 0, lastY: 0, hover: null };
  window.__DBG__.DETAIL_PROBE_GLOBE_STATE = stateGlobe;
  const locs = (Array.isArray(rows) && rows.length ? rows : [server]).map((row, idx) => {
    const lat = Number(row.lat ?? row.latitude ?? row.agent_config?.lat ?? row.agent_config?.inventory_meta?.lat);
    const lon = Number(row.lon ?? row.lng ?? row.longitude ?? row.agent_config?.lon ?? row.agent_config?.inventory_meta?.lon);
    const fallback = detailLocationToLatLng(row.location || row.city || row.region || row.name || '');
    const meta = row.agent_config?.inventory_meta || {};
    const flag = hasExplicitFlag(row.flag) ? row.flag : inferFlagFromLocation(
      row.country_code, row.countryCode, row.country, row.country_name,
      row.city, row.location, row.region, row.name, row.hostname, row.ip,
      meta.country_code, meta.countryCode, meta.country, meta.city, meta.region
    );
    return {
      id: row.id ?? idx,
      name: row.name || row.hostname || `VPS-${idx + 1}`,
      ip: row.ip || '—',
      status: row.status || 'online',
      city: row.public_note || row.publicRemark || row.public_remark || row.remark || row.location || row.city || row.country || 'sector',
      flag,
      lat: Number.isFinite(lat) ? lat : fallback.lat,
      lng: Number.isFinite(lon) ? lon : fallback.lng,
      hot: String(row.id) === String(server?.id)
    };
  }).slice(0, 12);

  const detailGlobeImg = new Image();
  detailGlobeImg.decoding = 'async';
  detailGlobeImg.src = '/globe/detail-assets/network-globe.jpg';
  detailGlobeImg.onload = () => { if (window.__DBG__.DETAIL_PROBE_GLOBE_ANIM) return; draw(); };

  function wrapAngle(value) {
    const tau = Math.PI * 2;
    return ((value % tau) + tau) % tau;
  }

  function resizeBackingStore() {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(420, Math.floor(rect.width * dpr));
    const h = Math.max(300, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  }
  function project(lat, lng, r, cx, cy) {
    const phi = (90 - lat) * Math.PI / 180;
    const theta = (lng + 180) * Math.PI / 180;
    let x = -Math.sin(phi) * Math.cos(theta);
    let y =  Math.cos(phi);
    let z =  Math.sin(phi) * Math.sin(theta);
    const cosY = Math.cos(stateGlobe.rotY), sinY = Math.sin(stateGlobe.rotY);
    const x2 = x * cosY - z * sinY;
    const z2 = x * sinY + z * cosY;
    const cosX = Math.cos(stateGlobe.rotX), sinX = Math.sin(stateGlobe.rotX);
    const y2 = y * cosX - z2 * sinX;
    const z3 = y * sinX + z2 * cosX;
    return { x: x2, y: y2, z: z3, px: cx + x2 * r, py: cy + y2 * r, visible: z3 < 0.22 };
  }
  function drawGridLine(points, r, cx, cy, color, width) {
    ctx.beginPath();
    let open = true;
    for (const [lat, lng] of points) {
      const p = project(lat, lng, r, cx, cy);
      if (!p.visible) { open = true; continue; }
      if (open) { ctx.moveTo(p.px, p.py); open = false; } else ctx.lineTo(p.px, p.py);
    }
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.stroke();
  }
  function draw() {
    resizeBackingStore();
    const W = canvas.width, H = canvas.height;
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.43 * stateGlobe.zoom;
    ctx.clearRect(0, 0, W, H);

    const bg = ctx.createRadialGradient(cx, cy, r * 0.18, cx, cy, r * 1.85);
    bg.addColorStop(0, 'rgba(18,44,76,0.24)');
    bg.addColorStop(0.58, 'rgba(3,12,24,0.18)');
    bg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

    // sparse deep-space stars inside the detail globe panel
    const starSeed = [
      [.12,.14,.75],[.20,.22,.45],[.31,.09,.55],[.72,.13,.5],[.85,.20,.38],[.78,.82,.46],
      [.15,.72,.42],[.90,.62,.34],[.56,.08,.28],[.42,.90,.36],[.08,.50,.30],[.67,.72,.26]
    ];
    starSeed.forEach(([sx, sy, a], i) => {
      ctx.beginPath();
      ctx.arc(W * sx, H * sy, i % 3 === 0 ? 1.15 : 0.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(220,238,255,${a})`;
      ctx.fill();
    });

    const sphere = ctx.createRadialGradient(cx - r * 0.30, cy - r * 0.38, r * 0.04, cx, cy, r * 1.10);
    sphere.addColorStop(0, 'rgba(27,74,111,0.98)');
    sphere.addColorStop(0.44, 'rgba(9,42,72,0.97)');
    sphere.addColorStop(1, 'rgba(2,13,29,0.99)');
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = sphere; ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r - 0.5, 0, Math.PI * 2); ctx.clip();

    // Extracted original detail globe: /globe/detail-assets/network-globe.jpg.
    // Draw it as the real base plate; the live grid/nodes stay interactive above it.
    if (detailGlobeImg.complete && detailGlobeImg.naturalWidth > 0) {
      const iw = detailGlobeImg.naturalWidth, ih = detailGlobeImg.naturalHeight;
      const d = r * 2.06;
      const scale = Math.max(d / iw, d / ih);
      const sw = d / scale, sh = d / scale;
      const sx = (iw - sw) / 2, sy = (ih - sh) / 2;
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = 0.92;
      ctx.drawImage(detailGlobeImg, sx, sy, sw, sh, cx - d / 2, cy - d / 2, d, d);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      const unify = ctx.createRadialGradient(cx - r * 0.36, cy - r * 0.42, r * 0.04, cx, cy, r * 1.06);
      unify.addColorStop(0, 'rgba(45,160,214,0.14)');
      unify.addColorStop(0.48, 'rgba(3,31,58,0.05)');
      unify.addColorStop(1, 'rgba(0,5,15,0.18)');
      ctx.fillStyle = unify;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }

    const sunWash = ctx.createRadialGradient(cx - r * 0.40, cy - r * 0.48, 0, cx - r * 0.16, cy - r * 0.18, r * 1.42);
    sunWash.addColorStop(0, 'rgba(86,175,220,0.16)');
    sunWash.addColorStop(0.42, 'rgba(36,120,170,0.08)');
    sunWash.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = sunWash; ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    for (let lat = -75; lat <= 75; lat += 15) {
      const pts = []; for (let lng = -180; lng <= 180; lng += 2) pts.push([lat, lng]);
      drawGridLine(pts, r, cx, cy, lat === 0 ? 'rgba(83,166,224,.24)' : 'rgba(70,146,205,.13)', lat === 0 ? .75 : .38);
    }
    for (let lng = -180; lng < 180; lng += 20) {
      const pts = []; for (let lat = -86; lat <= 86; lat += 2) pts.push([lat, lng]);
      drawGridLine(pts, r, cx, cy, 'rgba(70,146,205,.11)', .35);
    }

    const continents = [
      [[58,-130],[52,-98],[41,-75],[25,-83],[17,-99],[31,-118],[45,-125]],
      [[9,-79],[-8,-62],[-25,-58],[-43,-70],[-15,-78]],
      [[55,-10],[50,30],[34,44],[20,18],[31,-6]],
      [[51,72],[49,105],[42,126],[34,139],[22,122],[11,106],[20,78],[35,60]],
      [[25,100],[20,108],[13,103],[7,100],[1,104],[-6,106],[-2,118],[12,122],[22,114]],
      [[4,12],[-15,28],[-31,20],[-25,8]],
      [[-12,112],[-24,150],[-40,136],[-28,115]],
      [[46,129],[38,142],[31,131],[36,126]],
    ];
    ctx.fillStyle = 'rgba(38,94,132,.07)'; ctx.strokeStyle = 'rgba(90,177,232,.16)'; ctx.lineWidth = .55;
    continents.forEach(poly => {
      ctx.beginPath(); let open = true;
      poly.concat([poly[0]]).forEach(([lat,lng]) => { const p = project(lat,lng,r,cx,cy); if (!p.visible) { open = true; return; } if (open) { ctx.moveTo(p.px,p.py); open=false; } else ctx.lineTo(p.px,p.py); });
      ctx.fill(); ctx.stroke();
    });

    const liveNodes = locs
      .map((loc, idx) => {
        const displayCode = hasExplicitFlag(loc.flag) ? loc.flag : (String(loc.code || loc.flag || 'VPS').replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || 'VPS');
        return {
          ...loc,
          code: displayCode,
          lat: Number(loc.lat),
          lng: Number(loc.lng),
          color: loc.color || (idx % 2 ? '#ffa23a' : '#62f5ee'),
        };
      })
      .filter((loc) => Number.isFinite(loc.lat) && Number.isFinite(loc.lng));
    const projected = liveNodes.map(loc => ({ loc, p: project(loc.lat, loc.lng, r, cx, cy) })).filter(x => x.p.visible);

    projected.forEach(({loc,p}) => {
      const color = loc.color;
      const pulse = (Math.sin(Date.now() * 0.004 + (String(loc.id || loc.name).length || 0)) + 1) * 1.3;
      ctx.beginPath(); ctx.arc(p.px, p.py, 8.5 + pulse, 0, Math.PI * 2); ctx.fillStyle = 'rgba(98,245,238,.18)'; ctx.fill();
      ctx.beginPath(); ctx.arc(p.px, p.py, 4.8, 0, Math.PI * 2); ctx.fillStyle = color; ctx.shadowColor = color; ctx.shadowBlur = 13; ctx.fill(); ctx.shadowBlur = 0;
      ctx.font = `${Math.max(10, W/78)}px JetBrains Mono, Space Mono, monospace`;
      ctx.fillStyle = 'rgba(226,235,246,.94)';
      ctx.textBaseline = 'middle';
      ctx.shadowColor = 'rgba(0,0,0,.75)'; ctx.shadowBlur = 4;
      ctx.fillText(`${loc.code} ${loc.name || 'VPS'}`, p.px + 10, p.py + 1);
      ctx.shadowBlur = 0;
    });
    ctx.restore();

    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(101,184,240,.56)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r + 5, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(70,158,220,.10)'; ctx.lineWidth = 8; ctx.stroke();
    if (!stateGlobe.dragging) stateGlobe.rotY = wrapAngle(stateGlobe.rotY + 0.00022);
    window.__DBG__.DETAIL_PROBE_GLOBE_ANIM = requestAnimationFrame(draw);
  }
  const setDrag = (active, x, y) => { stateGlobe.dragging = active; stateGlobe.lastX = x; stateGlobe.lastY = y; canvas.style.cursor = active ? 'grabbing' : 'grab'; };
  canvas.style.cursor = 'grab';
  canvas.addEventListener('mousedown', e => setDrag(true, e.clientX, e.clientY));
  window.addEventListener('mouseup', () => setDrag(false, stateGlobe.lastX, stateGlobe.lastY), { passive: true });
  canvas.addEventListener('mousemove', e => {
    if (stateGlobe.dragging) {
      stateGlobe.rotY = wrapAngle(stateGlobe.rotY + (e.clientX - stateGlobe.lastX) * 0.007 / stateGlobe.zoom);
      stateGlobe.rotX = wrapAngle(stateGlobe.rotX + (e.clientY - stateGlobe.lastY) * 0.007 / stateGlobe.zoom);
      // no polar clamp: full vertical 360° tumble, explicitly wrapped not clamped
      stateGlobe.lastX = e.clientX; stateGlobe.lastY = e.clientY;
    }
    const rect = canvas.getBoundingClientRect();
    const W = canvas.width, H = canvas.height, cx = W/2, cy = H/2, r = Math.min(W,H)*0.40*stateGlobe.zoom;
    const mx = (e.clientX - rect.left) * (W / rect.width), my = (e.clientY - rect.top) * (H / rect.height);
    let found = null;
    locs.forEach(loc => { const p = project(loc.lat, loc.lng, r, cx, cy); if (!p.visible) return; if (Math.hypot(mx-p.px,my-p.py) < 16) found = loc; });
    if (tip) {
      if (found) { tip.style.display='block'; tip.style.left=`${e.clientX-rect.left+14}px`; tip.style.top=`${e.clientY-rect.top-8}px`; tip.innerHTML=`<strong>${escapeHtml(found.name)}</strong><span>${escapeHtml(found.city)} · ${escapeHtml(found.ip)}</span>`; }
      else tip.style.display='none';
    }
  });
  canvas.addEventListener('wheel', e => { e.preventDefault(); stateGlobe.zoom = Math.max(.68, Math.min(1.8, stateGlobe.zoom + (e.deltaY > 0 ? -.08 : .08))); }, { passive: false });
  canvas.addEventListener('touchstart', e => { if (e.touches[0]) setDrag(true, e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  canvas.addEventListener('touchmove', e => { if (!stateGlobe.dragging || !e.touches[0]) return; const t=e.touches[0]; stateGlobe.rotY = wrapAngle(stateGlobe.rotY + (t.clientX-stateGlobe.lastX)*0.007/stateGlobe.zoom); stateGlobe.rotX = wrapAngle(stateGlobe.rotX + (t.clientY-stateGlobe.lastY)*0.007/stateGlobe.zoom); stateGlobe.lastX=t.clientX; stateGlobe.lastY=t.clientY; }, { passive: true });
  canvas.addEventListener('touchend', () => setDrag(false, stateGlobe.lastX, stateGlobe.lastY), { passive: true });
  draw();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
}

function detailLocationToLatLng(loc = '') {
  const map = {
    '洛杉矶': { lat: 34.05, lng: -118.24 }, '纽约': { lat: 40.71, lng: -74.01 }, '西雅图': { lat: 47.61, lng: -122.33 },
    '香港': { lat: 22.32, lng: 114.17 }, '东京': { lat: 35.69, lng: 139.69 }, '大阪': { lat: 34.69, lng: 135.50 },
    '新加坡': { lat: 1.35, lng: 103.82 }, '首尔': { lat: 37.57, lng: 126.98 }, '台北': { lat: 25.03, lng: 121.56 },
    '法兰克福': { lat: 50.11, lng: 8.68 }, '伦敦': { lat: 51.51, lng: -0.13 }, '阿姆斯特丹': { lat: 52.37, lng: 4.90 },
    '巴黎': { lat: 48.86, lng: 2.35 }, '悉尼': { lat: -33.87, lng: 151.21 }, '孟买': { lat: 19.08, lng: 72.88 }
  };
  const text = String(loc || '');
  for (const key in map) if (text.includes(key)) return map[key];
  return { lat: 30, lng: 105 };
}

function maskIpForPublicDisplay(value) {
  const text = String(value || '');
  const ipv4 = text.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) return `${ipv4[1]}.*.*.${ipv4[4].replace(/\d/g, '*')}`;
  const ipv6 = text.match(/^[0-9a-f:]+$/i);
  if (ipv6 && text.includes(':')) return `${text.split(':').slice(0, 2).join(':')}:…`;
  return text || '—';
}

function renderNodeDatabaseRows(server, rows = []) {
  const list = (rows.length ? rows : [server]).slice(0, 6);
  return list.map((row, idx) => `<tr>
    <td data-label="身份">${row.name || `VPS-${idx + 1}`}</td>
    <td data-label="供应商">${row.provider || row.provider_guess || 'racknerd'}</td>
    <td data-label="城市">${row.city || row.location || 'sector'}</td>
    <td data-label="IP">${maskIpForPublicDisplay(row.ip || row.public_ip || '—')}</td>
    <td data-label="架构">${row.arch || 'amd64'}</td>
    <td data-label="磁盘">${row.disk || row.disk_gb || '—'} GB</td>
    <td data-label="UUID">${row.uuid || `phase-${idx + 1}`}</td>
  </tr>`).join('');
}


function renderProbeStatusCard(pingData, pingTargetsData) {
  const targets = (pingTargetsData?.targets || []).slice(0, 4);
  const agentUnavailable = !!pingTargetsData?.unavailable;
  const hasConfiguredTargets = targets.length > 0;
  const loss = agentUnavailable ? 0 : (hasConfiguredTargets
    ? Math.max(0, Math.round(targets.reduce((sum, target) => sum + (target.quality != null ? Math.max(0, 100 - Number(target.quality)) : 100), 0) / targets.length))
    : Number(pingData?.stats?.loss_pct ?? 0));
  const avgValues = targets.map((target) => target.stats?.avg_ms).filter((value) => value != null).map(Number);
  const avg = avgValues.length ? (avgValues.reduce((sum, value) => sum + value, 0) / avgValues.length) : (pingData?.stats?.avg_ms != null ? Number(pingData.stats.avg_ms) : null);
  const state = agentUnavailable ? '等待节点侧采样' : (!hasConfiguredTargets ? '未配置目标' : (loss >= 100 ? '不可达' : (loss >= 20 ? '丢包严重' : (loss > 0 ? '链路波动' : '链路正常'))));
  const cls = agentUnavailable ? 'warn' : (!hasConfiguredTargets ? 'warn' : (loss >= 100 ? 'danger' : (loss >= 20 ? 'warn' : 'ok')));
  const rows = agentUnavailable ? '<div class="probe-empty-row"><span>暂无真实节点侧互探采样</span><em>已停止主控代测，等待 agent 上报</em></div>' : (targets.length ? targets.map(t => {
    const ms = t.stats?.avg_ms != null ? Number(t.stats.avg_ms) : 0;
    const l = t.stats?.loss_pct != null ? Math.max(0, Number(t.stats.loss_pct)) : 0;
    return `<div><span>${t.label || 'probe'}</span>${probeLinkBar(ms, l)}<em>${ms ? ms.toFixed(0)+'ms' : '—'} / ${l.toFixed(0)}%</em></div>`;
  }).join('') : '<div class="probe-empty-row"><span>未读取到延迟监控目标</span><em>请在后台「延迟监测」配置 ping_targets</em></div>');
  return `<div class="fleet-chart-card probe-status-card ${cls}">
    <div class="fleet-chart-head"><span>探针链路状态</span><strong>${state}</strong></div>
    <div class="probe-status-hero"><b>${agentUnavailable ? '—' : `${loss.toFixed(0)}%`}</b><span>${agentUnavailable ? '节点侧' : '丢包率'}</span><em>${agentUnavailable ? '暂无真实互探样本' : (avg != null ? `平均 ${avg.toFixed(0)} ms` : '无有效延迟样本')}</em></div>
    <div class="probe-status-bars">${rows}</div>
  </div>`;
}

function probeLinkBar(ms, loss = null) {
  if (ms == null && loss == null) {
    return `<div class="probe-link-bar warn" title="暂无真实 agent 互探样本"><i style="width:4%"></i><b></b></div>`;
  }
  const latency = Math.max(0, Number(ms) || 0);
  const lossPct = Math.max(0, Number(loss) || 0);
  const score = Math.max(4, Math.min(100, (latency / 300) * 72 + lossPct * 0.9));
  const cls = lossPct >= 20 || latency >= 260 ? 'danger' : (lossPct >= 5 || latency >= 150 ? 'warn' : 'ok');
  return `<div class="probe-link-bar ${cls}" title="${latency.toFixed(0)}ms / loss ${lossPct.toFixed(0)}%"><i style="width:${score.toFixed(0)}%"></i><b></b></div>`;
}

function renderProbeRows(pingTargetsData, pingData) {
  if (pingTargetsData?.unavailable) return '<tr class="probe-empty-row"><td colspan="4">暂无真实节点侧互探采样；已停止主控代测，等待 agent 上报。</td></tr>';
  const targets = (pingTargetsData?.targets || []).filter(t => t.type === 'peer').slice(0, 6);
  if (targets.length) return targets.map((target) => {
    const ms = target.stats?.avg_ms != null ? Number(target.stats.avg_ms) : null;
    const loss = target.stats?.loss_pct != null ? Math.max(0, Number(target.stats.loss_pct)) : null;
    return `<tr><td>${target.label || 'probe'}</td><td>${ms != null ? ms.toFixed(0) : '—'}</td><td>${loss != null ? loss.toFixed(0) + '%' : '—'}</td><td>${probeLinkBar(ms, loss)}</td></tr>`;
  }).join('');
  return '<tr class="probe-empty-row"><td colspan="4">未读取到延迟监控目标；后台「延迟监测」保存后自动生成。</td></tr>';
}

async function refreshDetailProbeTargetsNow(serverId) {
  if (!serverId) return null;
  try {
    const data = await fetchPingTargets(serverId, 3, 'agent');
    if (!data?.targets?.length) return data;
    detailCache.peerPingTargets = data;
    setDetailPingTargetsFetchedAt(Date.now());
    window.__DBG__.DETAIL_PEER_PING_TARGETS = data;
    const tbody = document.querySelector('.fleet-probe-table-panel tbody');
    if (tbody) tbody.innerHTML = renderProbeRows(data, null);
    return data;
  } catch (error) {
    window.__DBG__.DETAIL_PROBE_TARGET_REFRESH_ERROR = String(error?.stack || error);
    console.warn('[detail] probe target refresh failed', error);
    return null;
  }
}

function renderRulesConsole(rules) {
  const base = rules?.length ? rules : [
    { rule_type: 'traffic', name: 'traffic global', threshold: 85, scope: 'global' },
    { rule_type: 'expiry', name: 'expiry global', threshold: 14, scope: 'global' },
    { rule_type: 'offline', name: 'offline global', threshold: 1, scope: 'global' },
    { rule_type: 'disk', name: 'disk global', threshold: 90, scope: 'global' },
    { rule_type: 'cpu', name: 'cpu global', threshold: 90, scope: 'global' },
  ];
  return base.slice(0, 5).map((rule) => `<div class="fleet-rule-row"><strong>${rule.name || describeRuleType(rule.rule_type)}</strong><span>${rule.scope || 'global'}</span><em>${describeRuleType(rule.rule_type)} · threshold ${rule.threshold ?? '—'}</em></div>`).join('');
}

function renderErrorLog(server, heartbeatSeries, pingData) {
  const offline = heartbeatSeries.filter((s) => s !== 'online').length;
  const loss = Number(pingData?.stats?.loss_pct || 0);
  const lines = [
    offline ? `R1 error ${offline} · heartbeat anomaly trail` : 'R1 nominal · heartbeat green',
    loss ? `R2 error ${loss.toFixed(0)} · tcp loss diagnostic` : 'R2 nominal · tcp clear',
    server.status !== 'online' ? `R3 error 111 · ${server.status}` : 'R3 nominal · quantum link stable',
  ];
  return lines.map((line) => `<div>${line}</div>`).join('');
}


async function renderDetailPage(serverId) {
  window.__DBG__.DETAIL_TRACE = ['renderDetailPage:start', String(serverId)];
  loadStoredPingSamples(serverId);
  const detailDays = Math.max(0, Math.min(7, Number(getDetailHistoryDays() || 0) || 0));
  const detailBucketMinutes = getDetailHistoryBucketMinutes(detailDays);
  try {
  const requestedId = Number(serverId);
  const server = state.servers.find((item) => Number(item.id) === requestedId);
  const fallbackServer = !server && state.servers.length === 1 ? state.servers[0] : null;
  const resolvedServer = server || fallbackServer;
  window.__DBG__.DETAIL_TRACE.push('server:' + (resolvedServer ? resolvedServer.id : 'missing'));
  if (fallbackServer) window.__DBG__.DETAIL_TRACE.push('fallback-single-server:' + requestedId + '->' + fallbackServer.id);
  const app = document.getElementById('pageRoot');
  if (!resolvedServer) {
    app.innerHTML = renderDetailNotFound(serverId, escText);
    document.documentElement.classList.remove('detail-pending');
    return;
  }

  // Show a real mobile-safe shell immediately. Heavy history endpoints can take
  // several seconds on small VPS installs; without this, direct ?server= routes
  // look like a blank starfield until every request completes.
  app.innerHTML = detailLoadingShell(resolvedServer);
  document.documentElement.classList.remove('detail-pending');
  bindTopbarEvents(app);
  updateRateDisplay();
  const isMobileDetail = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  const liveLimit = detailDays === 0 ? (isMobileDetail ? 900 : 14400) : (isMobileDetail ? 720 : 2000);
  const historyDays = detailDays === 0 ? 1 : detailDays;
  const historyLimit = liveLimit;
  const targetHistoryHours = detailDays === 0 ? (isMobileDetail ? 2 : 12) : detailDays * 24;
  const settleWithin = (promise, timeoutMs, label) => Promise.race([
    promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'rejected', reason: new Error(`${label || 'detail'} timeout`) }), timeoutMs)),
  ]);
  const fetchBudgetMs = isMobileDetail ? 3600 : 12000;
  window.__DBG__.DETAIL_TRACE.push('before-fetches');
  const [traffic, history, ping, probeHistory, pingTargets, pingTargetHistory, peerPingTargets] = await Promise.all([
    settleWithin(fetchJson(`${API_ROOT}/api/v1/traffic/public/${resolvedServer.id}`, { timeoutMs: 1200 }), fetchBudgetMs, 'traffic'),
    settleWithin(fetchJson(`${API_ROOT}/api/v1/traffic/public/${resolvedServer.id}/history?days=${detailDays}&bucket_minutes=${detailBucketMinutes}&limit=${liveLimit}`, { timeoutMs: isMobileDetail ? 2200 : 1200 }), fetchBudgetMs, 'traffic-history'),
    settleWithin(fetchPing(resolvedServer), fetchBudgetMs, 'ping'),
    settleWithin(fetchServerHistory(resolvedServer.id, historyDays, historyLimit, detailBucketMinutes), fetchBudgetMs, 'server-history'),
    settleWithin(fetchPingTargets(resolvedServer.id, 3), fetchBudgetMs, 'ping-targets'),
    settleWithin(fetchPingTargetHistory(resolvedServer.id, targetHistoryHours, historyLimit), fetchBudgetMs, 'ping-history'),
    settleWithin(fetchPingTargets(resolvedServer.id, 3, 'agent'), fetchBudgetMs, 'peer-ping-targets'),
  ]);

  const trafficData = traffic.status === 'fulfilled' ? traffic.value : null;
  const historyData = history.status === 'fulfilled' ? history.value : null;
  const pingData = ping.status === 'fulfilled' ? ping.value : null;
  const probeHistoryData = probeHistory.status === 'fulfilled' ? probeHistory.value : null;
  const pingTargetsData = pingTargets.status === 'fulfilled' ? pingTargets.value : null;
  const pingTargetHistoryData = pingTargetHistory.status === 'fulfilled' ? pingTargetHistory.value : null;
  const peerPingTargetsData = peerPingTargets.status === 'fulfilled' ? peerPingTargets.value : null;
  if (pingTargetsData?.targets?.length) recordLivePingSamples(pingTargetsData, Date.now(), resolvedServer.id);
  detailCache.pingTargets = pingTargetsData?.targets?.length ? pingTargetsData : detailCache.pingTargets;
  detailCache.pingTargetHistory = pingTargetHistoryData?.targets?.length ? pingTargetHistoryData : detailCache.pingTargetHistory;
  detailCache.peerPingTargets = peerPingTargetsData?.targets?.length ? peerPingTargetsData : detailCache.peerPingTargets;
  window.__DBG__.DETAIL_PING_TARGETS = detailCache.pingTargets || pingTargetsData;
  window.__DBG__.DETAIL_PEER_PING_TARGETS = detailCache.peerPingTargets || peerPingTargetsData;
  window.__DBG__.DETAIL_PING_TARGET_HISTORY = detailCache.pingTargetHistory || pingTargetHistoryData;
  const rv = calcResidualValue(resolvedServer);
  const pct = trafficData ? Number(trafficData.used_percent || 0) : (getTrafficPct(resolvedServer) || 0);
  const historyRows = normalizeHistory24h(historyData?.data || []);
  window.__DBG__.DETAIL_HISTORY_META = { days: detailDays, bucketMinutes: detailBucketMinutes, historyTotal: historyData?.total || 0, probeTotal: probeHistoryData?.total || 0 };
  detailCache.traffic = trafficData || detailCache.traffic;
  detailCache.historyRows = historyRows.length ? historyRows : detailCache.historyRows;
  const historySeries = historyRows.map((row) => Number(row.net_up || 0) + Number(row.net_down || 0));
  const trafficUpSeries = historyRows.map((row) => Number(row.net_up || 0));
  const trafficDownSeries = historyRows.map((row) => Number(row.net_down || 0));
  const chartLabels = historyRows.map((row, idx) => row.ts || row.time || row.timestamp || `T${idx + 1}`);
  loadStoredTelemetrySamples(resolvedServer.id);
  const probeRows = mergeTelemetryRows(normalizeWindowRows(probeHistoryData?.data || [], detailDays === 0 ? 12 : detailDays * 24));
  detailCache.probeRows = probeRows.length ? probeRows : detailCache.probeRows;
  const probeLabels = probeRows.map((row, idx) => row.created_at ? new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `P${idx + 1}`);
  const cpuSeries = numericMetricSeries(probeRows, 'cpu_use');
  const ramSeries = numericMetricSeries(probeRows, 'ram_use');
  const probeUpSeries = numericMetricSeries(probeRows, 'net_up');
  const probeDownSeries = numericMetricSeries(probeRows, 'net_down');
  const upSeries = probeUpSeries.some((v) => Math.abs(v) > 0.01) ? probeUpSeries : trafficUpSeries;
  const downSeries = probeDownSeries.some((v) => Math.abs(v) > 0.01) ? probeDownSeries : trafficDownSeries;
  const latencySeries = probeRows.map((row) => row.latency_ms == null ? null : Number(row.latency_ms));
  const heartbeatSeries = probeRows.map((row) => row.status || 'unknown');
  const freshMeta = detailFreshnessMeta(probeRows, resolvedServer);
  const heartbeatUp = heartbeatSeries.filter((s) => s === 'online').length;
  const heartbeatTotal = heartbeatSeries.length || 1;
  const heartbeatPct = ((heartbeatUp / heartbeatTotal) * 100).toFixed(1);
  const assetNarrative = buildAssetNarrative(resolvedServer, rv, pct, pingData);
  const assetRiskChips = buildAssetRiskChips(resolvedServer, rv, pct, heartbeatPct, pingData);
  const healthNarrative = buildHealthNarrative(resolvedServer, heartbeatPct, cpuSeries, ramSeries, latencySeries, pingData);
  const trendNarrative = buildTrendNarrative(cpuSeries, ramSeries, historySeries);
  const displayCpuSeries = ensureDenseSeries(cpuSeries).map((v) => Math.min(100, v));
  const displayRamSeries = ensureDenseSeries(ramSeries).map((v) => Math.min(100, v));
  const displayUpSeries = smoothNumericSeries(ensureDenseSeries(upSeries), 5);
  const displayDownSeries = smoothNumericSeries(ensureDenseSeries(downSeries), 5);
  const networkUseProbe = probeRows.length >= 3 && (probeUpSeries.some((v) => Math.abs(v) > 0.01) || probeDownSeries.some((v) => Math.abs(v) > 0.01));
  const networkUpSeries = networkUseProbe ? smoothNumericSeries(probeUpSeries, 5) : (trafficUpSeries.length ? smoothNumericSeries(trafficUpSeries, 5) : displayUpSeries);
  const networkDownSeries = networkUseProbe ? smoothNumericSeries(probeDownSeries, 5) : (trafficDownSeries.length ? smoothNumericSeries(trafficDownSeries, 5) : displayDownSeries);
  const networkLabels = networkUseProbe ? probeLabels : (chartLabels.length ? chartLabels : probeLabels);

  window.__DBG__.DETAIL_TRACE.push('before-grid-html');
  const detailGrid = document.getElementById('detailPageGrid');
  detailGrid.setAttribute('aria-busy', 'false');
  detailGrid.innerHTML = renderDetailConsole({
    resolvedServer,
    probeRows,
    pingTargetsData,
    peerPingTargetsData: detailCache.peerPingTargets || peerPingTargetsData,
    pingData,
    trafficData,
    upSeries,
    downSeries,
    displayUpSeries,
    displayDownSeries,
    displayCpuSeries,
    displayRamSeries,
    freshMeta,
    stateServers: state.servers,
    detailDays,
    detailBucketMinutes,
    detailCachedPingTargets: detailCache.pingTargets,
    detailCachedPeerPingTargets: detailCache.peerPingTargets,
    helpers: {
      renderFleetShip,
      formatZhDuration,
      formatExpiryCountdown,
      statusLabel,
      renderHealthSummary,
      pctFmt,
      maskIpForPublicDisplay,
      renderCompactNodeFacts,
      renderFleetInsignia,
      renderRealtimeResourcePanels,
      detailRateValue,
      detailMetricValue,
      renderNodeDatabaseRows,
      renderProbeRows,
    },
  });

  detailGrid.querySelector('.detail-history-range')?.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-detail-history-days]');
    if (!button) return;
    event.preventDefault();
    setDetailHistoryDays(button.dataset.detailHistoryDays);
  });

  if (detailStarmapUnmount) { detailStarmapUnmount(); detailStarmapUnmount = null; }
  detailStarmapUnmount = mountGlobeStarmap(document.getElementById('detailGlobeStarmapMount'), state.servers, {
    width: 860,
    height: 440,
    baseRadius: 185,
    showInfoPanel: false,
    originServerId: resolvedServer.id,
  });
  window.__DBG__.DETAIL_STARMAP_MOUNTED = !!detailStarmapUnmount;
  window.__DBG__.DETAIL_TRACE.push('before-charts');
  await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData, probeLabels, cpuSeries, ramSeries, probeRows, pingTargetsData: detailCache.pingTargets || pingTargetsData, pingTargetHistoryData: detailCache.pingTargetHistory || pingTargetHistoryData, latestServer: resolvedServer, detailDays });
  refreshDetailProbeTargetsNow(resolvedServer.id);
  initNetworkTooltip();
  startDetailRealtimeRefresh(resolvedServer.id);
  window.__DBG__.DETAIL_TRACE.push('done');
  } catch (error) {
    window.__DBG__.DETAIL_TRACE_ERROR = String(error?.stack || error);
    console.error('renderDetailPage failed', error);
    const grid = document.getElementById('detailPageGrid');
    if (grid) grid.innerHTML = `<div class="detail-error">详情渲染失败：${escapeHtml(error?.message || error)}</div>`;
  }
}




function denseFallbackSeries(seed = 1, len = 24, base = 18, amp = 22) {
  const out = [];
  let x = seed * 97;
  for (let i = 0; i < len; i += 1) {
    x = (x * 1664525 + 1013904223) % 4294967296;
    const n = x / 4294967296;
    const wave = Math.sin((i + seed) * 0.72) * amp * 0.42 + Math.cos((i + seed) * 0.31) * amp * 0.24;
    const spike = (i % (5 + seed % 3) === 0) ? amp * (0.55 + n * 0.9) : 0;
    out.push(Math.max(0, +(base + wave + spike + n * amp * 0.55).toFixed(2)));
  }
  return out;
}

function ensureDenseSeries(series) {
  return (Array.isArray(series) ? series : []).map(Number).filter((v) => Number.isFinite(v));
}


async function renderDetailMonitorCharts(args) {
  return renderDetailMonitorChartsModule(args, {
    detailCharts,
    rowTimeMs,
    formatHourTickWithDate,
    formatTooltipClock,
    telemetryTooltipTime,
    seriesWindowFromRows,
    freshnessWindowFromRows,
    adaptiveRollingBounds,
    fitSeriesToRollingAxis,
    buildPingDatasets,
    accumulatingAxisBoundsFromTimes,
    fmtRate,
    pingStepLabel,
    PING_AXIS_STEPS_MS,
    latestTimelineMs,
    getDetailPingSampleCache: () => detailPingSamples.store,
  });
}

async function loadServers() {
  try {
    const payload = await listServersPublic();
    const rows = Array.isArray(payload?.servers) ? payload.servers : [];
    state.servers = await enrichServersWithIpGeo(rows.map(normalizeServer));
    state.serversUpdatedAt = new Date().toISOString();
    state.serversSource = '后台接口 /api/v1/servers + IP 坐标定位';
    window.__DBG__.LAST_SERVER_PAYLOAD = payload;
    console.log('[display] loaded servers', state.servers.map(s => s.name));
    safeStorageSet('vps_servers', JSON.stringify(state.servers));
    renderSunBadge();
    renderMoonPanel();
  } catch (error) {
    window.__DBG__.LAST_LOAD_ERROR = { message: error?.message || String(error), stack: error?.stack || '' };
    console.warn('[display] public servers fetch failed, fallback to seeded state', error);
  }
}


async function refreshDisplayServers() {
  if (selectedServerId) return;
  await loadServers();
  if (globe) globe.setServers(state.servers);
  if (overviewMode && document.querySelector('.public-overview-page')) {
    renderPublicOverviewPage();
    window.__DBG__.OVERVIEW_LAST_REFRESH = { at: new Date().toISOString(), count: state.servers.length, names: state.servers.map((s) => s.name) };
  }
  renderMoonPanel();
}

function stopDetailRealtimeRefresh() {
  stopDetailRefreshTimer();
}

let detailRefreshInFlight = false;
const detailPingSamples = createDetailPingSampleCache({ pingStepValue });
const DETAIL_PING_SAMPLE_WINDOW_MS = detailPingSamples.windowMs;
const detailTelemetrySamples = createDetailTelemetrySampleCache();
function loadStoredTelemetrySamples(serverId) { detailTelemetrySamples.loadStored(serverId); }
function recordLiveTelemetrySample(server = null, fetchedAt = Date.now()) {
  detailTelemetrySamples.record(server, fetchedAt);
}
function mergeTelemetryRows(rows = []) {
  const backendRows = Array.isArray(rows) ? rows : [];
  const sourceRows = backendRows;
  const bySecond = new Map();
  for (const row of sourceRows) {
    const t = Number(row.__timeMs) || rowTimeMs(row, NaN);
    if (!Number.isFinite(t)) continue;
    bySecond.set(String(Math.round(t / 1000)), { ...row, __timeMs: t, created_at: row.created_at || new Date(t).toISOString() });
  }
  return Array.from(bySecond.values()).sort((a, b) => Number(a.__timeMs) - Number(b.__timeMs));
}
function loadStoredPingSamples(serverId) { detailPingSamples.loadStored(serverId); }
let overviewRefreshTimer = null;

async function refreshDetailRealtime(serverId) {
  if (detailRefreshInFlight) return;
  if (!document.getElementById('detailRealtimePanels')) return;
  detailRefreshInFlight = true;
  try {
  // 详情页只刷新当前节点遥测，不再每轮全量重拉服务器列表(避免重复统计/重渲染循环)
  const current = state.servers.find((item) => Number(item.id) === Number(serverId));
  if (!current) return;
  const now = Date.now();
  const doHeavy = now - getDetailHeavyRefreshAt() > 60000;
  if (doHeavy) {
    const shouldRefreshPingTargets = !detailCache.pingTargets?.targets?.length || now - getDetailPingTargetsFetchedAt() > 15000;
    const [traffic, history, probeHistory, pingTargets, pingTargetHistory] = await Promise.allSettled([
      fetchJson(`${API_ROOT}/api/v1/traffic/public/${current.id}`, { timeoutMs: 1000 }),
      fetchJson(`${API_ROOT}/api/v1/traffic/public/${current.id}/history?days=${getDetailHistoryDays()}&bucket_minutes=${getDetailHistoryBucketMinutes(getDetailHistoryDays())}&limit=${getDetailHistoryDays() === 0 ? 14400 : 2000}`, { timeoutMs: 3000 }),
      fetchServerHistory(current.id, getDetailHistoryDays() === 0 ? 1 : getDetailHistoryDays(), getDetailHistoryDays() === 0 ? 14400 : 2000, getDetailHistoryBucketMinutes(getDetailHistoryDays())),
      shouldRefreshPingTargets ? fetchPingTargets(current.id, 3) : Promise.resolve(detailCache.pingTargets),
      shouldRefreshPingTargets ? fetchPingTargetHistory(current.id, 12, getDetailHistoryDays() === 0 ? 14400 : 2000) : Promise.resolve(detailCache.pingTargetHistory),
    ]);
    detailCache.traffic = traffic.status === 'fulfilled' ? traffic.value : detailCache.traffic;
    detailCache.historyRows = normalizeHistory24h((history.status === 'fulfilled' ? history.value?.data : detailCache.historyRows) || []);
    detailCache.probeRows = normalizeWindowRows((probeHistory.status === 'fulfilled' ? probeHistory.value?.data : detailCache.probeRows) || [], getDetailHistoryDays() === 0 ? 12 : Math.max(1, getDetailHistoryDays()) * 24);
    if (pingTargets.status === 'fulfilled' && (pingTargets.value?.targets?.length || pingTargets.value?.unavailable)) {
      detailCache.pingTargets = pingTargets.value;
      setDetailPingTargetsFetchedAt(now);
      window.__DBG__.DETAIL_PING_TARGETS = detailCache.pingTargets;
      if (pingTargets.value?.targets?.length) recordLivePingSamples(pingTargets.value, now, current.id);
    }
    if (pingTargetHistory.status === 'fulfilled' && (pingTargetHistory.value?.targets?.length || pingTargetHistory.value?.unavailable)) {
      detailCache.pingTargetHistory = pingTargetHistory.value;
      window.__DBG__.DETAIL_PING_TARGET_HISTORY = detailCache.pingTargetHistory;
    }
    setDetailHeavyRefreshAt(now);
  }
  const historyRows = detailCache.historyRows;
  const probeRows = mergeTelemetryRows(detailCache.probeRows);
  const trafficUpSeries = historyRows.map((row) => Number(row.net_up || 0));
  const trafficDownSeries = historyRows.map((row) => Number(row.net_down || 0));
  const probeUpSeries = numericMetricSeries(probeRows, 'net_up');
  const probeDownSeries = numericMetricSeries(probeRows, 'net_down');
  const upSeries = smoothNumericSeries(probeUpSeries.some((v) => Math.abs(v) > 0.01) ? probeUpSeries : trafficUpSeries, 5);
  const downSeries = smoothNumericSeries(probeDownSeries.some((v) => Math.abs(v) > 0.01) ? probeDownSeries : trafficDownSeries, 5);
  const cpuSeries = numericMetricSeries(probeRows, 'cpu_use');
  const ramSeries = numericMetricSeries(probeRows, 'ram_use');
  const chartLabels = historyRows.map((row, idx) => row.ts || row.time || row.timestamp || `T${idx + 1}`);
  const probeLabels = probeRows.map((row, idx) => row.created_at ? new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `P${idx + 1}`);
  const panel = document.getElementById('detailRealtimePanels');
  const runtimeEnvironmentCard = panel?.querySelector('.runtime-env-card')?.outerHTML || '';
  if (panel) panel.outerHTML = renderRealtimeResourcePanels(current, detailCache.traffic, upSeries, downSeries, cpuSeries, ramSeries, runtimeEnvironmentCard);
  applyLanguage();
  const freshMeta = detailFreshnessMeta(probeRows, current);
  const latestSampleMs = freshMeta.latestMs;
  const sourceAge = freshMeta.ageSec;
  const freshnessStrong = document.querySelector('.data-freshness-card .fleet-chart-head strong');
  if (freshnessStrong) freshnessStrong.textContent = sourceAge == null ? '—' : `${sourceAge}s`;
  const freshnessMetaSample = document.querySelector('.data-freshness-card .freshness-meta span:first-child');
  if (freshnessMetaSample) freshnessMetaSample.textContent = `${t('sampleInterval')}: ${freshMeta.sampleSec ? `${freshMeta.sampleSec}s` : '—'}`;
  const healthSample = document.querySelector('[aria-label="运行健康摘要"] em');
  const freshnessLatest = document.querySelector('.data-freshness-card .freshness-latest');
  if (freshnessLatest) freshnessLatest.textContent = `${t('latestSample')}: ${Number.isFinite(latestSampleMs) ? new Date(latestSampleMs).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' }) : '—'}`;
  const pingHeadStrong = document.querySelector('.ping-multi-card .fleet-chart-head strong');
  if (pingHeadStrong) pingHeadStrong.textContent = detailCache.pingTargets?.unavailable ? '等待 agent' : `${(detailCache.pingTargets?.targets || []).length || 0} 目标`;
  const currentUpKbs = upSeries.slice(-1)[0] ?? current.net_up ?? null;
  const currentDownKbs = downSeries.slice(-1)[0] ?? current.net_down ?? null;
  const networkHeadStrong = document.querySelector(".network-throughput-card .fleet-chart-head strong");
  if (networkHeadStrong) networkHeadStrong.textContent = `↑ ${fmtRate(currentUpKbs)} · ↓ ${fmtRate(currentDownKbs)}`;
  if (doHeavy) {
    await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData: null, probeLabels, cpuSeries, ramSeries, probeRows, pingTargetsData: detailCache.pingTargets, pingTargetHistoryData: detailCache.pingTargetHistory, latestServer: current, detailDays: getDetailHistoryDays() });
    refreshDetailProbeTargetsNow(current.id);
  }
  initNetworkTooltip();
  window.__DBG__.DETAIL_LAST_REFRESH = { at: new Date().toISOString(), serverId, pollMs: 5000, heavy: doHeavy, sourceSampleMs: window.__DBG__.DETAIL_SOURCE_SAMPLE_MS || null, latestSampleAt: Number.isFinite(latestSampleMs) ? new Date(latestSampleMs).toISOString() : null, sourceAge, upKBs: currentUpKbs, downKBs: currentDownKbs, cpu: cpuSeries.slice(-1)[0] ?? current.cpu_use ?? null, ram: ramSeries.slice(-1)[0] ?? current.ram_use ?? null };
  } finally {
    detailRefreshInFlight = false;
  }
}

function startDetailRealtimeRefresh(serverId) {
  stopDetailRealtimeRefresh();
  setDetailHeavyRefreshAt(Date.now());
  startDetailRefreshTimer(() => refreshDetailRealtime(serverId).catch((error) => {
    window.__DBG__.DETAIL_REFRESH_ERROR = String(error?.stack || error);
    console.warn('[detail] realtime refresh failed', error);
  }), 5000);
  refreshDetailRealtime(serverId).catch((error) => {
    window.__DBG__.DETAIL_REFRESH_ERROR = String(error?.stack || error);
    console.warn('[detail] initial realtime refresh failed', error);
  });
}

function startSoftRefresh() {
  if (selectedServerId) return;
  if (overviewRefreshTimer) clearInterval(overviewRefreshTimer);
  overviewRefreshTimer = setInterval(refreshDisplayServers, 10000);
  window.__DBG__.OVERVIEW_REFRESH_TIMER = overviewRefreshTimer;
  window.__DBG__.OVERVIEW_REFRESH_INTERVAL_MS = 10000;
}

window.addEventListener('storage', async (e) => {
  if (e.key === 'vps-servers-version') await refreshDisplayServers();
});

window.addEventListener('servers-changed', refreshDisplayServers);
window.addEventListener('pageshow', refreshDisplayServers);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { selectedServerId ? refreshDetailRealtime(selectedServerId) : refreshDisplayServers(); } });
if (serversChannel) serversChannel.addEventListener('message', refreshDisplayServers);

window.__DBG__.LOAD_SERVERS = loadServers;

async function boot() {
  window.__DBG__.BOOT_TRACE = ['boot:start'];
  safeStorageRemove('vps_servers');
  setTheme(safeStorageGet('display_theme', 'dark') || 'dark');
  applyLanguage();
  await refreshExchangeRates();
  await loadServers();
  window.__DBG__.BOOT_TRACE.push('after-loadServers');
  if (location.pathname === '/verify-email') {
    await handleEmailVerificationRoute();
    return;
  } else if (location.pathname === '/reset-password') {
    handlePasswordResetRoute();
    return;
  } else if (selectedServerId) {
    window.__DBG__.BOOT_TRACE.push('branch:selectedServerId:' + selectedServerId);
    await renderDetailPage(selectedServerId);
    window.__DBG__.BOOT_TRACE.push('after-renderDetailPage');
  } else if (loginMode) {
    renderFrontLoginPage();
  } else if (overviewMode) {
    renderPublicOverviewPage();
    startSoftRefresh();
  } else {
    mountDisplayPage();
    initGlobe();
    startSoftRefresh();
  }
}

boot();


function ensureFrontLoginOverlay() {
  let overlay = document.getElementById('frontLoginOverlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'frontLoginOverlay';
  overlay.className = 'modal-overlay front-login-overlay';
  overlay.innerHTML = `
    <div class="modal front-login-modal astro-login-modal">
      <div class="astro-login-logo atlas-mark custom-login-logo" aria-label="VPS 星图">
        <img src="/assets/custom/login-logo-transparent.png" alt="VPS 星图" />
      </div>
      <div class="astro-login-kicker">VPS Star Atlas</div>
      <h3 class="modal-title astro-login-title">星图身份认证</h3>
      <div class="front-login-desc astro-login-desc">从太阳入口进入控制台。选择第三方身份或管理员密码，接管全球 VPS 节点视图。</div>
      <div class="front-login-oauth">
        <a id="frontLoginGoogle" class="front-oauth-btn google disabled" href="#" aria-disabled="true"><span class="front-oauth-mark">G</span><b>使用 Google 登录</b><small>检测配置中</small></a>
        <a id="frontLoginGithub" class="front-oauth-btn github disabled" href="#" aria-disabled="true"><span class="front-oauth-mark">⌘</span><b>使用 GitHub 登录</b><small>检测配置中</small></a>
      </div>
      <div class="front-login-separator"><span>或使用管理员密码</span></div>
      <div class="front-login-form">
        <input id="frontLoginUser" class="front-login-input" placeholder="用户名" value="admin" autocomplete="username" />
        <input id="frontLoginPass" class="front-login-input" placeholder="密码" type="password" autocomplete="current-password" />
        <div id="frontLoginError" class="front-login-error"></div>
        <div class="front-login-actions">
          <button id="frontLoginCancel" class="add-btn ghost" type="button">返回星图</button>
          <button id="frontLoginSubmit" class="add-btn primary" type="button">进入后台</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const returnToStarMap = () => {
    overlay.classList.remove('open', 'standalone');
    document.body.classList.remove('front-login-page-mode');
    window.location.href = '/';
  };
  // Only the explicit "返回星图" button returns. Blank/background clicks must not navigate away.
  overlay.querySelector('#frontLoginCancel').addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    returnToStarMap();
  });
  const configureOAuthButton = (provider, enabled) => {
    const el = overlay.querySelector(provider === 'google' ? '#frontLoginGoogle' : '#frontLoginGithub');
    if (!el) return;
    el.classList.toggle('disabled', !enabled);
    el.setAttribute('aria-disabled', enabled ? 'false' : 'true');
    el.querySelector('small').textContent = enabled ? '已启用' : '未配置';
    el.href = enabled ? oauthLoginUrl(provider) : '#';
    el.onclick = enabled ? null : (event) => {
      event.preventDefault();
      const err = overlay.querySelector('#frontLoginError');
      if (err) err.textContent = `${provider === 'google' ? 'Google' : 'GitHub'} 登录尚未在后端配置`;
    };
  };
  configureOAuthButton('google', false);
  configureOAuthButton('github', false);
  getOAuthProviders().then((res) => {
    const providers = res?.providers || res || {};
    configureOAuthButton('google', !!providers.google);
    configureOAuthButton('github', !!providers.github);
  }).catch(() => {
    configureOAuthButton('google', false);
    configureOAuthButton('github', false);
  });
  overlay.querySelector('#frontLoginSubmit').addEventListener('click', async () => {
    const user = overlay.querySelector('#frontLoginUser').value.trim();
    const pass = overlay.querySelector('#frontLoginPass').value;
    const err = overlay.querySelector('#frontLoginError');
    err.textContent = '';
    try {
      await publicLogin(user, pass);
      if (loginNext === 'overview') {
        window.location.href = '/?overview=1';
      } else {
        window.location.href = '/admin.html';
      }
    } catch (error) {
      err.textContent = error?.message || '登录失败';
    }
  });
  overlay.querySelector('#frontLoginPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') overlay.querySelector('#frontLoginSubmit').click();
  });
  return overlay;
}

window.openFrontLogin = function openFrontLogin() {
  window.location.href = '/?login=1';
};

window.openMoonOverview = function openMoonOverview() {
  window.location.href = '/?overview=1';
};
