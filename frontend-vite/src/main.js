import './globals/dashboardGlobals.js';
import { login as publicLogin, getOAuthProviders, oauthLoginUrl, verifyEmailToken, resetPasswordWithToken } from './api/auth.js';
import './styles/main.css';
import './styles/detail-starfleet-console.css';

import { state } from './store/state.js';
import { listServersPublic } from './api/public.js';
import { CesiumGlobe } from './components/CesiumGlobe.js';
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
import { renderDetailMonitorCharts as renderDetailMonitorChartsModule } from './pages/detailCharts.js';
import { getDetailHistoryDays, getDetailHistoryBucketMinutes, getDetailHistoryPointLimit, setDetailHistoryDays as setDetailHistoryDaysModule, syncDetailHistoryStateFromStorage } from './detail/historyRange.js';
import { getDetailHeavyRefreshAt, getDetailPingTargetsFetchedAt, setDetailHeavyRefreshAt, setDetailPingTargetsFetchedAt, startDetailRefreshTimer, stopDetailRefreshTimer } from './detail/refreshState.js';
import { detailCache } from './detail/detailCache.js';
import { createDetailPingSampleCache } from './detail/sampleCache.js';
import { getGlobeRuntimeDebug } from './utils/debugState.js';
import { buildClusterScreenFanout, resolveClusterSelection } from './components/globe/vpsClusterInteraction.js';
import { groupClusterMembers } from './services/serverGroups.js';
import { clusterServersByCoordinate } from './components/globe/vpsClusters.js';

let globe = null;
let starshipShowcase = null;
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
  refreshDetailPresentation,
});

let detailHistoryDays = syncDetailHistoryStateFromStorage(1);
window.__DBG__.DETAIL_HISTORY_DAYS = detailHistoryDays; // debug/read-only compatibility
function setDetailHistoryDays(days) {
  detailHistoryDays = setDetailHistoryDaysModule(days, refreshDetailHistoryRange);
}

function setCurrency(currency) {
  state.currency = currency;
  document.querySelectorAll('.currency-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn.dataset.currency || btn.textContent.trim()) === currency);
  });
  updateRateDisplay();
  if (selectedServerId) refreshDetailPresentation({ currencyChanged: true });
  else if (overviewMode) renderPublicOverviewPage();
}

