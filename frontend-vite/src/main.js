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
import { toDisplay, calcResidualValue, getMonthlyPrice, updateRateDisplay, calcEstimateLocal } from './utils/currency.js';
import { fmtGb, getTrafficPct, getTrafficUsed, daysUntilReset, trafficColor } from './utils/traffic.js';
import { renderCard, renderDetailModal, bindGridEvents } from './components/ServerCard.js';
import { listAffProducts, postEstimate } from './api/public.js';

// ─── 懒加载句柄 ─────────────────────────────────────────────────────────[...]
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

// ─── 页面切换 ──────────────────────────────────────────────────────────[美化适配，整体替换原实现]

window.switchPage = (page) => {
  // 1. 处理页面显示/隐藏
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active');
  });
  const targetPage = document.getElementById(`page-${page}`);
  if (targetPage) targetPage.classList.add('active');

  // 2. 处理导航标签高亮 (适配美化后的 .nav-tab 类)
  document.querySelectorAll('.nav-tab').forEach(t => {
    t.classList.remove('active');
  });

  // 自动根据事件源或 ID 查找并高亮标签
  const activeTab = event?.currentTarget || document.querySelector(`[onclick*="switchPage('${page}')"]`);
  if (activeTab) activeTab.classList.add('active');

  // 3. 触发特定页面的初始化逻辑
  if (page === 'globe') initGlobe();
  if (page === 'calc') initProbeList();
  if (page === 'traffic') renderTrafficPage();

  // 切换页面后自动回到顶部
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

// ─── 货币 ────────────────────────────────────────────────────────────[美化适配，整体替换原实现]
window.setCurrency = (c) => {
  state.currency = c;

  // 更新按钮高亮
  document.querySelectorAll('.currency-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.trim() === c);
  });

  // 重新渲染相关数据
  updateRateDisplay();
  renderStats();
  renderServers(); 
};

// ─── 分组 & 过滤 ─────────────────────────────────────────────────────────[...]

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

// ─── Dashboard 渲染 ──────────────────────────────────────────���─────────────��[...]

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

// ─── renderServers：适配美化后的空状态提示和事件委托优化（整体替换原实现）───

function renderServers() {
  const grid = document.getElementById('serverGrid');
  const servers = getFilteredServers();

  if (servers.length === 0) {
    grid.innerHTML = `
      <div style="grid-column: 1/-1; text-align: center; padding: 50px; color: var(--text-dim);">
        <div style="font-size: 40px; margin-bottom: 10px;">🔍</div>
        <p>未找到匹配的服务器，请尝试其他关键词</p>
      </div>`;
    return;
  }

  // 使用美化后的渲染逻辑
  grid.innerHTML = servers.map(s => renderCard(s)).join('');
  ensureGridDelegate(); // 确保事件委托依然生效
}

// 事件委托
let _gridDelegated = false;
function ensureGridDelegate() {
  if (_gridDelegated) return;
  _gridDelegated = true;
  bindGridEvents(document.getElementById('serverGrid'), id => {
    const s = state.servers.find(x => x.id === id);
    if (s) renderDetailModal(s);
  });
}

// ─── Modal 统一弹窗控制逻辑（整体新增）────

window.showModal = (contentHtml) => {
  const modal = document.getElementById('detailModal');
  const content = document.getElementById('modalContent');
  if (modal && content) {
    content.innerHTML = contentHtml;
    modal.classList.add('open');
  }
};

// 监听 Esc 键关闭弹窗
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.getElementById('detailModal')?.classList.remove('open');
  }
});

window.closeModal = (e) => {
  if (e.target.id === 'detailModal') document.getElementById('detailModal').classList.remove('open');
};


// ─── AFF 渲染 ────────────────────────────────────────────────────────────────

const affView = {
  sortBy: 'default',
  group: '全部',
};

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sanitizeRichText(html) {
  const raw = String(html || '');
  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html');
  const root = doc.body.firstElementChild;
  const allowedTags = new Set(['B', 'STRONG', 'I', 'EM', 'P', 'BR', 'UL', 'OL', 'LI', 'A', 'CODE']);
  const allowedAttrs = new Set(['href', 'target', 'rel']);

  const walk = (node) => {
    [...node.children].forEach((child) => {
      if (!allowedTags.has(child.tagName)) {
        child.replaceWith(...child.childNodes);
        return;
      }
      [...child.attributes].forEach((attr) => {
        if (!allowedAttrs.has(attr.name.toLowerCase())) child.removeAttribute(attr.name);
      });
      if (child.tagName === 'A') {
        const href = (child.getAttribute('href') || '').trim();
        if (!href.startsWith('http://') && !href.startsWith('https://')) {
          child.removeAttribute('href');
        } else {
          child.setAttribute('rel', 'noopener noreferrer nofollow');
          child.setAttribute('target', '_blank');
        }
      }
      walk(child);
    });
  };
  if (root) walk(root);
  return root?.innerHTML || '';
}

