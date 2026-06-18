import { fetchOpsSummary, fetchOpsEvents } from '../../api/ops.js';

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const normalizeTime = (v) => {
  if (!v) return null;
  const s = String(v);
  // Backend stores UTC timestamps without timezone; force UTC so range filters don't appear empty in +08 browsers.
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
};
const fmtTime = (v) => v ? new Date(normalizeTime(v)).toLocaleString('zh-CN', { hour12:false }) : '—';
const toMs = (v) => v ? new Date(normalizeTime(v)).getTime() : 0;

export class OpsPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._events = [];
    this._lastLoadedAt = null;
    this._render();
    this._bind();
  }

  _render() {
    this._el.innerHTML = `
      <div class="ops-page-head">
        <div>
          <div class="admin-section-title ops-title">诊断 / 日志</div>
          <div class="ops-subtitle">按时间倒序查看 Agent 上报、告警命中、通知发送和接入异常。</div>
        </div>
        <div class="ops-refresh-state" id="ops-refresh-state">尚未刷新</div>
      </div>
      <div class="admin-card ops-summary-shell">
        <div class="admin-card-title ops-card-title">最近排查入口</div>
        <div id="ops-summary-grid" class="ops-summary-grid ops-summary-compact"></div>
      </div>
      <div class="admin-card ops-events-shell">
        <div class="ops-section-row">
          <div>
            <div class="admin-card-title ops-card-title">事件流</div>
            <div class="ops-subtitle small">默认按最新事件排序，适合快速排查异常。</div>
          </div>
          <button class="komari-secondary ops-density" id="ops-density">紧凑模式</button>
        </div>
        <div class="ops-filter-bar ops-filter-pro">
          <div class="form-group"><label class="form-label">等级</label><select class="form-input" id="ops-level"><option value="">全部</option><option value="info">info</option><option value="warn">warn</option><option value="warning">warning</option><option value="error">error</option></select></div>
          <div class="form-group"><label class="form-label">事件类型</label><select class="form-input" id="ops-type"><option value="">全部</option><option value="agent_register_failed">接入失败</option><option value="agent_push_ok">上报成功</option><option value="agent_push_failed">上报失败</option><option value="alert_rule_fired">规则命中</option><option value="telegram_send_failed">TG 发送失败</option><option value="telegram_send_ok">TG 发送成功</option><option value="login_success">登录成功</option><option value="login_failed">登录失败</option></select></div>
          <div class="form-group"><label class="form-label">节点 ID</label><input class="form-input" id="ops-server-id" placeholder="留空=全部"></div>
          <div class="form-group"><label class="form-label">时间范围</label><select class="form-input" id="ops-range"><option value="15m">最近15分钟</option><option value="1h" selected>最近1小时</option><option value="24h">最近24小时</option><option value="all">全部</option></select></div>
          <div class="form-group ops-keyword"><label class="form-label">关键词</label><input class="form-input" id="ops-keyword" placeholder="事件 / 节点 / 消息"></div>
          <button class="add-btn" id="ops-refresh">刷新</button>
        </div>
        <div class="ops-table" id="ops-events-list"></div>
      </div>`;
  }

  _bind() {
    this._el.querySelector('#ops-refresh')?.addEventListener('click', () => this.load());
    ['#ops-level','#ops-range','#ops-keyword'].forEach(sel => this._el.querySelector(sel)?.addEventListener(sel === '#ops-keyword' ? 'input' : 'change', () => this._renderEvents(this._events)));
    this._el.querySelector('#ops-type')?.addEventListener('change', () => this.load());
    this._el.querySelector('#ops-server-id')?.addEventListener('change', () => this.load());
    this._el.querySelector('#ops-density')?.addEventListener('click', () => {
      this._el.classList.toggle('ops-comfy');
      this._el.querySelector('#ops-density').textContent = this._el.classList.contains('ops-comfy') ? '舒适模式' : '紧凑模式';
    });
  }

  async load() {
    const serverId = this._el.querySelector('#ops-server-id')?.value?.trim();
    const type = this._el.querySelector('#ops-type')?.value || '';
    const btn = this._el.querySelector('#ops-refresh');
    if (btn) btn.textContent = '刷新中…';
    try {
      const [summary, eventsPayload] = await Promise.all([
        fetchOpsSummary(),
        fetchOpsEvents({ limit: 100, event_type: type, server_id: serverId || '' })
      ]);
      this._events = eventsPayload.events || [];
      this._lastLoadedAt = new Date();
      this._renderSummary(summary);
      this._renderEvents(this._events);
      const state = this._el.querySelector('#ops-refresh-state');
      if (state) state.textContent = `最后刷新：${this._lastLoadedAt.toLocaleTimeString('zh-CN', { hour12:false })}`;
    } finally {
      if (btn) btn.textContent = '刷新';
    }
  }

  _summaryCard(title, rows = [], kind = '') {
    const count = rows.length;
    const latest = rows[0]?.meta || '—';
    const body = rows.length ? rows.slice(0,3).map(r => `<button class="ops-mini-row" data-type="${esc(r.event_type || '')}" data-server="${esc(r.server_id || '')}"><span>${esc(r.title)}</span><b>${esc(r.meta)}</b></button>`).join('') : '<div class="ops-empty">暂无记录</div>';
    return `<div class="ops-summary-card ${kind}"><div class="ops-summary-top"><strong>${esc(title)}</strong><span>${count}</span></div><div class="ops-summary-latest">最近：${esc(latest)}</div><div class="ops-summary-card-body">${body}</div></div>`;
  }

  _renderSummary(summary) {
    const mount = this._el.querySelector('#ops-summary-grid');
    if (!mount) return;
    const mapRows = (list=[]) => list.slice(0,3).map(item => ({ title: item.title || item.event_type, meta: fmtTime(item.created_at), event_type:item.event_type, server_id:item.server_id }));
    mount.innerHTML = [
      this._summaryCard('接入失败', mapRows(summary.recent_agent_failures), 'danger'),
      this._summaryCard('规则命中', mapRows(summary.recent_rule_hits), 'warn'),
      this._summaryCard('消息发送', mapRows(summary.recent_tg_status), 'info'),
      this._summaryCard('Agent 上报', mapRows(summary.recent_agent_reports), 'success'),
    ].join('');
    mount.querySelectorAll('.ops-mini-row').forEach(btn => btn.addEventListener('click', () => {
      const type = btn.dataset.type || '';
      const server = btn.dataset.server || '';
      if (type) this._el.querySelector('#ops-type').value = type;
      if (server) this._el.querySelector('#ops-server-id').value = server;
      this.load();
    }));
  }

  _filtered(events) {
    const level = this._el.querySelector('#ops-level')?.value || '';
    const range = this._el.querySelector('#ops-range')?.value || '1h';
    const keyword = (this._el.querySelector('#ops-keyword')?.value || '').trim().toLowerCase();
    const now = Date.now();
    const rangeMs = range === '15m' ? 15*60*1000 : range === '1h' ? 60*60*1000 : range === '24h' ? 24*60*60*1000 : 0;
    return events.filter(evt => {
      const evtLevel = String(evt.level || '').toLowerCase();
      if (level && evtLevel !== level) return false;
      if (rangeMs && toMs(evt.created_at) && now - toMs(evt.created_at) > rangeMs) return false;
      if (keyword) {
        const hay = [evt.title, evt.level, evt.event_type, evt.message, evt.server_id, evt.rule_id, evt.created_at].join(' ').toLowerCase();
        if (!hay.includes(keyword)) return false;
      }
      return true;
    });
  }

  _levelClass(level) {
    const lv = String(level || 'info').toLowerCase();
    return lv === 'error' ? 'error' : (lv === 'warn' || lv === 'warning') ? 'warn' : 'info';
  }

  _renderEvents(events = []) {
    const mount = this._el.querySelector('#ops-events-list');
    if (!mount) return;
    const filtered = this._filtered(events);
    if (!filtered.length) { mount.innerHTML = '<div class="ops-empty-table">暂无事件，调整筛选条件后重试。</div>'; return; }
    mount.innerHTML = `
      <div class="ops-table-head"><span>时间</span><span>等级</span><span>事件</span><span>节点</span><span>消息</span></div>
      ${filtered.map(evt => `
        <div class="ops-event-row">
          <time>${esc(fmtTime(evt.created_at))}</time>
          <span class="ops-level ${this._levelClass(evt.level)}">${esc(evt.level || 'info')}</span>
          <code>${esc(evt.event_type || '—')}</code>
          <button class="ops-node-filter" data-server="${esc(evt.server_id || '')}">${esc(evt.server_id || '—')}</button>
          <div class="ops-message"><strong>${esc(evt.title || '—')}</strong><small>${esc(evt.message || '—')} · 规则：${esc(evt.rule_id || '—')}</small></div>
        </div>`).join('')}`;
    mount.querySelectorAll('.ops-node-filter').forEach(btn => btn.addEventListener('click', () => { if (btn.dataset.server) { this._el.querySelector('#ops-server-id').value = btn.dataset.server; this.load(); } }));
  }
}
