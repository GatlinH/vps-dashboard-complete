/**
 * components/ServerCard.js
 * 渲染单张服务器卡片 HTML（纯字符串模板），以及服务器详情模态框。
 * 不依赖任何第三方库，仅使用浏览器原生 API。
 */

import { toDisplay, calcResidualValue } from '../utils/currency.js';
import { fmtGb, getTrafficPct, getTrafficUsed } from '../utils/traffic.js';

// ─── 状态映射 ────────────────────────────────────────────────────────────────

const STATUS_LINE = { online: 'status-online', warn: 'status-warn', offline: 'status-offline' };
const STATUS_DOT  = { online: 'online',         warn: 'warn',        offline: 'offline' };

// ─── 内部辅助 ────────────────────────────────────────────────────────────────

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
  const periodText = { monthly: '月付', yearly: '年付', quarterly: '季付' }[server.period] || server.period;
  const daysLeft   = Math.max(0, Math.ceil((new Date(server.expiry) - new Date()) / 86400000));
  return /* html */`
    <div class="rv-tooltip">
      <div class="rv-tooltip-title">💰 剩余价值分析</div>
      <div class="rv-tooltip-row"><span class="key">购入价格</span><span class="val">${toDisplay(server.price)} / ${periodText}</span></div>
      <div class="rv-tooltip-row"><span class="key">到期日期</span><span class="val">${server.expiry}</span></div>
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
  const clickAttr = `data-server-id="${server.id}"`;

  return /* html */`
    <div class="server-card" ${clickAttr}>
      <div class="card-status-line ${STATUS_LINE[server.status] || 'status-offline'}"></div>

      <div class="card-header">
        <div class="card-name">
          <span class="flag">${server.flag}</span>
          <span class="status-dot ${STATUS_DOT[server.status] || 'offline'}"></span>
          ${server.name}
        </div>
        <div class="card-badges">
          <span class="badge badge-blue">${server.group}</span>
          ${server.status === 'warn' ? '<span class="badge badge-red">⚠ 预警</span>' : ''}
          ${trafficCrit ? '<span class="badge badge-red">🔴 流量危急</span>'
            : trafficWarn ? '<span class="badge" style="background:rgba(255,159,67,.12);color:var(--orange);border:1px solid rgba(255,159,67,.3)">⚡ 流量预警</span>'
            : ''}
        </div>
      </div>

      <div style="font-size:11px;color:var(--text3);font-family:var(--mono);margin-bottom:8px">
        ${server.location} · ${server.ip}
      </div>

      <div class="metrics">
        ${metricBar('CPU', server.cpu_use)}
        ${metricBar('MEM', server.ram_use)}
        ${metricBar('DSK', server.disk_use)}
      </div>

      <div class="net-speeds">
        <div class="net-item">↑ <span>${Number(server.net_up).toFixed(1)} MB/s</span></div>
        <div class="net-item">↓ <span>${Number(server.net_down).toFixed(1)} MB/s</span></div>
        <div class="net-item" style="margin-left:auto">SLA <span>${server.uptime}</span></div>
      </div>

      ${trafficSection(server)}

      <div class="card-footer">
        <div class="card-spec">${server.cpu}C / ${server.ram}G / ${server.disk}G · ${server.bw}</div>
        <div class="rv-tag-wrapper" data-stop-propagation>
          <div class="rv-tag">💰 剩余 ${rv.pct}%</div>
          ${rvTooltip(server, rv)}
        </div>
      </div>

      ${server.note ? `<div style="margin-top:8px;font-size:11px;color:var(--text3);border-left:2px solid var(--border2);padding-left:8px">${server.note}</div>` : ''}
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

  document.getElementById('modalTitle').textContent = `${server.flag} ${server.name}`;
  document.getElementById('modalContent').innerHTML = /* html */`
    <div class="modal-section">
      <div class="modal-section-title">基本规格</div>
      <table class="spec-table">
        <tr><td>位置</td><td>${server.location}</td></tr>
        <tr><td>IP地址</td><td>${server.ip}</td></tr>
        <tr><td>CPU</td><td>${server.cpu} 核</td></tr>
        <tr><td>内存</td><td>${server.ram} GB</td></tr>
        <tr><td>存储</td><td>${server.disk} GB</td></tr>
        <tr><td>带宽</td><td>${server.bw}</td></tr>
        <tr><td>运行时间</td><td>${server.uptime}</td></tr>
      </table>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">资源监控 (近24小时)</div>
      <div style="height: 200px; position: relative; width: 100%;">
        <canvas id="modal-cpu-chart-${server.id}"></canvas>
      </div>
    </div>

    <div class="modal-section">
      <div class="modal-section-title">价格与到期</div>
      <table class="spec-table">
        <tr><td>购入价格</td><td>${toDisplay(server.price)} / ${periodMap[server.period] || server.period}</td></tr>
        <tr><td>到期时间</td><td>${server.expiry}</td></tr>
        <tr><td>剩余天数</td><td>${daysLeft} 天</td></tr>
        <tr><td>剩余价值</td><td style="color:var(--green)">${toDisplay(rv.value)}</td></tr>
        <tr><td>已使用价值</td><td style="color:var(--red)">${toDisplay(server.price - rv.value)}</td></tr>
      </table>
    </div>
    
    ${server.probe ? `
    <div class="modal-section">
      <div class="modal-section-title">探针链接</div>
      <a href="${server.probe}" style="color:var(--accent);font-size:13px;word-break:break-all" target="_blank">${server.probe}</a>
    </div>` : ''}
    
    <div class="modal-section">
      <div class="modal-section-title">用户评价</div>
      <div class="review-item">
        <div class="review-author">技术老司机</div>
        <div class="review-stars">★★★★★</div>
        <div class="review-text">稳定性非常好，跑了一年没出过问题。延迟正常，性价比高。</div>
      </div>
      <div class="review-item">
        <div class="review-author">网络爱好者</div>
        <div class="review-stars">★★★★☆</div>
        <div class="review-text">速度不错，偶尔抖动，客服响应及时。总体推荐。</div>
      </div>
    </div>
    
    <div style="display:flex;gap:10px;margin-top:1rem">
      ${server.probe ? `<a href="${server.probe}" target="_blank" class="aff-link-btn aff-btn-review" style="display:block;padding:8px;text-align:center">📡 查看探针</a>` : ''}
      <button class="add-btn modal-close-btn" type="button">关闭</button>
    </div>`;

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
