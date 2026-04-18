/**
 * src/main.js
 * 应用主入口 — 渐进式替换 public.html 内联 JS 逻辑
 *
 * 依赖：
 *   store/state.js       全局状态
 *   utils/currency.js    货币工具
 *   utils/traffic.js     流量工具
 *   components/ServerCard.js
 *   components/StarMap.js    （点击星图 Tab 时懒加载）
 *   components/TrafficChart.js（点击流量 Tab 时懒加载）
 */

import './styles/main.css';

import { state, subscribe, persistServers } from './store/state.js';
import { toDisplay, calcResidualValue, getMonthlyPrice, updateRateDisplay } from './utils/currency.js';
import { fmtGb, getTrafficPct, getTrafficUsed, daysUntilReset, trafficColor } from './utils/traffic.js';
import { renderCard, renderDetailModal, bindGridEvents } from './components/ServerCard.js';

// ─── 懒加载句柄 ───────────────────────────────────────────────────────────────
let _starMap      = null;  // StarMap 实例
let _trafficChart = null;  // TrafficChart 实例

async function getStarMap() {
  if (_starMap) return _starMap;
  const { StarMap } = await import('./components/StarMap.js');
  _starMap = new StarMap('#globe-canvas', state.servers);
  _starMap.onStatusChange = (msg, spin) => setGlobeStatus(msg, spin);
  _starMap.onHover        = updateGlobeTooltip;
  return _starMap;
}

async function getTrafficChart() {
  if (_trafficChart) return _trafficChart;
  const { TrafficChart } = await import('./components/TrafficChart.js');
  _trafficChart = new TrafficChart();
  return _trafficChart;
}

// ─── 页面切换 ────────────────────────────────────────────────────────────────

function switchPage(page, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  btn?.classList.add('active');

  if (page === 'globe')   initGlobe();
  if (page === 'calc')    initProbeList();
  if (page === 'traffic') renderTrafficPage();
}

// 暴露给 HTML onclick 属性
window.switchPage = (page) => {
  const btn = event?.currentTarget;
  switchPage(page, btn);
};

// ─── 货币 ────────────────────────────────────────────────────────────────────