// Preferences are presentation-only on a mounted detail page. Re-running the
// full renderer would replace the canvas/map nodes and make a simple select
// change look like a page reload while all history requests are repeated.
function refreshDetailPresentation({ languageChanged = false, currencyChanged = false } = {}) {
  const detailGrid = document.getElementById('detailPageGrid');
  if (!selectedServerId || !detailGrid) return;
  applyLanguage();
  updateRateDisplay();
  window.__DBG__.DETAIL_PRESENTATION_REFRESH = {
    languageChanged,
    currencyChanged,
    language: currentLanguage,
    currency: state.currency,
    grid: detailGrid,
  };
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
        <div id="starship-gltf-stage" class="starship-gltf-stage"></div>
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
let clusterPicker = null;

function closeClusterInteraction() {
  globe?.clearClusterFanout?.();
  clusterPicker?.remove();
  clusterPicker = null;
}

function navigateToServer(server) {
  if (server?.id != null) window.location.href = `/?server=${server.id}`;
}

function showClusterMemberPicker(members, selectedGroup = null) {
  clusterPicker?.remove();
  const panel = document.createElement('section');
  panel.className = 'cluster-member-picker';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', '同一位置的节点');
  const heading = document.createElement('h2');
  heading.textContent = selectedGroup ? `${selectedGroup.name} · ${members.length} 个节点` : `同一位置的 ${members.length} 个节点`;
  panel.appendChild(heading);
  const closeButton = document.createElement('button');
  closeButton.type = 'button'; closeButton.className = 'cluster-picker-close'; closeButton.textContent = '关闭';
  closeButton.addEventListener('click', closeClusterInteraction);
  panel.appendChild(closeButton);
  for (const group of groupClusterMembers(members)) {
    if (!selectedGroup) {
      const groupHeading = document.createElement('h3'); groupHeading.textContent = group.name; panel.appendChild(groupHeading);
      if (group.purpose) { const purposeHeading = document.createElement('h4'); purposeHeading.textContent = group.purpose; panel.appendChild(purposeHeading); }
    }
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
  const fanout = buildClusterScreenFanout({
    members,
    viewportWidth: globe?.container?.clientWidth,
    viewportHeight: globe?.container?.clientHeight,
  });
  globe?.expandClusterFanout?.({ clusterKey: cluster.key, lat: cluster.lat, lon: cluster.lon, fanout, onMemberClick: (group) => showClusterMemberPicker(group.members, group) });
}

function handleGlobeNodeSelection(server, clusterMembers, cluster) {
  const canonicalCluster = clusterServersByCoordinate(state.servers)
    .find((candidate) => candidate.members.some((member) => String(member.id) === String(server?.id)));
  const inferredMembers = canonicalCluster?.members || (clusterMembers?.length ? clusterMembers : [server]);
  const selection = resolveClusterSelection(inferredMembers);
  if (selection.type === 'navigate') { closeClusterInteraction(); navigateToServer(selection.member); return; }
  // Labels and Cesium picks only carry lightweight cluster metadata. Always use the
  // canonical live cluster for a valid centroid before creating visual-only fanout.
  const fanoutCluster = canonicalCluster || cluster;
  const hasFanoutCentroid = Number.isFinite(Number(fanoutCluster?.lat)) && Number.isFinite(Number(fanoutCluster?.lon));
  if (typeof globe?.expandClusterFanout === 'function' && hasFanoutCentroid) showClusterFanout(fanoutCluster, selection.members);
}

function getGlobe() {
  if (globe) return globe;
  // Cesium earth only. Starship stays on independent Three.js StarshipShowcase —
  // Enterprise GLB is not Cesium-compatible (attribute validation fails).
  globe = new CesiumGlobe('#globe-container', state.servers, {
    onNodeClick: handleGlobeNodeSelection,
    onBlankClick: closeClusterInteraction,
    enableStarship: false,
  });
  getGlobeRuntimeDebug().globeMode = 'cesium-earth-independent-starship-showcase';
  const stage = document.getElementById('starship-gltf-stage');
  // Mobile: skip the 55MB Enterprise GLB + independent Three.js renderer entirely.
  // It is the single largest homepage cost and the main cause of phone jank; the
  // Cesium earth alone is enough on small screens.
  const isMobileViewport = typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(max-width: 720px)').matches;
  if (isMobileViewport && stage) {
    stage.style.display = 'none';
    getGlobeRuntimeDebug().starshipSkipped = 'mobile-viewport';
    window.__DBG__.starshipRenderer = 'skipped-mobile';
  }
  if (stage && !isMobileViewport) {
    try { starshipShowcase?.destroy?.(); } catch (_) {}
    try {
      starshipShowcase = new StarshipShowcase(stage, {
        // Full original xinjian1 (textures + denser meshes) from /root/xinjian1.glb.
        // Keep fail-soft behavior rather than fetching a duplicate 55MB legacy URL.
        modelUrl: '/globe/xinjian1.glb?v=20260728',
        fallbackModelUrl: '',
        deferMs: 1200,
      });
      window.__starshipShowcase = starshipShowcase;
      window.__DBG__.starshipShowcase = starshipShowcase;
      window.__DBG__.starshipRenderer = 'three-showcase';
    } catch (error) {
      console.warn('[homepage] starship showcase failed; globe continues', error);
      window.__DBG__.starshipError = String(error?.message || error);
      starshipShowcase = null;
    }
  }
  renderSunBadge();
  renderMoonPanel();
  window.__DBG__.globe = globe;
  return globe;
}

function initGlobe() {
  const instance = getGlobe();
  instance.updateServers(state.servers);
  renderSunBadge();
  renderMoonPanel();
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

function normalizePersistedTimelineRows(rows = [], hours = 2) {
  const fullSpan = Math.max(1, Number(hours) || 2) * 60 * 60 * 1000;
  const bucket = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row, idx) => {
    const parsed = rowTimeMs(row, NaN);
    if (!Number.isFinite(parsed)) return;
    const key = String(Math.round(parsed / 1000));
    const prev = bucket.get(key);
    if (!prev || idx > prev.idx) bucket.set(key, { idx, row, t: parsed });
  });
  const timeline = Array.from(bucket.values()).sort((a, b) => a.t - b.t);
  const lastPersistedProbeMs = timeline.at(-1)?.t;
  if (!Number.isFinite(lastPersistedProbeMs)) return [];
  const start = lastPersistedProbeMs - fullSpan;
  return timeline.filter(({ t }) => t >= start && t <= lastPersistedProbeMs).map(({ row, t }) => ({ row, t }));
}

function seriesWindowFromRows(rows = [], key, hours = 2) {
  const points = normalizePersistedTimelineRows(rows, hours)
    .map(({ row, t }) => {
      const raw = row?.[key];
      return { x: t, y: raw == null || raw === '' ? NaN : Number(raw) };
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  return points;
}

function latestTimelineMs(rows = []) {
  const points = normalizePersistedTimelineRows(rows, Number.MAX_SAFE_INTEGER / (60 * 60 * 1000)).map(({ t }) => t).filter(Number.isFinite);
  return points.length ? points[points.length - 1] : NaN;
}

function freshnessWindowFromRows(rows = [], hours = 2) {
  const sorted = normalizePersistedTimelineRows(rows, hours).map(({ t }) => t);
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
  // Cold-start: X axis anchors at the first real sample and grows forward.
  // Only after a full window of data has accumulated does the axis roll with the latest sample.
  // Never right-align sparse data (that makes CPU/memory/freshness appear to draw right-to-left).
  const fullSpan = hours * 60 * 60 * 1000;
  const xs = pointGroups.flat().map((point) => Number(point?.x)).filter(Number.isFinite).sort((a, b) => a - b);
  const dataFirst = xs.length ? xs[0] : 0;
  const dataLast = xs.length ? xs[xs.length - 1] : dataFirst;
  const coldMax = dataFirst + fullSpan;
  const rolling = xs.length > 0 && dataLast >= coldMax;
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
  // Never wipe local history just because one unavailable payload arrives.
  // Global VPS peer probes also return unavailable when no samples yet; that must
  // not clear PING sample cache for external latency-monitor targets.
  if (pingTargetsData?.unavailable && !(Array.isArray(pingTargetsData?.targets) && pingTargetsData.targets.length)) {
    return;
  }
  const targets = (Array.isArray(pingTargetsData?.targets) ? pingTargetsData.targets : []).filter((t) => t.type !== 'peer' && !String(t?.key || '').startsWith('vps-'));
  if (!targets.length) return;
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
      const exists = samples.some((p) => Math.abs(p.x - x) < 900 && Math.abs(p.rawMs - rawMs) < 0.05);
      if (!exists) samples.push({ x, y: pingStepValue(rawMs), rawMs, success: true, label, key, protocol, lossPct });
    }
    // If the live payload only has aggregate stats (common on first paint), seed one point.
    if (!rows.length) {
      const avg = Number(target?.stats?.avg_ms);
      if (Number.isFinite(avg) && avg >= 0) {
        const exists = samples.some((p) => Math.abs(p.x - fetchedAt) < 5000);
        if (!exists) samples.push({ x: fetchedAt, y: pingStepValue(avg), rawMs: avg, success: true, label, key, protocol, lossPct });
      }
    }
    samples.sort((a, b) => a.x - b.x);
    detailPingSamples.prune(key, cutoff);
  }
  detailPingSamples.expose();
  detailPingSamples.saveStored(serverId || pingTargetsData?.server_id);
}

function seedPingSamplesFromHistory(historyData = null, serverId = null) {
  // Backend history already has multi-hour points. On each detail open we must
  // hydrate local cache so the PING chart does not restart from zero.
  const targets = Array.isArray(historyData?.targets) ? historyData.targets : [];
  if (!targets.length) return 0;
  const cutoff = Date.now() - DETAIL_PING_SAMPLE_WINDOW_MS;
  let added = 0;
  for (const target of targets) {
    const key = String(target?.key || target?.host || target?.label || 'unknown');
    if (!key || key.startsWith('vps-') || target?.type === 'peer') continue;
    const label = target?.label || target?.name || target?.host || key;
    const protocol = target?.protocol || target?.stats?.protocol || 'icmp';
    const points = Array.isArray(target?.points)
      ? target.points
      : (Array.isArray(target?.results) ? target.results : []);
    if (!points.length) continue;
    const samples = detailPingSamples.ensure(key);
    for (const point of points) {
      const rawMs = Number(point?.latency_ms ?? point?.rawMs ?? point?.y);
      if (!Number.isFinite(rawMs) || rawMs < 0) continue;
      if (point?.success === false) continue;
      // History API returns x as ISO string (or epoch ms). Never Number(iso) which is NaN.
      let x = Number(point?.x);
      if (!Number.isFinite(x)) {
        const ts = Date.parse(point?.x || point?.created_at || point?.timestamp || point?.time || '');
        x = Number.isFinite(ts) ? ts : NaN;
      }
      if (!Number.isFinite(x) || x < cutoff) continue;
      const exists = samples.some((p) => Math.abs(p.x - x) < 1200 && Math.abs(Number(p.rawMs) - rawMs) < 0.05);
      if (exists) continue;
      samples.push({
        x,
        y: pingStepValue(rawMs),
        rawMs,
        success: true,
        label,
        key,
        protocol: point?.protocol || protocol,
        lossPct: Number(point?.loss_pct ?? target?.stats?.loss_pct ?? 0),
      });
      added += 1;
    }
    samples.sort((a, b) => a.x - b.x);
    detailPingSamples.prune(key, cutoff);
  }
  if (added) {
    detailPingSamples.expose();
    detailPingSamples.saveStored(serverId || historyData?.server_id);
  }
  return added;
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
      key,
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
    const key = String(target?.key || target?.host || target?.label || `target-${idx}`);
    const label = target?.label || target?.host || target?.key || `目标 ${idx + 1}`;
    const points = Array.isArray(target?.points) ? target.points : [];
    const data = points.map(point => {
      const rawMs = Number(point?.latency_ms ?? point?.rawMs);
      const x = rowTimeMs({ created_at: point?.x || point?.created_at || point?.time || point?.timestamp }, NaN);
      if (!Number.isFinite(rawMs) || !Number.isFinite(x) || x < cutoff || x > now + 60000) return null;
      return { x, y: pingStepValue(rawMs), rawMs, label, key: point?.key || target?.key, protocol: point?.protocol || target?.protocol, success: true, lossPct: point?.loss_pct ?? point?.lossPct ?? 0 };
    }).filter(Boolean).sort((a, b) => a.x - b.x);
    return {
      key,
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
  const persistedTargetDatasets = buildPersistedPingTargetDatasets(pingTargetHistoryData, hours);
  if (persistedTargetDatasets.length) return persistedTargetDatasets;
  const liveTargetDatasets = buildLivePingDatasets(pingTargetsData, hours);
  return liveTargetDatasets;
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

function normalizePersistedRows(rows = [], hours = 2) {
  return normalizePersistedTimelineRows(rows, hours).map(({ row, t }) => ({ ...row, __timeMs: t }));
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

function detailProcessMeta(rows = [], server = null) {
  const validCount = (value) => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
  const ordered = backendTelemetryRows(rows).filter((row) => validCount(row?.process_count));
  const latest = ordered.length
    ? Number(ordered[ordered.length - 1].process_count)
    : (validCount(server?.process_count) ? Number(server.process_count) : null);
  const count = Number.isFinite(latest) && latest >= 0 ? Math.round(latest) : null;
  return { count, countText: count == null ? '等待 agent 上报' : `${count} 个` };
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
  }).join('') : '<div class="probe-empty-row"><span>未配置延迟监测目标</span><em>请在后台「延迟监测」配置 ping_targets</em></div>');
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

function updateDetailPingTargetCount(pingTargetsData) {
  const count = Array.isArray(pingTargetsData?.targets) ? pingTargetsData.targets.length : 0;
  const countNode = document.querySelector('.detail-ping-target-count');
  if (countNode) countNode.textContent = `${count} 目标`;
  const healthLink = document.querySelector('.detail-health-summary > div:last-child em');
  if (healthLink) healthLink.textContent = pingTargetsData?.unavailable
    ? '暂无真实节点侧互探采样'
    : `${count} 个探测目标`;
}

function renderGlobalVpsProbeRows(vpsProbeTargetsData) {
  const raw = Array.isArray(vpsProbeTargetsData?.targets) ? vpsProbeTargetsData.targets : [];
  // Peer probes only: key vps-* / type peer / peer_server_id. Never mix external ping_targets.
  const targets = raw.filter((target) => {
    const key = String(target?.key || '');
    return key.startsWith('vps-') || target?.type === 'peer' || target?.peer_server_id != null;
  }).slice(0, 12);
  const unavailable = !!vpsProbeTargetsData?.unavailable;
  if (targets.length) {
    return targets.map((target) => {
      const ms = target.stats?.avg_ms != null ? Number(target.stats.avg_ms) : null;
      const loss = target.stats?.loss_pct != null ? Math.max(0, Number(target.stats.loss_pct)) : null;
      const label = target.label || target.key || 'peer';
      return `<tr><td>${label}</td><td>${ms != null ? ms.toFixed(0) : '—'}</td><td>${loss != null ? loss.toFixed(0) + '%' : '—'}</td><td>${probeLinkBar(ms, loss)}</td></tr>`;
    }).join('');
  }
  if (unavailable) {
    return '<tr class="probe-empty-row"><td colspan="4"><span>暂无节点侧互探采样</span><em>目标已识别，等待当前 VPS Agent 上报</em></td></tr>';
  }
  return '<tr class="probe-empty-row"><td colspan="4"><span>暂无其它 VPS 可互探</span><em>全球探针 = 当前节点 → 其它节点；仅 1 台时为空</em></td></tr>';
}

function renderProbeRows(pingTargetsData, pingData) {
  const targets = (pingTargetsData?.targets || []).slice(0, 6);
  if (targets.length) return targets.map((target) => {
    const ms = target.stats?.avg_ms != null ? Number(target.stats.avg_ms) : null;
    const loss = target.stats?.loss_pct != null ? Math.max(0, Number(target.stats.loss_pct)) : null;
    return `<tr><td>${target.label || 'probe'}</td><td>${ms != null ? ms.toFixed(0) : '—'}</td><td>${loss != null ? loss.toFixed(0) + '%' : '—'}</td><td>${probeLinkBar(ms, loss)}</td></tr>`;
  }).join('');
  return '<tr class="probe-empty-row"><td colspan="4"><span>未读取到延迟监测目标</span><em>请在后台「延迟监测」配置 ping_targets</em></td></tr>';
}

async function refreshDetailProbeTargetsNow(serverId) {
  if (!serverId) return null;
  try {
    // Global VPS peer probes come from source=agent, not external ping_targets.
    const data = await fetchPingTargets(serverId, 1, 'agent');
    if (!data) return null;
    detailCache.vpsProbeTargets = data?.targets?.length ? data : detailCache.vpsProbeTargets;
    window.__DBG__.DETAIL_GLOBAL_VPS_PROBE_TARGETS = detailCache.vpsProbeTargets || data;
    const tbody = document.querySelector('.fleet-probe-table-panel tbody');
    if (tbody) tbody.innerHTML = renderGlobalVpsProbeRows(detailCache.vpsProbeTargets || data);
    return data;
  } catch (error) {
    window.__DBG__.DETAIL_PROBE_TARGET_REFRESH_ERROR = String(error?.stack || error);
    console.warn('[detail] global vps probe target refresh failed', error);
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
  const requestedDetailDays = Number(getDetailHistoryDays() || 0) || 0;
  const detailDays = [1, 4, 7, 30, 90].includes(requestedDetailDays) ? requestedDetailDays : 1;
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
  const historyDays = detailDays;
  // Fixed range budgets: 1d/5m=288 points, 4d/20m=288, 7d/1h=168.
  // Never return a full raw one-second day (21,600 rows / multi-MB JSON).
  const historyLimit = getDetailHistoryPointLimit(detailDays);
  const targetHistoryHours = 6;
  const settleWithin = (promise, timeoutMs, label) => Promise.race([
    promise.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason })),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'rejected', reason: new Error(`${label || 'detail'} timeout`) }), timeoutMs)),
  ]);
  // First paint must never wait a full detail-history timeout. Render current
  // server snapshot after a short budget; the immediate background refresh below
  // backfills persisted series in place without holding cards/charts hostage.
  const fetchBudgetMs = isMobileDetail ? 1200 : 1800;
  window.__DBG__.DETAIL_TRACE.push('before-fetches');
  // servers/history returns cpu/ram/disk/net_up/net_down/latency — a superset of
  // traffic/history. Fetch it once (server-history) and derive the network
  // series from the same rows instead of scanning ProbeResult twice on load.
  // Critical path: static details + compact telemetry only. PING history is
  // deliberately started in parallel but must not hold the page/stellar map
  // hostage to a slow peer-history query.
  // History responses already include target metadata. Avoid separate slow
  // target-definition requests on first paint; the lightweight target refresh
  // runs later via refreshDetailProbeTargetsNow / realtime refresh.
  const externalPingPromise = settleWithin(
    fetchPingTargetHistory(resolvedServer.id, targetHistoryHours, historyLimit),
    fetchBudgetMs,
    'ping-history',
  );
  const peerPingPromise = settleWithin(
    fetchPingTargetHistory(resolvedServer.id, targetHistoryHours, historyLimit, 'agent'),
    fetchBudgetMs,
    'vps-probe-history',
  );
  // Fixed one-hour process monitor is independent of the selected history range.
  const processHistoryPromise = settleWithin(
    fetchServerHistory(resolvedServer.id, 1, 720, 0, 'process_count'),
    fetchBudgetMs,
    'process-history',
  );
  const [traffic, ping, probeHistory] = await Promise.all([
    settleWithin(fetchJson(`${API_ROOT}/api/v1/traffic/public/${resolvedServer.id}`, { timeoutMs: 1200 }), fetchBudgetMs, 'traffic'),
    settleWithin(fetchPing(resolvedServer), fetchBudgetMs, 'ping'),
    settleWithin(fetchServerHistory(resolvedServer.id, historyDays, historyLimit, detailBucketMinutes), fetchBudgetMs, 'server-history'),
  ]);

  const trafficData = traffic.status === 'fulfilled' ? traffic.value : null;
  const pingData = ping.status === 'fulfilled' ? ping.value : null;
  const probeHistoryData = probeHistory.status === 'fulfilled' ? probeHistory.value : null;
  // Network history is derived from the same server-history response.
  const historyData = probeHistoryData;
  // The first paint intentionally uses cached PING data (if any). The two
  // background promises below redraw only the charts/table when ready.
  const pingTargetsData = detailCache.pingTargets;
  const pingTargetHistoryData = detailCache.pingTargetHistory;
  const vpsProbeTargetsData = detailCache.vpsProbeTargets;
  const vpsProbeHistoryData = detailCache.vpsProbeHistory;

  // Hydrate PING chart from backend history first so reopen does not restart from zero.
  // Live targets then append the newest samples on top.
  if (pingTargetHistoryData?.targets?.length) {
    seedPingSamplesFromHistory(pingTargetHistoryData, resolvedServer.id);
  }
  if (pingTargetsData?.targets?.length) {
    recordLivePingSamples(pingTargetsData, Date.now(), resolvedServer.id);
  }
  detailCache.pingTargets = pingTargetsData?.targets?.length ? pingTargetsData : detailCache.pingTargets;
  detailCache.pingTargetHistory = pingTargetHistoryData?.targets?.length ? pingTargetHistoryData : detailCache.pingTargetHistory;
  detailCache.vpsProbeTargets = vpsProbeTargetsData || detailCache.vpsProbeTargets;
  detailCache.vpsProbeHistory = vpsProbeHistoryData || detailCache.vpsProbeHistory;
  window.__DBG__.DETAIL_PING_TARGETS = detailCache.pingTargets || pingTargetsData;
  window.__DBG__.DETAIL_PING_TARGET_HISTORY = detailCache.pingTargetHistory || pingTargetHistoryData;
  window.__DBG__.DETAIL_GLOBAL_VPS_PROBE_TARGETS = detailCache.vpsProbeTargets || vpsProbeTargetsData;
  window.__DBG__.DETAIL_GLOBAL_VPS_PROBE_HISTORY = detailCache.vpsProbeHistory || vpsProbeHistoryData;
  const rv = calcResidualValue(resolvedServer);
  const pct = trafficData ? Number(trafficData.used_percent || 0) : (getTrafficPct(resolvedServer) || 0);
  const historyRows = normalizePersistedRows(historyData?.data || [], 12);
  window.__DBG__.DETAIL_HISTORY_META = { days: detailDays, bucketMinutes: detailBucketMinutes, historyTotal: historyData?.total || 0, probeTotal: probeHistoryData?.total || 0 };
  detailCache.traffic = trafficData || detailCache.traffic;
  detailCache.historyRows = historyRows.length ? historyRows : detailCache.historyRows;
  const historySeries = historyRows.map((row) => Number(row.net_up || 0) + Number(row.net_down || 0));
  const trafficUpSeries = historyRows.map((row) => Number(row.net_up || 0));
  const trafficDownSeries = historyRows.map((row) => Number(row.net_down || 0));
  const chartLabels = historyRows.map((row, idx) => row.ts || row.time || row.timestamp || `T${idx + 1}`);
  const probeRows = normalizePersistedRows(probeHistoryData?.data || [], historyDays * 24);
  detailCache.probeRows = probeRows;
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
  const processMeta = detailProcessMeta(probeRows, resolvedServer);
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
    pingTargetsData: detailCache.pingTargets || pingTargetsData,
    vpsProbeTargetsData: detailCache.vpsProbeTargets || vpsProbeTargetsData,
    pingData,
    trafficData,
    upSeries,
    downSeries,
    displayUpSeries,
    displayDownSeries,
    displayCpuSeries,
    displayRamSeries,
    processMeta,
    stateServers: state.servers,
    detailDays,
    detailBucketMinutes,
    detailCachedPingTargets: detailCache.pingTargets,
    detailCachedVpsProbeTargets: detailCache.vpsProbeTargets,

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
      renderGlobalVpsProbeRows,
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
  await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData, probeLabels, cpuSeries, ramSeries, probeRows, processRows: detailCache.processRows, pingTargetsData: detailCache.pingTargets || pingTargetsData, pingTargetHistoryData: detailCache.pingTargetHistory || pingTargetHistoryData, vpsProbeTargetsData: detailCache.vpsProbeTargets || vpsProbeTargetsData, vpsProbeHistoryData: detailCache.vpsProbeHistory || vpsProbeHistoryData, detailDays });

  processHistoryPromise.then(async (history) => {
    const rows = history.status === 'fulfilled' ? normalizePersistedRows(history.value?.data || [], 1) : [];
    if (!rows.length) return;
    detailCache.processRows = rows;
    const meta = detailProcessMeta(rows, resolvedServer);
    const strong = document.querySelector('.process-count-card .fleet-chart-head strong');
    if (strong) strong.textContent = meta.countText;
    await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData, probeLabels, cpuSeries, ramSeries, probeRows, processRows: rows, pingTargetsData: detailCache.pingTargets, pingTargetHistoryData: detailCache.pingTargetHistory, vpsProbeTargetsData: detailCache.vpsProbeTargets, vpsProbeHistoryData: detailCache.vpsProbeHistory, detailDays });
  }).catch((error) => { window.__DBG__.DETAIL_PROCESS_PROGRESSIVE_ERROR = String(error?.message || error); });

  externalPingPromise.then(async (history) => {
    const historyData = history.status === 'fulfilled' ? history.value : null;
    if (historyData?.targets?.length) seedPingSamplesFromHistory(historyData, resolvedServer.id);
    // PING history contains the target metadata needed for the chart, so keep it
    // as both history and the initial target snapshot until the lightweight live
    // target refresh arrives later.
    detailCache.pingTargetHistory = historyData?.targets?.length ? historyData : detailCache.pingTargetHistory;
    detailCache.pingTargets = historyData?.targets?.length ? historyData : detailCache.pingTargets;
    window.__DBG__.DETAIL_PING_TARGETS = detailCache.pingTargets;
    window.__DBG__.DETAIL_PING_TARGET_HISTORY = detailCache.pingTargetHistory;
    updateDetailPingTargetCount(detailCache.pingTargets || historyData);
    await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData, probeLabels, cpuSeries, ramSeries, probeRows, pingTargetsData: detailCache.pingTargets, pingTargetHistoryData: detailCache.pingTargetHistory, vpsProbeTargetsData: detailCache.vpsProbeTargets, vpsProbeHistoryData: detailCache.vpsProbeHistory, detailDays });
  }).catch((error) => { window.__DBG__.DETAIL_PING_PROGRESSIVE_ERROR = String(error?.message || error); });

  peerPingPromise.then(async (history) => {
    const historyData = history.status === 'fulfilled' ? history.value : null;
    detailCache.vpsProbeHistory = historyData?.targets?.length ? historyData : detailCache.vpsProbeHistory;
    detailCache.vpsProbeTargets = historyData?.targets?.length ? historyData : detailCache.vpsProbeTargets;
    window.__DBG__.DETAIL_GLOBAL_VPS_PROBE_TARGETS = detailCache.vpsProbeTargets;
    window.__DBG__.DETAIL_GLOBAL_VPS_PROBE_HISTORY = detailCache.vpsProbeHistory;
    const tbody = document.querySelector('.fleet-probe-table-panel tbody');
    if (tbody) tbody.innerHTML = renderGlobalVpsProbeRows(detailCache.vpsProbeTargets || historyData);
    await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData, probeLabels, cpuSeries, ramSeries, probeRows, pingTargetsData: detailCache.pingTargets, pingTargetHistoryData: detailCache.pingTargetHistory, vpsProbeTargetsData: detailCache.vpsProbeTargets, vpsProbeHistoryData: detailCache.vpsProbeHistory, detailDays });
  }).catch((error) => { window.__DBG__.DETAIL_PEER_PING_PROGRESSIVE_ERROR = String(error?.message || error); });

  refreshDetailProbeTargetsNow(resolvedServer.id);
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
function loadStoredPingSamples(serverId) { detailPingSamples.loadStored(serverId); }
let overviewRefreshTimer = null;