function affLinkMeta(card, kind) {
  const key = kind === 'buy' ? 'is_trusted_buy_url' : 'is_trusted_review_url';
  return {
    trusted: card[key] !== false,
    href: card[kind === 'buy' ? 'buy_url' : 'review_url'],
  };
}

function buildAffLink(card, kind, label, className) {
  const meta = affLinkMeta(card, kind);
  if (!meta.href) return '';
  if (meta.trusted) {
    return `<a href="${escapeHtml(meta.href)}" class="aff-link-btn ${className}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }
  return `<a href="${escapeHtml(meta.href)}" class="aff-link-btn ${className}" target="_blank" rel="noopener noreferrer"
            onclick="return affUntrustedWarn(event, '${escapeHtml(meta.href)}')">${label} ⚠️</a>`;
}

window.affUntrustedWarn = (e, href) => {
  const ok = window.confirm(`⚠️ 该链接域名不在白名单：${href}\n可能存在钓鱼或跳转风险，确认继续访问吗？`);
  if (!ok) e.preventDefault();
  return ok;
};

function currentAffCards() {
  const byGroup = affView.group === '全部'
    ? [...state.affCards]
    : state.affCards.filter(c => (c.group_name || '默认分组') === affView.group);
  const sorter = {
    default: (a, b) => (a.sort_order || 100) - (b.sort_order || 100),
    price_asc: (a, b) => (a.price || 0) - (b.price || 0),
    price_desc: (a, b) => (b.price || 0) - (a.price || 0),
    provider: (a, b) => String(a.provider || '').localeCompare(String(b.provider || '')),
  }[affView.sortBy] || ((a, b) => 0);
  return byGroup.sort(sorter);
}

function renderAff() {
  const groups = ['全部', ...new Set(state.affCards.map(a => a.group_name || '默认分组'))];
  const groupEl = document.getElementById('affGroupTabs');
  if (groupEl) {
    groupEl.innerHTML = groups.map(g => (
      `<button class="group-tab ${g === affView.group ? 'active' : ''}" onclick='setAffGroup(${JSON.stringify(g)})'>${escapeHtml(g)}</button>`
    )).join('');
  }
  document.getElementById('affGrid').innerHTML = currentAffCards().map(a => {
    const cls = { avail: 'stock-avail', low: 'stock-low', out: 'stock-out' }[a.stock];
    return /* html */`
      <div class="aff-card">
        <div class="aff-card-header">
          <div>
            <div class="aff-provider">${escapeHtml(a.flag || '🌐')} ${escapeHtml(a.provider)}</div>
            <div style="font-size:11px;color:var(--text3);margin-top:2px">${escapeHtml(a.location || '')}</div>
          </div>
          <div class="aff-stock ${cls}">${escapeHtml(a.stock_label || '')}</div>
        </div>
        <div class="aff-card-body">
          <div class="aff-spec-grid">
            <div class="aff-spec-item"><div class="aff-spec-key">CPU</div><div class="aff-spec-val">${escapeHtml(a.cpu)} </div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">内存</div><div class="aff-spec-val">${escapeHtml(a.ram)} </div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">存储</div><div class="aff-spec-val">${escapeHtml(a.disk)} </div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">流量</div><div class="aff-spec-val">${escapeHtml(a.bandwidth || '')}</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">分组</div><div class="aff-spec-val">${escapeHtml(a.group_name || '默认分组')}</div></div>
            <div class="aff-spec-item"><div class="aff-spec-key">付款周期</div><div class="aff-spec-val">/${escapeHtml(a.period)}</div></div>
          </div>
          <div class="aff-price">
            <div class="aff-price-main">${escapeHtml(a.currency_sym || '')}${escapeHtml(a.price)}</div>
            <div class="aff-price-period">/ ${escapeHtml(a.period)}</div>
          </div>
          <div class="aff-note">${sanitizeRichText(a.note)}</div>
          <div class="aff-links">
            ${a.stock !== 'out'
              ? buildAffLink(a, 'buy', '🛒 一键购买', 'aff-btn-buy')
              : `<div class="aff-link-btn aff-btn-review" style="opacity:.5;cursor:not-allowed">已售罄</div>`}
            ${buildAffLink(a, 'review', '📝 测评报告', 'aff-btn-review')}
          </div>
        </div>
      </div>`;
  }).join('');
}

window.setAffGroup = (group) => {
  affView.group = group;
  renderAff();
};

window.setAffSort = (sortBy) => {
  affView.sortBy = sortBy;
  renderAff();
};

async function loadAffProducts() {
  try {
    const data = await listAffProducts();
    const rows = Array.isArray(data?.products) ? data.products : [];
    if (!rows.length) return;
    state.affCards = rows.map((p, idx) => ({
      id: p.id,
      provider: p.provider || '',
      flag: p.flag || '🌐',
      location: p.location || '',
      cpu: p.cpu || '',
      ram: p.ram || '',
      disk: p.disk || '',
      bandwidth: p.bandwidth || '',
      price: p.price ?? 0,
      period: p.period || 'monthly',
      currency_sym: p.currency === 'USD' ? '$' : p.currency === 'EUR' ? '€' : '¥',
      stock: p.stock || 'avail',
      stock_label: { avail: '有货', low: '剩余少量', out: '已售罄' }[p.stock] || '未知',
      note: p.note || '',
      buy_url: p.buy_url || '',
      review_url: p.review_url || '',
      group_name: p.group_name || '默认分组',
      sort_order: p.sort_order ?? (idx + 1) * 10,
      is_trusted_buy_url: p.is_trusted_buy_url !== false,
      is_trusted_review_url: p.is_trusted_review_url !== false,
      i18n: p.i18n || {},
      lang: p.lang || 'zh',
    }));
  } catch (e) {
    console.warn('[AFF] 拉取接口失败，降级为本地默认卡片：', e);
  }
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

window.calculateFromManual = async () => {
  const name     = document.getElementById('calcName').value || '未命名';
  const price    = parseFloat(document.getElementById('calcBuyPrice').value) || 0;
  const period   = parseInt(document.getElementById('calcPeriod').value)     || 12;
  const buyDate  = document.getElementById('calcBuyDate').value;
  const premium  = parseFloat(document.getElementById('calcPremium').value)  || 20;

  if (!price || !buyDate) {
    document.getElementById('calcResults').innerHTML = '<div style="color:var(--text3);font-size:13px;text-align:center;padding:2rem 0">请填写价格和购买日期</div>';
    return;
  }

  let d = null;
  let fromFallback = false;

  try {
    const res = await postEstimate({
      price,
      period: String(period),
      buy_date: buyDate,
      premium_percent: premium,
    });
    if (res.ok && res.data) {
      d = res.data;
    } else {
      throw new Error(res.error || '估值接口返回异常');
    }
  } catch (err) {
    console.warn('[exchange/estimate] 后端接口不可用，降级到本地计算:', err);
    fromFallback = true;
    d = calcEstimateLocal({ price, period: String(period), buy_date: buyDate, premium_percent: premium });
  }

  const daysLeft  = d.days_left;
  const daysUsed  = d.days_used;
  const pct       = d.residual_percent;
  const dailyRate = d.daily_rate;
  const consumed  = d.consumed_value;
  const residual  = d.residual_value;
  const sellPrice = d.suggested_price;
  const totalDays = d.total_days;

  const fallbackNotice = fromFallback
    ? `<div style="font-size:11px;color:var(--text3);margin-top:8px;padding:4px 8px;background:var(--bg3);border-radius:4px">⚠ 本地计算结果（后端接口不可用）</div>`
    : '';

  document.getElementById('calcResults').innerHTML = /* html */`
    <div class="calc-result">
      <div class="calc-result-row"><span class="key">服务器</span><span class="val">${name}</span></div>
      <div class="calc-result-row"><span class="key">购入价格</span><span class="val">${toDisplay(price)}</span></div>
      <div class="calc-result-row"><span class="key">总周期 / 总天数</span><span class="val">${d.period} / ${totalDays} 天</span></div>
      <div class="calc-result-row"><span class="key">已用天数</span><span class="val">${daysUsed} 天</span></div>
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
    </div>
    ${fallbackNotice}`;
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

// ─── 星空背景响应式性能优化（整体替换原实现）───
function initStarfield() {
  const c = document.getElementById('starfield');
  if (!c) return;
  const ctx = c.getContext('2d');
  
  // 响应式调整画布大小
  const resize = () => {
    c.width = window.innerWidth;
    c.height = window.innerHeight;
  };
  window.onresize = resize;
  resize();

  // 减少星星数量以提升性能 (120)
  const stars = Array.from({ length: 120 }, () => ({
    x: Math.random() * c.width,
    y: Math.random() * c.height,
    r: Math.random() * 1.5,
    a: Math.random(),
    va: Math.random() * 0.02 // 闪烁速度
  }));

  const draw = () => {
    ctx.clearRect(0, 0, c.width, c.height);
    stars.forEach(s => {
      s.a += s.va;
      if (s.a > 1 || s.a < 0) s.va *= -1; // 往复闪烁
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 255, 255, ${Math.abs(s.a) * 0.5})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  };
  draw();
}

// ─── 实时模拟更新 ────────────────────────────────────────────────────────[...]

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

// ─── 启动 ────────────────────────────────────────────────────────────[...]

async function boot() {
  initStarfield();
  await loadAffProducts();
  renderGroupTabs();
  renderStats();
  renderServers();
  ensureGridDelegate();
  renderAff();
  updateRateDisplay();
  startLiveUpdates();
}

boot();
