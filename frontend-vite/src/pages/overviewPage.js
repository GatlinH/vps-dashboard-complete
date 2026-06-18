import { state } from '../store/state.js';
import { LANGUAGE_PACKS, currentLanguage, t } from '../core/preferences.js';
import { toDisplay, calcResidualValue, getMonthlyPrice, sourceAmountToCny, getSourceCurrency, updateRateDisplay } from '../utils/currency.js';
import { getTrafficPct } from '../utils/traffic.js';

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

    const regionKey = s.city || s.region || s.country || t('unknownRegion');
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

function renderOverviewNetworkTable(rows = []) {
  const tableRows = rows.map((server) => {
    const lossText = formatOverviewLoss(server);
    const lossValue = Number.parseFloat(lossText);
    const location = server.city || server.region || server.country || server.location || '—';
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
    <section class="overview-network-table" aria-label="${t('nodeNetworkDetails')}">
      <div class="overview-network-table-head">
        <div>
          <span class="overview-network-table-kicker">${t('networkDetails')}</span>
          <h2>${t('nodeNetworkDetails')}</h2>
        </div>
      </div>
      <div class="overview-network-table-scroll">
        <table>
          <thead><tr><th>${t('tableNodeId')}</th><th>IP</th><th>${t('geoLocation')}</th><th>${t('operator')}</th><th>${t('monthlyTraffic')}</th><th>${t('packetLoss')}</th></tr></thead>
          <tbody>${tableRows || `<tr><td colspan="6">${t('noNetworkData')}</td></tr>`}</tbody>
        </table>
      </div>
    </section>`;
}

export function renderPublicOverviewPage() {
  const app = document.getElementById('pageRoot');
  const rows = Array.isArray(state.servers) ? state.servers : [];
  const summary = summarizeMoonPanel(rows);
  const updatedAtText = state.serversUpdatedAt ? new Date(state.serversUpdatedAt).toLocaleString('zh-CN', { hour12: false }) : '未记录';
  const sourceText = '';
  const cards = rows.map((s) => {
    const cpuValue = overviewMetricValue(s, 'cpu_use');
    const ramValue = overviewMetricValue(s, 'ram_use');
    const diskValue = overviewMetricValue(s, 'disk_use');
    const trafficRaw = getTrafficPct(s);
    const trafficValue = trafficRaw == null || trafficRaw === '' ? null : Math.max(0, Math.min(100, Number(trafficRaw)));
    const residual = calcResidualValue(s);
    const baseValue = Number(residual.value || 0);
    const displayName = s.name || t('unknownNode');
    return `
      <article class="public-overview-card" data-id="${s.id}" role="link" tabindex="0" aria-label="${displayName}">
        <div class="public-overview-head">
          <div><span class="public-overview-flag">${s.flag || '🌐'}</span><strong>${displayName}</strong></div>
          <div class="public-overview-actions"><button class="public-money-btn" type="button" data-id="${s.id}" data-base="${baseValue}" data-name="${escText(displayName)}" aria-label="${escText(displayName)}">¥</button><span class="public-overview-status is-${classifyStatus(s.status)}">${t(classifyStatus(s.status))}</span></div>
        </div>
        <div class="public-overview-meta">${s.provider_guess || s.provider || t('unknownProvider')} · ${s.city || s.region || s.country || t('unknownRegion')} · ${t('residualValue')} ${toDisplay(baseValue)}</div>
        <div class="public-overview-grid">
          ${renderOverviewMetric('CPU', cpuValue)}
          ${renderOverviewMetric('RAM', ramValue)}
          ${renderOverviewMetric('DISK', diskValue)}
          ${renderOverviewMetric('TRAFFIC', Number.isFinite(trafficValue) ? trafficValue : null)}
        </div>
      </article>`;
  }).join('');
  const expSoonItems = summary.expiry.d7.slice(0, 12).map((s) => `<li><b>${s.name}</b><span>${daysUntilExpiry(s.expiry)} 天内到期</span></li>`).join('');
  const badNodeItems = summary.badNodes.slice(0, 12).map(({ server, pct, cls }) => `<li><b>${server.name}</b><span>${cls === 'offline' ? '离线' : `流量 ${pct.toFixed(0)}%`}</span></li>`).join('');
  const byRegion = summary.cost.byRegion.map(([k, v]) => `<li><b>${k}</b><span>¥${Math.round(v)}</span></li>`).join('');
  const byProvider = summary.cost.byProvider.map(([k, v]) => `<li><b>${k}</b><span>¥${Math.round(v)}</span></li>`).join('');
  app.innerHTML = `
    <section class="public-overview-page starship-console-page">
      <div class="public-overview-floating-topbar" aria-label="资产总览导航与显示设置">
        <a class="public-overview-back" href="/">${t('back')}</a>
        <div class="detail-page-tools public-overview-tools">
          <button class="theme-toggle" id="themeToggle" type="button" onclick="toggleTheme()" aria-label="${t('themeAria')}">
            <span id="themeIcon">☾</span><span id="themeLabel">${document.documentElement.getAttribute('data-theme') === 'light' ? t('daylight') : t('bridge')}</span>
          </button>
          <select class="language-select" id="languageSelect" onchange="setLanguage(this.value)" aria-label="${t('langAria')}">
            ${Object.entries(LANGUAGE_PACKS).map(([code, pack]) => `<option value="${code}" ${currentLanguage === code ? 'selected' : ''}>${pack.name}</option>`).join('')}
          </select>
          <div class="currency-switch detail-currency-switch">
            <button class="currency-btn ${state.currency === 'CNY' ? 'active' : ''}" onclick="setCurrency('CNY')">CNY</button>
            <button class="currency-btn ${state.currency === 'USD' ? 'active' : ''}" onclick="setCurrency('USD')">USD</button>
            <button class="currency-btn ${state.currency === 'EUR' ? 'active' : ''}" onclick="setCurrency('EUR')">EUR</button>
          </div>
          <div class="rate-display" id="rateDisplay"></div>
        </div>
      </div>
      <div class="public-overview-hero">
        <div class="public-overview-hero-copy">
          <div class="public-overview-kicker">${t('overviewKicker')}</div>
          <h1>${t('overviewTitle')}</h1>
          <div class="public-overview-meta-bar">
            <span>${t('dataUpdated')}：${updatedAtText}</span>
            
          </div>
        </div>
        <figure class="public-overview-visual" aria-label="资产网络主视觉">
          <img src="/assets/custom/overview-visual-transparent.png" alt="${t('overviewKicker')}" loading="eager" decoding="async" />
        </figure>
      </div>

      <div class="public-overview-stats public-overview-status-bank">
        <div><span>${t('totalNodes')}</span><strong>${summary.status.total}</strong></div>
        <div><span>${t('online')}</span><strong>${summary.status.online}</strong></div>
        <div><span>${t('warn')}</span><strong>${summary.status.warn}</strong></div>
        <div><span>${t('offline')}</span><strong>${summary.status.offline}</strong></div>
      </div>

      <div class="public-overview-stats public-overview-stats-expiry">
        <div><span>${t('expiresToday')}</span><strong>${summary.expiry.today.length}</strong></div>
        <div><span>${t('within3Days')}</span><strong>${summary.expiry.d3.length}</strong></div>
        <div><span>${t('within7Days')}</span><strong>${summary.expiry.d7.length}</strong></div>
      </div>

      <div class="public-overview-stats public-overview-stats-cost">
        <div><span>${t('monthlyTotalCost')}</span><strong>${toDisplay(summary.cost.monthlyActual)}</strong></div>
        <div><span>${t('yearlyTotalCost')}</span><strong>${toDisplay(summary.cost.yearlyActual)}</strong></div>
      </div>

      <div class="public-overview-summary-grid">
        <section class="public-overview-panel public-overview-panel-fold open" data-panel="expiry">
          <button class="public-overview-panel-toggle" type="button" aria-expanded="true">
            <span class="public-overview-panel-title">${t('expiringNodes')}</span>
            <span class="public-overview-panel-chevron">▾</span>
          </button>
          <div class="public-overview-panel-body">
            <ul class="public-overview-mini-list">${expSoonItems || `<li><span>${t('noExpiring')}</span></li>`}</ul>
          </div>
        </section>
        <section class="public-overview-panel public-overview-panel-fold open" data-panel="abnormal">
          <button class="public-overview-panel-toggle" type="button" aria-expanded="true">
            <span class="public-overview-panel-title">${t('abnormalNodes')}</span>
            <span class="public-overview-panel-chevron">▾</span>
          </button>
          <div class="public-overview-panel-body">
            <ul class="public-overview-mini-list">${badNodeItems || `<li><span>${t('noAbnormal')}</span></li>`}</ul>
          </div>
        </section>
        <section class="public-overview-panel"><div class="public-overview-panel-title">${t('monthlyByRegion')}</div><div class="public-overview-panel-body always-open"><ul class="public-overview-mini-list">${byRegion || `<li><span>${t('noData')}</span></li>`}</ul></div></section>
        <section class="public-overview-panel"><div class="public-overview-panel-title">${t('monthlyByProvider')}</div><div class="public-overview-panel-body always-open"><ul class="public-overview-mini-list">${byProvider || `<li><span>${t('noData')}</span></li>`}</ul></div></section>
      </div>

      ${renderOverviewNetworkTable(rows)}

      <div class="public-overview-list">${cards || `<div class="public-overview-empty">${t('noAssets')}</div>`}</div>
    </section>`;

  updateRateDisplay();

  app.querySelectorAll('.public-overview-panel-fold').forEach((panel) => {
    const btn = panel.querySelector('.public-overview-panel-toggle');
    btn?.addEventListener('click', () => {
      const open = panel.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
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
    modal.innerHTML = '';
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
