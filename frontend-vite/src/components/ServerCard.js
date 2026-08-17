/**
 * components/ServerCard.js
 * 渲染单张服务器卡片 HTML 字符串，以及使用安全 DOM API 构建详情模态框。
 * 不依赖任何第三方库，仅使用浏览器原生 API。
 * @deprecated 当前应用未导入此模块；保留以兼容旧版调用方。
 */

import { toDisplay, calcResidualValue } from '../utils/currency.js';
import { fmtGb, getTrafficPct, getTrafficUsed } from '../utils/traffic.js';

// ─── 状态映射 ────────────────────────────────────────────────────────────────

const STATUS_LINE = { online: 'status-online', warn: 'status-warn', offline: 'status-offline' };
const STATUS_DOT  = { online: 'online',         warn: 'warn',        offline: 'offline' };

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[char]);
}

function safeExternalUrl(value) {
  try {
    const url = new URL(String(value), window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function element(tag, options = {}) {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = String(options.text);
  if (options.style) node.setAttribute('style', options.style);
  return node;
}

function appendSpecTable(parent, rows) {
  const table = element('table', { className: 'spec-table' });
  rows.forEach(([label, value, style]) => {
    const row = document.createElement('tr');
    row.append(element('td', { text: label }));
    const valueCell = element('td', { text: value });
    if (style) valueCell.setAttribute('style', style);
    row.append(valueCell);
    table.append(row);
  });
  parent.append(table);
}

function modalSection(title) {
  const section = element('div', { className: 'modal-section' });
  section.append(element('div', { className: 'modal-section-title', text: title }));
  return section;
}

function metricBar(label, pct) {
  const v   = parseFloat(pct);
  const cls = v >= 90 ? 'fill-red' : v >= 70 ? 'fill-orange' : 'fill-green';
  const txt = isNaN(v) ? '0.00' : v.toFixed(2);
  return /* html */`
    <div class="metric-row">
      <div class="metric-label">${label}</div>
      <div class="metric-bar"><div class="metric-fill ${cls}" style="width:${Math.min(100, v)}%"></div></div>
      <div class="metric-val">${txt}%</div>
    </div>`;
}

function rvTooltip(server, rv) {
  const periodText = escapeHtml({ monthly: '月付', yearly: '年付', quarterly: '季付' }[server.period] || server.period);
  const daysLeft   = Math.max(0, Math.ceil((new Date(server.expiry) - new Date()) / 86400000));
  return /* html */`
    <div class="rv-tooltip">
      <div class="rv-tooltip-title">💰 剩余价值分析</div>
      <div class="rv-tooltip-row"><span class="key">购入价格</span><span class="val">${toDisplay(server.price)} / ${periodText}</span></div>
      <div class="rv-tooltip-row"><span class="key">到期日期</span><span class="val">${escapeHtml(server.expiry)}</span></div>
      <div class="rv-tooltip-row"><span class="key">剩余天数</span><span class="val">${daysLeft > 0 ? daysLeft + ' 天' : '已到期'}</span></div>
      <div class="rv-tooltip-row"><span class="key">剩余价值</span><span class="val" style="color:var(--green)">${toDisplay(rv.value)}</span></div>
      <div class="rv-tooltip-row"><span class="key">已消耗</span><span class="val" style="color:var(--red)">${toDisplay(server.price - rv.value)}</span></div>
      <div class="rv-tooltip-row"><span class="key">日均成本</span><span class="val">${toDisplay(server.price / (server.period === 'yearly' ? 365 : server.period === 'quarterly' ? 92 : 30))}/天</span></div>
    </div>`;
}

function trafficSection(server) {
  const hasLimit    = server.traffic_limit_gb > 0;
  const usedGb      = getTrafficUsed(server);
  const pct         = getTrafficPct(server) || 0;
  const trafficWarn = hasLimit && pct >= 80;
  const trafficCrit = hasLimit && pct >= 95;
  const color       = trafficCrit ? 'var(--red)' : trafficWarn ? 'var(--orange)' : 'var(--accent)';
  const fillCls     = trafficCrit ? 'fill-red' : trafficWarn ? 'fill-orange' : 'fill-blue';

  if (hasLimit) {
    return /* html */`
      <div style="margin:8px 0 4px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:${color};margin-bottom:3px">
          <span>月流量 ${fmtGb(usedGb)} / ${fmtGb(server.traffic_limit_gb)}</span>
          <span>${pct.toFixed(1)}%</span>
        </div>
        <div class="metric-bar" style="height:5px">
          <div class="metric-fill ${fillCls}" style="width:${pct}%"></div>
        </div>
      </div>`;
  }
  return /* html */`
    <div style="margin:6px 0 2px;font-size:11px;color:var(--text3)">
      本月 ↑${fmtGb(server.traffic_up_gb || 0)} ↓${fmtGb(server.traffic_down_gb || 0)} · 不限流量
    </div>`;
}

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 渲染单张服务器卡片 HTML 字符串。
 * @param {object} server
 * @param {Function} onDetailClick  点击时打开详情的回调 (serverId) => void
 * @returns {string} HTML
 */
export function renderCard(server, onDetailClick) {
  const rv         = calcResidualValue(server);
  const pct        = getTrafficPct(server) || 0;
  const trafficWarn = server.traffic_limit_gb > 0 && pct >= 80;
  const trafficCrit = server.traffic_limit_gb > 0 && pct >= 95;

  // Register click handler via dataset (event delegation friendly)
  const clickAttr = `data-server-id="${escapeHtml(server.id)}"`;

  return /* html */`
    <div class="server-card" ${clickAttr}>
      <div class="card-status-line ${STATUS_LINE[server.status] || 'status-offline'}"></div>

      <div class="card-header">
        <div class="card-name">
          <span class="flag">${escapeHtml(server.flag)}</span>
          <span class="status-dot ${STATUS_DOT[server.status] || 'offline'}"></span>
          ${escapeHtml(server.name)}
        </div>
        <div class="card-badges">
          <span class="badge badge-blue">${escapeHtml(server.group)}</span>
          ${server.status === 'warn' ? '<span class="badge badge-red">⚠ 预警</span>' : ''}
          ${trafficCrit ? '<span class="badge badge-red">🔴 流量危急</span>'
            : trafficWarn ? '<span class="badge" style="background:rgba(255,159,67,.12);color:var(--orange);border:1px solid rgba(255,159,67,.3)">⚡ 流量预警</span>'
            : ''}
        </div>
      </div>

      <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-bottom:8px">
        ${escapeHtml(server.location)} · ${escapeHtml(server.ip)}
      </div>

      <div class="metrics">
        ${metricBar('CPU', server.cpu_use)}
        ${metricBar('MEM', server.ram_use)}
        ${metricBar('DSK', server.disk_use)}
      </div>

      <div class="net-speeds">
        <div class="net-item">↑ <span>${Number(server.net_up).toFixed(1)} MB/s</span></div>
        <div class="net-item">↓ <span>${Number(server.net_down).toFixed(1)} MB/s</span></div>
        <div class="net-item" style="margin-left:auto">SLA <span>${escapeHtml(server.uptime)}</span></div>
      </div>

      ${trafficSection(server)}

      <div class="card-footer">
        <div class="card-spec">${escapeHtml(server.cpu)}C / ${escapeHtml(server.ram)}G / ${escapeHtml(server.disk)}G · ${escapeHtml(server.bw)}</div>
        <div class="rv-tag-wrapper" data-stop-propagation>
          <div class="rv-tag">💰 剩余 ${rv.pct}%</div>
          ${rvTooltip(server, rv)}
        </div>
      </div>

      ${server.note ? `<div style="margin-top:8px;font-size:11px;color:var(--text3);border-left:2px solid var(--border2);padding-left:8px">${escapeHtml(server.note)}</div>` : ''}
    </div>`;
}

/**
 * 渲染服务器详情模态框内容（注入到 #modalContent）。
 * @param {object} server
 */
export function renderDetailModal(server) {
  const rv = calcResidualValue(server);
  const daysLeft = Math.max(0, Math.ceil((new Date(server.expiry) - new Date()) / 86400000));
  const periodMap = { monthly: '月', yearly: '年', quarterly: '季' };

  const modalTitle = document.getElementById('modalTitle');
  const modalContent = document.getElementById('modalContent');
  if (!modalTitle || !modalContent) return;
  modalTitle.textContent = `${server.flag ?? ''} ${server.name ?? ''}`;
  modalContent.replaceChildren();

  const specs = modalSection('基本规格');
  appendSpecTable(specs, [
    ['位置', server.location], ['IP地址', server.ip], ['CPU', `${server.cpu ?? ''} 核`],
    ['内存', `${server.ram ?? ''} GB`], ['存储', `${server.disk ?? ''} GB`],
    ['带宽', server.bw], ['运行时间', server.uptime],
  ]);
  modalContent.append(specs);

  const monitor = modalSection('资源监控 (近24小时)');
  const chartWrap = element('div', { style: 'height: 200px; position: relative; width: 100%;' });
  const canvas = document.createElement('canvas');
  canvas.setAttribute('id', `modal-cpu-chart-${String(server.id ?? '')}`);
  chartWrap.append(canvas);
  monitor.append(chartWrap);
  modalContent.append(monitor);

  const pricing = modalSection('价格与到期');
  appendSpecTable(pricing, [
    ['购入价格', `${toDisplay(server.price)} / ${periodMap[server.period] || server.period || ''}`],
    ['到期时间', server.expiry], ['剩余天数', `${daysLeft} 天`],
    ['剩余价值', toDisplay(rv.value), 'color:var(--green)'],
    ['已使用价值', toDisplay(server.price - rv.value), 'color:var(--red)'],
  ]);
  modalContent.append(pricing);

  const probeUrl = server.probe ? safeExternalUrl(server.probe) : null;
  if (probeUrl) {
    const probe = modalSection('探针链接');
    const link = element('a', { text: server.probe, style: 'color:var(--accent);font-size:13px;word-break:break-all' });
    link.setAttribute('href', probeUrl);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
    probe.append(link);
    modalContent.append(probe);
  }

  const reviews = modalSection('用户评价');
  [['技术老司机', '★★★★★', '稳定性非常好，跑了一年没出过问题。延迟正常，性价比高。'],
    ['网络爱好者', '★★★★☆', '速度不错，偶尔抖动，客服响应及时。总体推荐。']].forEach(([author, stars, review]) => {
    const item = element('div', { className: 'review-item' });
    item.append(element('div', { className: 'review-author', text: author }));
    item.append(element('div', { className: 'review-stars', text: stars }));
    item.append(element('div', { className: 'review-text', text: review }));
    reviews.append(item);
  });
  modalContent.append(reviews);

  const actions = element('div', { style: 'display:flex;gap:10px;margin-top:1rem' });
  if (probeUrl) {
    const probeButton = element('a', { className: 'aff-link-btn aff-btn-review', text: '📡 查看探针', style: 'display:block;padding:8px;text-align:center' });
    probeButton.setAttribute('href', probeUrl);
    probeButton.setAttribute('target', '_blank');
    probeButton.setAttribute('rel', 'noopener noreferrer');
    actions.append(probeButton);
  }
  const closeButton = element('button', { className: 'add-btn modal-close-btn', text: '关闭' });
  closeButton.setAttribute('type', 'button');
  actions.append(closeButton);
  modalContent.append(actions);

  document.getElementById('modalContent')?.querySelector('.modal-close-btn')?.addEventListener('click', () => {
    document.getElementById('detailModal')?.classList.remove('open');
  });
  document.getElementById('detailModal').classList.add('open');
}

/**
 * 用事件委托给整个 grid 挂一次监听，避免每张卡片单独绑定。
 * @param {HTMLElement} gridEl   .server-grid 元素
 * @param {Function}    onDetail (serverId:number) => void
 */
export function bindGridEvents(gridEl, onDetail) {
  gridEl.addEventListener('click', e => {
    // 阻止 rv-tag-wrapper 内的点击冒泡
    if (e.target.closest('[data-stop-propagation]')) return;
    const card = e.target.closest('[data-server-id]');
    if (card) onDetail(Number(card.dataset.serverId));
  });
}