window.setCurrency = (c) => {
  state.currency = c;
  document.querySelectorAll('.currency-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  updateRateDisplay();
  renderStats();
};

// ─── 分组 & 过滤 ─────────────────────────────────────────────────────────────

function getFilteredServers() {
  const q = (document.getElementById('searchBox')?.value || '').toLowerCase();
  return state.servers.filter(s => {
    const matchGroup  = state.activeGroup === '全部' || s.group === state.activeGroup;
    const matchSearch = !q || s.name.toLowerCase().includes(q) || s.location.toLowerCase().includes(q) || s.ip.includes(q);
    return matchGroup && matchSearch;
  });
}

window.filterServers = () => { renderStats(); renderServers(); };

window.setGroup = (g) => {
  state.activeGroup = g;
  renderGroupTabs();
  renderStats();
  renderServers();
};

// ─── Dashboard 渲染 ───────────────────────────────────────────────────────────

function renderGroupTabs() {
  const groups = ['全部', ...new Set(state.servers.map(s => s.group))];
  document.getElementById('groupTabs').innerHTML = groups.map(g =>
    `<button class="group-tab ${g === state.activeGroup ? 'active' : ''}" onclick="setGroup('${g}')">${g}</button>`
  ).join('');
}

function renderStats() {
  const filtered = getFilteredServers();
  const online   = filtered.filter(s => s.status === 'online').length;
  const warn     = filtered.filter(s => s.status === 'warn').length;
  const offline  = filtered.filter(s => s.status === 'offline').length;

  let totalValue = 0, residual = 0, monthly = 0;
  filtered.forEach(s => {
    totalValue += s.price;
    residual   += calcResidualValue(s).value;
    monthly    += getMonthlyPrice(s);
  });

  const expiringSoon = filtered.filter(s => {
    const d = (new Date(s.expiry) - new Date()) / 86400000;
    return d > 0 && d <= 30;
  }).length;

  const avgUptime = (
    filtered.reduce((a, s) => a + parseFloat(s.uptime || 0), 0) / Math.max(filtered.length, 1)
  ).toFixed(2);

  document.getElementById('statsBar').innerHTML = `
    <div class="stat-card blue">
      <div class="stat-label">总服务器</div>
      <div class="stat-val">${filtered.length}</div>
      <div class="stat-sub">在线 ${online} · 预警 ${warn} · 离线 ${offline}</div>
    </div>
    <div class="stat-card green">
      <div class="stat-label">剩余总价值</div>
      <div class="stat-val green">${toDisplay(residual)}</div>
      <div class="stat-sub">总投入 ${toDisplay(totalValue)}</div>
    </div>
    <div class="stat-card gold">
      <div class="stat-label">每月支出</div>
      <div class="stat-val gold">${toDisplay(monthly)}</div>
      <div class="stat-sub">约 ${toDisplay(monthly * 12)}/年</div>
    </div>
    <div class="stat-card red">
      <div class="stat-label">即将到期</div>
      <div class="stat-val red">${expiringSoon} 台</div>
      <div class="stat-sub">30天内到期</div>
    </div>
    <div class="stat-card purple">
      <div class="stat-label">平均在线率</div>
      <div class="stat-val" style="color:var(--purple)">${avgUptime}%</div>
      <div class="stat-sub">SLA 统计</div>
    </div>`;
}

function renderServers() {
  const grid    = document.getElementById('serverGrid');
  const servers = getFilteredServers();
  grid.innerHTML = servers.map(s => renderCard(s)).join('');
}

// 事件委托（只绑一次）
let _gridDelegated = false;
function ensureGridDelegate() {
  if (_gridDelegated) return;
  _gridDelegated = true;
  bindGridEvents(document.getElementById('serverGrid'), id => {
    const s = state.servers.find(x => x.id === id);
    if (s) renderDetailModal(s);
  });
}

window.closeModal = (e) => {
  if (e.target.id === 'detailModal') document.getElementById('detailModal').classList.remove('open');
};

// ─── AFF 渲染 ────────────────────────────────────────────────────────────────

function renderAff() {
  document.getElementById('affGrid').innerHTML = state.affCards.map(a => {
    const cls = { avail: 'stock-avail', low: 'stock-low', out: 'stock-out' }[a.stock];
    return /* html */`
      <div class="aff-card">
        <div class="aff-card-header">
          <div>
            <div class="aff-provider">${a.flag} ${a.provider}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${a.location}</div>
          </div>
          <div class="aff-stock ${cls}">${a.stock_label}</div>
        </div>
        <div class="aff-card-body">
          <div class="aff-spec-grid">
            <div class="aff-spec-item"><div class="aff-spec-key">CPU</div><div class="aff-spec-val">${a.cpu} 核</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">内存</div><div class="aff-spec-val">${a.ram} GB</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">存储</div><div class="aff-spec-val">${a.disk} GB</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">流量</div><div class="aff-spec-val">${a.bw}</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">IP数量</div><div class="aff-spec-val">${a.ip_count} 个</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">付款周期</div><div class="aff-spec-val">/${a.period}</div></div>
          </div>
          <div class="aff-price">
            <div class="aff-price-main">${a.currency_sym}${a.price}</div>
            <div class="aff-price-period">/ ${a.period}</div>
          </div>
          <div class="aff-note">${a.note}</div>
          <div class="aff-links">
            ${a.stock !== 'out'
              ? `<a href="${a.buy_url}" class="aff-link-btn aff-btn-buy" target="_blank">🛒 一键购买</a>`
              : `<div class="aff-link-btn aff-btn-review" style="opacity:.5;cursor:not-allowed">已售罄</div>`}
            <a href="${a.review_url}" class="aff-link-btn aff-btn-review" target="_blank">📝 测评报告</a>
          </div>
        </div>
      </div>`;
  }).join('');
}

// ─── 星图（Globe）───────────────────────────────────────────────────────────

async function initGlobe() {
  const map = await getStarMap();
  map.setServers(state.servers);
  map.start();
  renderGlobeInfoPanel();
}

function setGlobeStatus(msg, spinning) {
  const el = document.getElementById('globeStatusText');
  const sp = document.getElementById('globeSpinner');
  if (el) el.textContent = msg;
  if (sp) sp.style.display = spinning ? 'inline-block' : 'none';
}

function updateGlobeTooltip(loc) {
  const tip = document.getElementById('globeTooltip');
  if (!tip) return;
  if (!loc) { tip.style.display = 'none'; return; }
  const col = { online: '#38ef7d', warn: '#ff9f43', offline: '#ff6b6b' }[loc.status] || '#aaa';
  tip.style.display = 'block';
  tip.innerHTML = /* html */`
    <div style="font-weight:700;color:var(--text);margin-bottom:3px;font-size:13px">${loc.flag} ${loc.name}</div>
    <div style="font-size:12px;color:var(--accent);margin-bottom:5px">${loc.location}</div>
    <div style="color:${col};font-size:11px;margin-bottom:5px">● ${{ online: '在线', warn: '预警', offline: '离线' }[loc.status]}</div>
    <div style="font-size:11px;color:var(--text2);line-height:1.8">
      IP: ${loc.ip}<br>
      CPU: ${Number(loc.cpu_use).toFixed(1)}% &nbsp; MEM: ${Number(loc.ram_use).toFixed(1)}%
    </div>`;
}

function renderGlobeInfoPanel() {
  document.getElementById('globeInfoPanel').innerHTML = state.servers.map(s => `
    <div class="stat-card ${s.status === 'online' ? 'green' : s.status === 'warn' ? 'gold' : 'red'}"
         style="cursor:pointer" data-server-id="${s.id}">
      <div class="stat-label">${s.flag} ${s.name}</div>
      <div class="stat-val" style="font-size:13px;color:var(--text)">${s.location}</div>
      <div class="stat-sub" style="font-family:var(--mono)">CPU ${Number(s.cpu_use).toFixed(1)}% · MEM ${Number(s.ram_use).toFixed(1)}%</div>
      <div class="stat-sub" style="font-family:var(--mono);margin-top:2px">↑${Number(s.net_up).toFixed(1)} ↓${Number(s.net_down).toFixed(1)} MB/s</div>
    </div>`).join('');

  document.getElementById('globeInfoPanel').addEventListener('click', e => {
    const card = e.target.closest('[data-server-id]');
    if (!card) return;
    const s = state.servers.find(x => x.id === Number(card.dataset.serverId));
    if (s) renderDetailModal(s);
  }, { once: false });
}

// Globe 控制开关（HTML onchange 调用）
window.globeSetLines     = v => _starMap && (_starMap.opts.showLines    = v);
window.globeSetSpin      = v => _starMap && (_starMap.opts.autoSpin     = v);
window.globeSetCountries = v => _starMap && (_starMap.opts.showCountries = v);
window.globeSetTile      = v => _starMap && (_starMap.opts.tileMode     = v);
window.adjustZoom        = delta => _starMap?.adjustZoom(delta);
window.manualGlobeFetch  = () => fetchProbeData();

let _fetchTimer = null;
async function fetchProbeData() {
  setGlobeStatus('正在抓取探针数据...', true);
  await new Promise(r => setTimeout(r, 400 + Math.random() * 300));
  state.servers.forEach(s => {
    if (s.status !== 'offline') {
      s.cpu_use  = Math.max(1, Math.min(99, s.cpu_use  + (Math.random() - .5) * 8));
      s.ram_use  = Math.max(1, Math.min(99, s.ram_use  + (Math.random() - .5) * 4));
      s.net_up   = Math.max(0, +(s.net_up   + (Math.random() - .5) * 5).toFixed(2));
      s.net_down = Math.max(0, +(s.net_down + (Math.random() - .5) * 15).toFixed(2));
    }
  });
  setGlobeStatus(`抓取完成 ${new Date().toLocaleTimeString()}`, false);
  renderGlobeInfoPanel();
}

window.onFetchToggleChange = (enabled) => {
  if (enabled) {
    fetchProbeData();
    _fetchTimer = setInterval(fetchProbeData, 20000);
  } else {
    clearInterval(_fetchTimer);
  }
};

// ─── 计算器 ──────────────────────────────────────────────────────────────────

window.switchCalcTab = (tab) => {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('calcTabProbe').style.display  = tab === 'probe'  ? 'block' : 'none';
  document.getElementById('calcTabManual').style.display = tab === 'manual' ? 'block' : 'none';
};

function initProbeList() {
  setTimeout(() => {
    document.getElementById('scanStatus').style.display = 'none';
    document.getElementById('probeList').innerHTML = state.servers.map(s => /* html */`
      <div class="probe-item">
        <span class="flag" style="font-size:16px">${s.flag}</span>
        <div style="flex:1">
          <div class="probe-item-name">${s.name}</div>
          <div class="probe-item-ip">${s.ip} · CPU ${s.cpu_use.toFixed(1)}% · MEM ${s.ram_use.toFixed(1)}%</div>
        </div>
        <button class="probe-fill-btn" onclick="fillFromProbe(${s.id})">填入</button>
      </div>`).join('');
  }, 1200);
}

window.fillFromProbe = (id) => {
  const s = state.servers.find(x => x.id === id);
  if (!s) return;
  // 切到手动 tab
  document.querySelectorAll('.tab-btn').forEach((b, i) => { b.classList.toggle('active', i === 1); });
  document.getElementById('calcTabProbe').style.display  = 'none';
  document.getElementById('calcTabManual').style.display = 'block';
  document.getElementById('calcName').value      = s.name;
  document.getElementById('calcLocation').value  = s.location;
  document.getElementById('calcCpu').value       = s.cpu;
  document.getElementById('calcRam').value       = s.ram;
  document.getElementById('calcDisk').value      = s.disk;
  document.getElementById('calcBuyPrice').value  = s.price;
  document.getElementById('calcPeriod').value    = s.period === 'yearly' ? '12' : s.period === 'quarterly' ? '3' : '1';
  document.getElementById('calcPremium').value   = 20;
  const startDate = new Date(new Date(s.expiry) - (s.period === 'yearly' ? 365 : s.period === 'quarterly' ? 92 : 30) * 86400000);
  document.getElementById('calcBuyDate').value   = startDate.toISOString().split('T')[0];
  calculateFromManual();
};

window.calculateFromManual = () => {
  const name     = document.getElementById('calcName').value || '未命名';
  const price    = parseFloat(document.getElementById('calcBuyPrice').value) || 0;
  const period   = parseInt(document.getElementById('calcPeriod').value)     || 12;
  const buyDate  = document.getElementById('calcBuyDate').value;
  const premium  = parseFloat(document.getElementById('calcPremium').value)  || 20;

  if (!price || !buyDate) {
    document.getElementById('calcResults').innerHTML = '<div style="color:var(--text3);font-size:13px;text-align:center;padding:2rem 0">请填写价格和购买日期</div>';
    return;
  }

  const now        = new Date();
  const start      = new Date(buyDate);
  const end        = new Date(start); end.setMonth(end.getMonth() + period);
  const totalDays  = Math.ceil((end - start) / 86400000);
  const daysLeft   = Math.max(0, Math.ceil((end - now) / 86400000));
  const dailyRate  = price / totalDays;
  const residual   = dailyRate * daysLeft;
  const consumed   = price - residual;
  const sellPrice  = residual * (1 + premium / 100);
  const pct        = Math.round(daysLeft / totalDays * 100);

  document.getElementById('calcResults').innerHTML = /* html */`
    <div class="calc-result">
      <div class="calc-result-row"><span class="key">服务器</span><span class="val">${name}</span></div>
      <div class="calc-result-row"><span class="key">购入价格</span><span class="val">${toDisplay(price)}</span></div>
      <div class="calc-result-row"><span class="key">使用周期</span><span class="val">${period} 个月</span></div>
      <div class="calc-result-row"><span class="key">已用天数</span><span class="val">${totalDays - daysLeft} 天</span></div>
      <div class="calc-result-row"><span class="key">剩余天数</span><span class="val">${daysLeft} 天 (${pct}%)</span></div>
      <div class="calc-result-row"><span class="key">日均成本</span><span class="val">${toDisplay(dailyRate)}/天</span></div>
      <div class="calc-result-row red"><span class="key">已消耗价值</span><span class="val">${toDisplay(consumed)}</span></div>
      <div class="calc-result-row green"><span class="key">剩余原价值</span><span class="val">${toDisplay(residual)}</span></div>
      <div class="calc-result-row highlight"><span class="key">建议售价 (+${premium}%)</span><span class="val">${toDisplay(sellPrice)}</span></div>
    </div>
    <div style="margin-top:12px">
      <div style="font-size:11px;color:var(--text3);margin-bottom:6px">价值消耗进度</div>
      <div style="background:var(--bg3);border-radius:4px;height:8px;overflow:hidden">
        <div style="width:${100-pct}%;height:100%;background:var(--red);border-radius:4px;transition:width .6s"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text3);margin-top:4px">
        <span>已消耗 ${100-pct}%</span><span>剩余 ${pct}%</span>
      </div>
    </div>`;
};

// ─── 流量统计页 ──────────────────────────────────────────────────────────────

function getTrafficServers() {
  return state.trafficActiveGroup === '全部'
    ? state.servers
    : state.servers.filter(s => s.group === state.trafficActiveGroup);
}

function renderTrafficGroupTabs() {
  const groups = ['全部', ...new Set(state.servers.map(s => s.group))];
  document.getElementById('trafficGroupTabs').innerHTML = groups.map(g =>
    `<button class="group-tab ${g === state.trafficActiveGroup ? 'active' : ''}"
       onclick="state.trafficActiveGroup='${g}';renderTrafficPage()">${g}</button>`
  ).join('');
  // 暴露 state 给内联 onclick
  window.state = state;
  window.renderTrafficPage = renderTrafficPage;
}

function renderTrafficStats() {
  const list      = getTrafficServers();
  const threshold = parseInt(document.getElementById('trafficAlertThreshold')?.value || 80);
  const withLimit = list.filter(s => s.traffic_limit_gb > 0);
  const critCount = withLimit.filter(s => (getTrafficPct(s) || 0) >= 95).length;
  const warnCount = withLimit.filter(s => { const p = getTrafficPct(s) || 0; return p >= threshold && p < 95; }).length;
  const totalUp   = list.reduce((a, s) => a + (s.traffic_up_gb   || 0), 0);
  const totalDown = list.reduce((a, s) => a + (s.traffic_down_gb || 0), 0);
  const totalUsed = list.reduce((a, s) => a + getTrafficUsed(s), 0);

  document.getElementById('trafficStatsBar').innerHTML = `
    <div class="stat-card blue"><div class="stat-label">总出站流量</div>
      <div class="stat-val" style="font-size:18px;color:var(--accent)">${fmtGb(totalUp)}</div>
      <div class="stat-sub">${list.length} 台服务器</div></div>
    <div class="stat-card blue"><div class="stat-label">总入站流量</div>
      <div class="stat-val" style="font-size:18px;color:var(--accent)">${fmtGb(totalDown)}</div>
      <div class="stat-sub">出入合计 ${fmtGb(totalUsed)}</div></div>
    <div class="stat-card ${critCount > 0 ? 'red' : warnCount > 0 ? 'gold' : 'green'}">
      <div class="stat-label">流量预警</div>
      <div class="stat-val ${critCount > 0 ? 'red' : warnCount > 0 ? 'gold' : 'green'}">${critCount + warnCount} 台</div>
      <div class="stat-sub">危急 ${critCount} · 预警 ${warnCount}</div></div>
    <div class="stat-card purple"><div class="stat-label">有流量限制</div>
      <div class="stat-val" style="color:var(--purple)">${withLimit.length} 台</div>
      <div class="stat-sub">无限制 ${list.length - withLimit.length} 台</div></div>`;
}

function renderTrafficAlertBanner() {
  const threshold = parseInt(document.getElementById('trafficAlertThreshold')?.value || 80);
  const list      = getTrafficServers();
  const crits     = list.filter(s => (getTrafficPct(s) || 0) >= 95);
  const warns     = list.filter(s => { const p = getTrafficPct(s) || 0; return p >= threshold && p < 95; });
  const el        = document.getElementById('trafficAlertBanner');
  if (!crits.length && !warns.length) { el.innerHTML = ''; return; }

  const items = [
    ...crits.map(s => `<li>${s.flag} <b>${s.name}</b> — 已用 ${getTrafficPct(s).toFixed(1)}%，剩余 ${fmtGb(s.traffic_limit_gb - getTrafficUsed(s))}（危急）</li>`),
    ...warns.map(s => `<li class="warn">${s.flag} <b>${s.name}</b> — 已用 ${getTrafficPct(s).toFixed(1)}%（预警）</li>`),
  ].join('');

  el.innerHTML = `
    <div class="traffic-alert-banner ${crits.length ? '' : 'warn'}">
      <div class="traffic-alert-icon">${crits.length ? '🔴' : '⚡'}</div>
      <div>
        <div style="font-weight:700;color:${crits.length ? 'var(--red)' : 'var(--orange)'};margin-bottom:4px">
          ${crits.length ? `${crits.length} 台服务器流量危急（≥95%）` : `${warns.length} 台服务器流量预警（≥${threshold}%）`}
        </div>
        <ul class="traffic-alert-list">${items}</ul>
      </div>
    </div>`;
}

function renderTrafficGrid() {
  const threshold = parseInt(document.getElementById('trafficAlertThreshold')?.value || 80);
  const sorted = [...getTrafficServers()].sort((a, b) => {
    const pa = getTrafficPct(a) || 0, pb = getTrafficPct(b) || 0;
    if (pa >= 95 && pb < 95) return -1; if (pb >= 95 && pa < 95) return 1;
    if (pa >= threshold && pb < threshold) return -1; if (pb >= threshold && pa < threshold) return 1;
    return pb - pa;
  });
  document.getElementById('trafficGrid').innerHTML = sorted.map(s => {
    const pct    = getTrafficPct(s) || 0;
    const used   = getTrafficUsed(s);
    const isCrit = s.traffic_limit_gb > 0 && pct >= 95;
    const isWarn = s.traffic_limit_gb > 0 && pct >= threshold && !isCrit;
    const barCol = isCrit ? '#ff6b6b' : isWarn ? '#ff9f43' : '#63b3ed';
    const rem    = s.traffic_limit_gb > 0 ? Math.max(0, s.traffic_limit_gb - used) : null;
    const resetIn = daysUntilReset(s.traffic_reset_day || 1);

    return /* html */`
      <div class="traffic-card ${isCrit ? 'crit' : isWarn ? 'warn' : ''}" data-server-id="${s.id}" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <div style="font-size:15px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:6px">
              <span>${s.flag}</span> ${s.name}
              ${isCrit ? '<span class="badge badge-red" style="font-size:10px">危急</span>'
                : isWarn ? '<span class="badge" style="background:rgba(255,159,67,.12);color:var(--orange);border:1px solid rgba(255,159,67,.3);font-size:10px">预警</span>' : ''}
            </div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px;font-family:var(--mono)">${s.location} · ${s.ip}</div>
          </div>
          <div style="text-align:right">
            <div class="traffic-reset-badge">重置 ${resetIn}天后</div>
            <div style="font-size:10px;color:var(--text3);margin-top:4px">每月 ${s.traffic_reset_day || 1} 日</div>
          </div>
        </div>
        ${s.traffic_limit_gb > 0 ? `
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px">
            <span style="color:${barCol};font-weight:700">${pct.toFixed(1)}% 已用</span>
            <span style="color:var(--text3)">${fmtGb(used)} / ${fmtGb(s.traffic_limit_gb)}</span>
          </div>
          <div class="traffic-bar-wrap"><div class="traffic-bar-fill" style="width:${pct}%;background:${barCol}"></div></div>
          <div style="font-size:11px;color:var(--text3);margin-top:4px;text-align:right">
            剩余 <span style="color:${isCrit ? 'var(--red)' : isWarn ? 'var(--orange)' : 'var(--green)'};font-weight:700">${fmtGb(rem)}</span>
          </div>` : `
          <div style="display:flex;align-items:center;gap:6px;margin:8px 0">
            <div class="traffic-bar-wrap" style="flex:1"><div class="traffic-bar-fill" style="width:100%;background:rgba(99,179,237,.3)"></div></div>
            <span style="font-size:11px;color:var(--text3);white-space:nowrap">不限流量</span>
          </div>`}
        <div class="traffic-numbers">
          <div class="traffic-num-item"><div class="traffic-num-label">↑ 出站</div><div class="traffic-num-val" style="color:var(--accent)">${fmtGb(s.traffic_up_gb || 0)}</div></div>
          <div class="traffic-num-item"><div class="traffic-num-label">↓ 入站</div><div class="traffic-num-val" style="color:var(--purple)">${fmtGb(s.traffic_down_gb || 0)}</div></div>
          <div class="traffic-num-item"><div class="traffic-num-label">实时速率</div><div class="traffic-num-val" style="color:var(--green);font-size:12px">↑${Number(s.net_up).toFixed(1)}<br>↓${Number(s.net_down).toFixed(1)} MB/s</div></div>
        </div>
      </div>`;
  }).join('');

  // 委托点击 → 详情
  document.getElementById('trafficGrid').addEventListener('click', e => {
    const card = e.target.closest('[data-server-id]');
    if (card) {
      const s = state.servers.find(x => x.id === Number(card.dataset.serverId));
      if (s) renderDetailModal(s);
    }
  }, { once: false });
}

function renderTrafficTable() {
  const threshold = parseInt(document.getElementById('trafficAlertThreshold')?.value || 80);
  const rows = getTrafficServers().map(s => {
    const pct   = getTrafficPct(s);
    const used  = getTrafficUsed(s);
    const color = pct === null ? 'var(--text3)' : pct >= 95 ? 'var(--red)' : pct >= threshold ? 'var(--orange)' : 'var(--green)';
    const pctStr = pct === null ? '不限' : `${pct.toFixed(1)}%`;
    const rem    = s.traffic_limit_gb > 0 ? fmtGb(Math.max(0, s.traffic_limit_gb - used)) : '∞';
    return `<tr class="traffic-table-row">
      <td><span style="font-size:16px">${s.flag}</span></td>
      <td style="color:var(--text);font-weight:600">${s.name}</td>
      <td style="color:var(--text3);font-size:12px">${s.location}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--accent)">${fmtGb(s.traffic_up_gb || 0)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--purple)">${fmtGb(s.traffic_down_gb || 0)}</td>
      <td style="font-family:var(--mono);font-size:12px">${fmtGb(used)}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--text3)">${s.traffic_limit_gb > 0 ? fmtGb(s.traffic_limit_gb) : '不限'}</td>
      <td style="font-family:var(--mono);font-size:13px;font-weight:700;color:${color}">${pctStr}</td>
      <td style="font-family:var(--mono);font-size:12px;color:var(--green)">${rem}</td>
      <td><span class="traffic-reset-badge">${daysUntilReset(s.traffic_reset_day || 1)}天后</span></td>
    </tr>`;
  }).join('');

  document.getElementById('trafficTable').innerHTML = `
    <thead><tr style="border-bottom:2px solid var(--border)">
      ${['', '服务器', '位置', '↑ 出站', '↓ 入站', '已用', '限额', '使用率', '剩余', '重置'].map(h =>
        `<th style="padding:8px 10px;text-align:left;font-size:11px;color:var(--text3);letter-spacing:.5px;font-weight:400;white-space:nowrap">${h}</th>`
      ).join('')}
    </tr></thead>
    <tbody>${rows}</tbody>`;
}

async function renderTrafficPage() {
  renderTrafficGroupTabs();
  renderTrafficStats();
  renderTrafficAlertBanner();
  renderTrafficGrid();
  renderTrafficTable();

  const tc = await getTrafficChart();
  const servers = getTrafficServers();
  await tc.renderBar('trafficBarChart', servers);

  // 填充趋势选择器
  const sel = document.getElementById('trafficTrendServer');
  if (sel) {
    sel.innerHTML = state.servers.map(s => `<option value="${s.id}">${s.flag} ${s.name}</option>`).join('');
    const firstId = state.servers[0]?.id;
    if (firstId) await tc.renderTrend('trafficTrendChart', state.servers.find(x => x.id === firstId));
    sel.onchange = async () => {
      const s = state.servers.find(x => x.id === parseInt(sel.value));
      if (s) await tc.renderTrend('trafficTrendChart', s);
    };
  }
}

window.renderTrafficTrend = async () => {
  const sel = document.getElementById('trafficTrendServer');
  const s   = state.servers.find(x => x.id === parseInt(sel?.value));
  if (s) (await getTrafficChart()).renderTrend('trafficTrendChart', s);
};

// 流量配置弹窗
window.openTrafficSettings  = () => {
  const body = document.getElementById('trafficSettingsBody');
  body.innerHTML = `
    <div style="font-size:12px;color:var(--text3);margin-bottom:14px">为每台服务器设置月流量限额和重置日，0 表示不限。</div>
    ${state.servers.map(s => `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--border)">
      <span style="font-size:18px;flex-shrink:0">${s.flag}</span>
      <div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;color:var(--text)">${s.name}</div>
        <div style="font-size:11px;color:var(--text3)">${s.location}</div></div>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
        <label style="font-size:11px;color:var(--text3)">限额(GB)</label>
        <input id="tl-limit-${s.id}" type="number" class="form-input" value="${s.traffic_limit_gb || 0}" style="width:80px;padding:5px 8px;font-size:12px" min="0">
        <label style="font-size:11px;color:var(--text3)">重置日</label>
        <input id="tl-day-${s.id}" type="number" class="form-input" value="${s.traffic_reset_day || 1}" style="width:56px;padding:5px 8px;font-size:12px" min="1" max="28">
      </div>
    </div>`).join('')}
    <div style="display:flex;gap:10px;margin-top:1.25rem">
      <button class="add-btn" onclick="saveTrafficSettings()">保存配置</button>
      <button onclick="document.getElementById('trafficSettingsModal').classList.remove('open')"
        style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text2);cursor:pointer;font-size:13px">取消</button>
    </div>
    <div id="trafficSettingsMsg" style="margin-top:8px;font-size:12px;min-height:18px"></div>`;
  document.getElementById('trafficSettingsModal').classList.add('open');
};