async function refreshDetailHistoryRange(serverId) {
  const current = state.servers.find((item) => Number(item.id) === Number(serverId));
  if (!current || !document.getElementById('detailNetworkChart')) return;
  const requestedDetailDays = Number(getDetailHistoryDays() || 1) || 1;
  const detailDays = [1, 4, 7, 30, 90].includes(requestedDetailDays) ? requestedDetailDays : 1;
  const bucketMinutes = getDetailHistoryBucketMinutes(detailDays);
  const historyDays = detailDays;
  const limit = getDetailHistoryPointLimit(detailDays);
  const targetHours = 6;
  const startedAt = performance.now();
  window.__DBG__.DETAIL_RANGE_REFRESH = { serverId: Number(serverId), detailDays, bucketMinutes, status: 'loading' };
  document.querySelector('.history-range-bar')?.setAttribute('aria-busy', 'true');
  // Local skeleton: pulse the existing chart matrix in place instead of
  // rebuilding the detail shell or star map while history reloads.
  document.querySelector('.fleet-chart-matrix')?.classList.add('is-range-loading');
  try {
    // servers/history returns cpu/ram/disk/net_up/net_down/latency — a superset
    // of traffic/history. Fetch it once and derive the network series from the
    // same rows instead of scanning ProbeResult twice per range switch.
    const [probeHistory, externalPingHistory, peerPingHistory] = await Promise.allSettled([
      fetchServerHistory(current.id, historyDays, limit, bucketMinutes),
      fetchPingTargetHistory(current.id, targetHours, limit),
      fetchPingTargetHistory(current.id, targetHours, limit, 'agent'),
    ]);
    if (probeHistory.status === 'fulfilled') {
      const probeData = probeHistory.value?.data || [];
      detailCache.probeRows = normalizePersistedRows(probeData, historyDays * 24);
      detailCache.historyRows = normalizeHistory24h(probeData);
    }
    if (externalPingHistory.status === 'fulfilled') {
      detailCache.pingTargetHistory = externalPingHistory.value;
      if (externalPingHistory.value?.targets?.length) seedPingSamplesFromHistory(externalPingHistory.value, current.id);
    }
    if (peerPingHistory.status === 'fulfilled') detailCache.vpsProbeHistory = peerPingHistory.value;

    const historyRows = detailCache.historyRows || [];
    const probeRows = detailCache.probeRows || [];
    const trafficUpSeries = historyRows.map((row) => Number(row.net_up || 0));
    const trafficDownSeries = historyRows.map((row) => Number(row.net_down || 0));
    const probeUpSeries = numericMetricSeries(probeRows, 'net_up');
    const probeDownSeries = numericMetricSeries(probeRows, 'net_down');
    const upSeries = probeUpSeries.some((value) => Math.abs(value) > 0.01) ? probeUpSeries : trafficUpSeries;
    const downSeries = probeDownSeries.some((value) => Math.abs(value) > 0.01) ? probeDownSeries : trafficDownSeries;
    const chartLabels = historyRows.map((row, index) => row.ts || row.time || row.timestamp || `T${index + 1}`);
    const probeLabels = probeRows.map((row, index) => row.created_at ? new Date(row.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : `P${index + 1}`);
    await renderDetailMonitorCharts({
      chartLabels, upSeries, downSeries, probeLabels,
      cpuSeries: numericMetricSeries(probeRows, 'cpu_use'),
      ramSeries: numericMetricSeries(probeRows, 'ram_use'),
      probeRows,
      processRows: detailCache.processRows,
      pingTargetsData: detailCache.pingTargets,
      pingTargetHistoryData: detailCache.pingTargetHistory,
      vpsProbeTargetsData: detailCache.vpsProbeTargets,
      vpsProbeHistoryData: detailCache.vpsProbeHistory,
      detailDays,
    });
    document.querySelectorAll('[data-detail-history-days]').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.detailHistoryDays) === detailDays);
    });
    const label = document.querySelector('.history-range-label');
    if (label) label.textContent = `${detailDays === 0 ? '今天' : `${detailDays}天`} · ${bucketMinutes === 0 ? '实时' : `${bucketMinutes}分钟采样`}`;
    window.__DBG__.DETAIL_RANGE_REFRESH = {
      serverId: Number(serverId), detailDays, bucketMinutes, status: 'ready',
      elapsedMs: Math.round(performance.now() - startedAt),
      counts: { telemetry: probeRows.length, externalPingTargets: (detailCache.pingTargetHistory?.targets || []).length, peerPingTargets: (detailCache.vpsProbeHistory?.targets || []).length },
    };
  } catch (error) {
    window.__DBG__.DETAIL_RANGE_REFRESH = { serverId: Number(serverId), detailDays, bucketMinutes, status: 'error', error: String(error?.message || error) };
    console.warn('[detail] history-range refresh failed', error);
  } finally {
    document.querySelector('.history-range-bar')?.removeAttribute('aria-busy');
    document.querySelector('.fleet-chart-matrix')?.classList.remove('is-range-loading');
  }
}

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
    // PING is optional for a telemetry redraw. Bound it independently so a slow
    // target lookup cannot postpone CPU/network/freshness by tens of seconds.
    const settleRealtimePing = (promise) => Promise.race([
      promise,
      new Promise((resolve) => setTimeout(() => resolve(null), 1800)),
    ]);
    // server-history is a superset of traffic/history; fetch it once and derive
    // the network series from the same rows instead of a second ProbeResult scan.
    const [traffic, probeHistory, pingTargets, pingTargetHistory] = await Promise.allSettled([
      fetchJson(`${API_ROOT}/api/v1/traffic/public/${current.id}`, { timeoutMs: 1000 }),
      fetchServerHistory(current.id, getDetailHistoryDays(), getDetailHistoryPointLimit(getDetailHistoryDays()), getDetailHistoryBucketMinutes(getDetailHistoryDays())),
      shouldRefreshPingTargets ? settleRealtimePing(fetchPingTargets(current.id, 3)) : Promise.resolve(detailCache.pingTargets),
      shouldRefreshPingTargets ? settleRealtimePing(fetchPingTargetHistory(current.id, 6, getDetailHistoryPointLimit(getDetailHistoryDays()))) : Promise.resolve(detailCache.pingTargetHistory),
    ]);
    detailCache.traffic = traffic.status === 'fulfilled' ? traffic.value : detailCache.traffic;
    const heavyProbeData = probeHistory.status === 'fulfilled' ? probeHistory.value?.data : null;
    detailCache.historyRows = normalizeHistory24h(heavyProbeData || detailCache.historyRows || []);
    detailCache.probeRows = normalizePersistedRows(heavyProbeData || detailCache.probeRows || [], Math.max(1, getDetailHistoryDays()) * 24);
    if (pingTargets.status === 'fulfilled' && (pingTargets.value?.targets?.length || pingTargets.value?.unavailable)) {
      detailCache.pingTargets = pingTargets.value;
      setDetailPingTargetsFetchedAt(now);
      window.__DBG__.DETAIL_PING_TARGETS = detailCache.pingTargets;
      if (pingTargets.value?.targets?.length) recordLivePingSamples(pingTargets.value, now, current.id);
    }
    if (pingTargetHistory.status === 'fulfilled' && (pingTargetHistory.value?.targets?.length || pingTargetHistory.value?.unavailable)) {
      detailCache.pingTargetHistory = pingTargetHistory.value;
      window.__DBG__.DETAIL_PING_TARGET_HISTORY = detailCache.pingTargetHistory;
      if (pingTargetHistory.value?.targets?.length) seedPingSamplesFromHistory(pingTargetHistory.value, current.id);
    }
    setDetailHeavyRefreshAt(now);
  }
  const historyRows = detailCache.historyRows;
  const probeRows = detailCache.probeRows;
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
  const processMeta = detailProcessMeta(probeRows, current);
  const processStrong = document.querySelector('.process-count-card .fleet-chart-head strong');
  if (processStrong) processStrong.textContent = processMeta.countText;
  const processLatest = document.querySelector('.process-count-card .process-count-latest');
  if (processLatest) processLatest.textContent = processMeta.count == null ? '等待 agent 上报' : '主机级监控';
  const pingHeadStrong = document.querySelector('.ping-multi-card .fleet-chart-head strong');
  if (pingHeadStrong) pingHeadStrong.textContent = detailCache.pingTargets?.unavailable ? '等待 agent' : `${(detailCache.pingTargets?.targets || []).length || 0} 目标`;
  const currentUpKbs = upSeries.slice(-1)[0] ?? current.net_up ?? null;
  const currentDownKbs = downSeries.slice(-1)[0] ?? current.net_down ?? null;
  const networkHeadStrong = document.querySelector(".network-throughput-card .fleet-chart-head strong");
  if (networkHeadStrong) networkHeadStrong.textContent = `↑ ${fmtRate(currentUpKbs)} · ↓ ${fmtRate(currentDownKbs)}`;
  if (doHeavy) {
    await renderDetailMonitorCharts({ chartLabels, upSeries, downSeries, pingData: null, probeLabels, cpuSeries, ramSeries, probeRows, processRows: detailCache.processRows, pingTargetsData: detailCache.pingTargets, pingTargetHistoryData: detailCache.pingTargetHistory, detailDays: getDetailHistoryDays() });
    refreshDetailProbeTargetsNow(current.id);
  }
  window.__DBG__.DETAIL_LAST_REFRESH = { at: new Date().toISOString(), serverId, pollMs: 5000, heavy: doHeavy, processCount: processMeta.count, upKBs: currentUpKbs, downKBs: currentDownKbs, cpu: cpuSeries.slice(-1)[0] ?? current.cpu_use ?? null, ram: ramSeries.slice(-1)[0] ?? current.ram_use ?? null };
  } finally {
    detailRefreshInFlight = false;
  }
}

function startDetailRealtimeRefresh(serverId) {
  stopDetailRealtimeRefresh();
  // Force the initial 5-second refresh invocation to fetch persisted telemetry
  // immediately; subsequent heavy refreshes remain rate-limited to once/minute.
  setDetailHeavyRefreshAt(0);
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