window.saveTrafficSettings = () => {
  state.servers.forEach(s => {
    const lim = document.getElementById(`tl-limit-${s.id}`);
    const day = document.getElementById(`tl-day-${s.id}`);
    if (lim) s.traffic_limit_gb  = parseFloat(lim.value) || 0;
    if (day) s.traffic_reset_day = parseInt(day.value)   || 1;
  });
  persistServers();
  const msg = document.getElementById('trafficSettingsMsg');
  if (msg) { msg.style.color = 'var(--green)'; msg.textContent = '✅ 已保存'; }
  setTimeout(() => { document.getElementById('trafficSettingsModal').classList.remove('open'); renderTrafficPage(); }, 800);
};

// ─── 星空背景 ────────────────────────────────────────────────────────────────

function initStarfield() {
  const c = document.getElementById('starfield');
  c.width = window.innerWidth; c.height = window.innerHeight;
  const ctx   = c.getContext('2d');
  const stars = Array.from({ length: 200 }, () => ({
    x: Math.random() * c.width, y: Math.random() * c.height,
    r: Math.random() * 1.2 + .2, a: Math.random(),
  }));
  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    stars.forEach(s => {
      s.a = Math.max(.1, Math.min(.8, s.a + .003 * (Math.random() - .5)));
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${s.a})`; ctx.fill();
    });
    requestAnimationFrame(draw);
  };
  draw();
}

// ─── 实时模拟更新 ─────────────────────────────────────────────────────────────

function startLiveUpdates() {
  setInterval(() => {
    state.servers.forEach(s => {
      if (s.status === 'offline') return;
      s.cpu_use  = Math.max(.01, Math.min(99.99, +(s.cpu_use  + (Math.random() - .5) * 5).toFixed(2)));
      s.ram_use  = Math.max(.01, Math.min(99.99, +(s.ram_use  + (Math.random() - .5) * 2).toFixed(2)));
      s.net_up   = Math.max(0,   +(s.net_up   + (Math.random() - .5) * 3).toFixed(2));
      s.net_down = Math.max(0,   +(s.net_down + (Math.random() - .5) * 10).toFixed(2));
      // 累积流量
      s.traffic_up_gb   = +((s.traffic_up_gb   || 0) + s.net_up   * 3 / 1024).toFixed(4);
      s.traffic_down_gb = +((s.traffic_down_gb || 0) + s.net_down * 3 / 1024).toFixed(4);
      if (s.traffic_limit_gb > 0) s.traffic_used_gb = s.traffic_up_gb + s.traffic_down_gb;
    });
    renderServers();
    renderStats();
    // 若流量页可见则同步
    if (document.getElementById('page-traffic')?.classList.contains('active')) {
      renderTrafficStats();
      renderTrafficAlertBanner();
      renderTrafficGrid();
      renderTrafficTable();
    }
  }, 3000);
}

// ─── 启动 ────────────────────────────────────────────────────────────────────

function boot() {
  initStarfield();
  renderGroupTabs();
  renderStats();
  renderServers();
  ensureGridDelegate();
  renderAff();
  updateRateDisplay();
  startLiveUpdates();
}

boot();
