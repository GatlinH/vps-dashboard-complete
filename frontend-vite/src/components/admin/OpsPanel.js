import { fetchOpsSummary, fetchOpsEvents, fetchUpdateStatus, checkForUpdates, applyUpdates } from '../../api/ops.js';

const esc = (v) => String(v ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const normalizeTime = (v) => {
  if (!v) return null;
  const s = String(v);
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
};
const fmtTime = (v) => v ? new Date(normalizeTime(v)).toLocaleString('zh-CN', { hour12:false }) : '—';
const toMs = (v) => v ? new Date(normalizeTime(v)).getTime() : 0;

const EVENT_META = {
  agent_register_failed: { name:'Agent 接入失败', icon:'🛰️', impact:'节点无法加入监控，通常是密钥、UUID、网络或后端鉴权问题。', action:'检查 install.sh 注册参数、Agent 日志、服务器 UUID/KEY 是否匹配。' },
  agent_register_ok: { name:'Agent 接入成功', icon:'🛰️', impact:'节点已完成注册，可以开始上报指标。', action:'无需处理；可在节点详情确认实时指标。' },
  agent_push_ok: { name:'Agent 指标上报', icon:'📡', impact:'节点在线，监控数据已被后端接受。', action:'正常心跳；若数量过多，可用筛选只看 warn/error。' },
  agent_push_failed: { name:'Agent 上报失败', icon:'📡', impact:'该节点近期数据可能缺失，图表会断点或延迟。', action:'检查 Agent 网络、后端 /metrics 接口、服务器时间和密钥。' },
  alert_rule_fired: { name:'告警规则命中', icon:'🚨', impact:'监控指标触发阈值，可能需要人工处理。', action:'查看规则 ID、节点和 payload 中的指标值，必要时调整阈值或处理故障。' },
  telegram_send_failed: { name:'通知发送失败', icon:'✉️', impact:'告警可能没有送达 Telegram/通知渠道。', action:'检查 Bot Token、Chat ID、网络代理和发送方式配置。' },
  telegram_send_ok: { name:'通知发送成功', icon:'✉️', impact:'告警/测试消息已送达配置渠道。', action:'无需处理。' },
  login_success: { name:'后台登录成功', icon:'🔐', impact:'管理员会话已建立。', action:'若不是本人操作，立即改密码并删除其他会话。' },
  login_failed: { name:'后台登录失败', icon:'🔐', impact:'可能是密码错误，也可能是异常尝试。', action:'关注来源 IP 和频率；必要时改密码或限制访问。' },
  security_http_anomaly: { name:'异常 HTTP 访问', icon:'🛡️', impact:'出现未授权、扫描或异常访问，可能来自公网探测器或恶意请求。', action:'查看来源 IP、状态码和路径；如频率高，建议加访问限制、黑名单或反向代理规则。' },
};

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
          <div class="ops-subtitle">把原始事件翻译成可排障的信息：影响范围、建议动作、关键字段和原始摘要。</div>
        </div>
        <div class="ops-refresh-state" id="ops-refresh-state">尚未刷新</div>
      </div>
      <div class="admin-card ops-update-shell">
        <div class="ops-section-row">
          <div>
            <div class="admin-card-title ops-card-title">版本更新</div>
            <div class="ops-subtitle small">检查 GHCR 镜像更新；应用后由 Watchtower 拉取镜像并滚动重启容器，同时显示宿主机 Agent 版本状态。</div>
          </div>
          <div class="ops-update-actions">
            <button class="komari-secondary" id="ops-update-status" type="button">刷新状态</button>
            <button class="komari-secondary" id="ops-update-check" type="button">检查更新</button>
            <button class="add-btn" id="ops-update-apply" type="button">更新容器镜像</button>
          </div>
        </div>
        <div class="ops-log-help" id="ops-update-hint">当前为 GHCR 镜像部署模式：检查只读取镜像清单；应用更新会调用 Watchtower。</div>
        <pre class="ops-update-output" id="ops-update-output">尚未检查</pre>
      </div>
      <div class="admin-card ops-summary-shell">
        <div class="admin-card-title ops-card-title">最近排查入口</div>
        <div id="ops-summary-grid" class="ops-summary-grid ops-summary-compact"></div>
      </div>
      <div class="admin-card ops-events-shell">
        <div class="ops-section-row">
          <div>
            <div class="admin-card-title ops-card-title">事件流</div>
            <div class="ops-subtitle small">默认保留最近事件；失败/告警会以更醒目的排障卡片展示。</div>
          </div>
          <button class="komari-secondary ops-density" id="ops-density" type="button">当前：紧凑</button>
        </div>
        <div class="ops-filter-bar ops-filter-pro">
          <div class="form-group"><label class="form-label">等级</label><select class="form-input" id="ops-level"><option value="">全部等级</option><option value="info">info 正常</option><option value="warn">warn 警告</option><option value="warning">warning 警告</option><option value="error">error 错误</option></select></div>
          <div class="form-group"><label class="form-label">事件类型</label><select class="form-input" id="ops-type"><option value="">全部事件</option><option value="agent_register_failed">Agent 接入失败</option><option value="agent_register_ok">Agent 接入成功</option><option value="agent_push_ok">Agent 指标上报</option><option value="agent_push_failed">Agent 上报失败</option><option value="alert_rule_fired">告警规则命中</option><option value="telegram_send_failed">通知发送失败</option><option value="telegram_send_ok">通知发送成功</option><option value="login_success">登录成功</option><option value="login_failed">登录失败</option></select></div>
          <div class="form-group"><label class="form-label">节点 ID</label><input class="form-input" id="ops-server-id" placeholder="留空=全部"></div>
          <div class="form-group"><label class="form-label">时间范围</label><select class="form-input" id="ops-range"><option value="15m">最近15分钟</option><option value="1h" selected>最近1小时</option><option value="24h">最近24小时</option><option value="all">全部</option></select></div>
          <div class="form-group ops-keyword"><label class="form-label">关键词</label><input class="form-input" id="ops-keyword" placeholder="IP / UUID / 节点 / 原因"></div>
          <button class="add-btn" id="ops-refresh">刷新</button>
        </div>
        <div class="ops-log-help">提示：大量 <b>Agent 指标上报</b> 是健康心跳；排障时优先筛选 <b>warn/error</b>、接入失败、通知失败、告警命中。</div>
        <div class="ops-table ops-diagnostic-list" id="ops-events-list"></div>
      </div>`;
  }

  _bind() {
    this._el.querySelector('#ops-refresh')?.addEventListener('click', () => this.load());
    this._el.querySelector('#ops-update-status')?.addEventListener('click', () => this._loadUpdateStatus());
    this._el.querySelector('#ops-update-check')?.addEventListener('click', () => this._runUpdateCheck());
    this._el.querySelector('#ops-update-apply')?.addEventListener('click', () => this._runUpdateApply());
    ['#ops-level','#ops-range','#ops-keyword'].forEach(sel => this._el.querySelector(sel)?.addEventListener(sel === '#ops-keyword' ? 'input' : 'change', () => this._renderEvents(this._events)));
    this._el.querySelector('#ops-type')?.addEventListener('change', () => this.load());
    this._el.querySelector('#ops-server-id')?.addEventListener('change', () => this.load());
    this._el.querySelector('#ops-density')?.addEventListener('click', () => {
      const comfy = this._el.classList.toggle('ops-comfy');
      const btn = this._el.querySelector('#ops-density');
      if (btn) {
        btn.textContent = comfy ? '当前：舒适' : '当前：紧凑';
        btn.classList.toggle('is-comfy', comfy);
      }
    });
  }

  async load() {
    const serverId = this._el.querySelector('#ops-server-id')?.value?.trim();
    const type = this._el.querySelector('#ops-type')?.value || '';
    const btn = this._el.querySelector('#ops-refresh');
    if (btn) btn.textContent = '刷新中…';
    try {
      const [summary, eventsPayload, updateStatus] = await Promise.all([
        fetchOpsSummary(),
        fetchOpsEvents({ limit: 120, event_type: type, server_id: serverId || '' }),
        fetchUpdateStatus().catch(err => ({ msg: err?.message || '更新状态读取失败' }))
      ]);
      this._events = eventsPayload.events || [];
      this._lastLoadedAt = new Date();
      this._setUpdateOutput('更新状态', updateStatus);
      this._renderSummary(summary);
      this._renderEvents(this._events);
      const state = this._el.querySelector('#ops-refresh-state');
      if (state) state.textContent = `最后刷新：${this._lastLoadedAt.toLocaleTimeString('zh-CN', { hour12:false })}`;
    } finally {
      if (btn) btn.textContent = '刷新';
    }
  }

  _setUpdateOutput(title, payload = {}) {
    const out = this._el.querySelector('#ops-update-output');
    const hint = this._el.querySelector('#ops-update-hint');
    const lines = [title];
    if (payload.msg) lines.push(payload.msg);
    if (payload.services?.length) lines.push(`服务：${payload.services.join(', ')}`);
    if (payload.compose_files?.length) lines.push(`Compose：${payload.compose_files.join(' + ')}`);
    if (payload.images?.length) {
      lines.push('', 'GHCR 镜像：');
      payload.images.forEach(img => lines.push(`- ${img.name || img.image}: ${img.digest ? String(img.digest).slice(0, 24) + '…' : '未获取 digest'}`));
    }
    if (payload.agent) {
      const a = payload.agent;
      const state = a.update_available === true ? '需同步' : (a.installed ? '已同步' : '未上报');
      lines.push('', `宿主机 Agent：${state}`);
      lines.push(`- 当前：${a.current_version || '—'}`);
      lines.push(`- 期望：${a.expected_version || '—'}`);
      if (a.apply_hint) lines.push(`- 更新方式：${a.apply_hint}`);
      if (a.error) lines.push(`- 错误：${a.error}`);
    }
    if (payload.output) lines.push('', String(payload.output).slice(-2000));
    if (out) out.textContent = lines.filter(Boolean).join('\n');
    if (hint && payload.mode === 'ghcr') hint.textContent = 'GHCR 镜像模式：检查只读取 manifest；应用更新调用 Watchtower。';
  }

  async _withUpdateButton(selector, label, task) {
    const btn = this._el.querySelector(selector);
    const old = btn?.textContent;
    if (btn) { btn.disabled = true; btn.textContent = `${label}中…`; }
    try {
      const payload = await task();
      this._setUpdateOutput(`${label}完成`, payload);
      return payload;
    } catch (err) {
      this._setUpdateOutput(`${label}失败`, { msg: err?.message || String(err) });
      throw err;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || label; }
    }
  }

  async _loadUpdateStatus() {
    return this._withUpdateButton('#ops-update-status', '刷新状态', fetchUpdateStatus);
  }

  async _runUpdateCheck() {
    return this._withUpdateButton('#ops-update-check', '检查更新', checkForUpdates);
  }

  async _runUpdateApply() {
    const ok = window.confirm('更新容器镜像会触发 Watchtower 拉取 GHCR 最新镜像并滚动重启前端、后端和 Agent 消费容器。确定现在更新吗？');
    if (!ok) return;
    return this._withUpdateButton('#ops-update-apply', '更新容器镜像', applyUpdates);
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
    const mapRows = (list=[]) => list.slice(0,3).map(item => ({ title: readableTitle(item), meta: fmtTime(item.created_at), event_type:item.event_type, server_id:item.server_id }));
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
        const hay = [evt.title, evt.level, evt.event_type, readableTitle(evt), evt.message, evt.server_id, evt.rule_id, evt.created_at, JSON.stringify(evt.payload || {})].join(' ').toLowerCase();
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
    if (!filtered.length) { mount.innerHTML = '<div class="ops-empty-table">暂无事件。可放宽时间范围，或切换到“全部事件”。</div>'; return; }
    const heartbeat = filtered.filter(evt => evt.event_type === 'agent_push_ok');
    const important = filtered.filter(evt => evt.event_type !== 'agent_push_ok');
    const heartbeatPreview = heartbeat.slice(0, 6);
    mount.innerHTML = [
      heartbeat.length ? renderHeartbeatSummary(heartbeat) : '',
      ...important.map(evt => renderDiagnosticEvent(evt, this._levelClass(evt.level))),
      ...heartbeatPreview.map(evt => renderDiagnosticEvent(evt, this._levelClass(evt.level)))
    ].join('');
    mount.querySelectorAll('.ops-node-filter').forEach(btn => btn.addEventListener('click', () => { if (btn.dataset.server) { this._el.querySelector('#ops-server-id').value = btn.dataset.server; this.load(); } }));
  }
}

function renderHeartbeatSummary(events) {
  const latest = events[0];
  const servers = [...new Set(events.map(e => e.server_id).filter(Boolean))];
  const ips = [...new Set(events.map(e => e.payload?.ip).filter(Boolean))].slice(0, 6);
  return `<section class="ops-heartbeat-summary"><div><strong>健康心跳汇总</strong><small>已折叠 ${events.length} 条 Agent 指标上报，下面仅展示最近 ${Math.min(6, events.length)} 条样例。</small></div><div class="ops-heartbeat-meta"><span>节点 ${servers.length || '—'}</span><span>最新 ${esc(fmtTime(latest?.created_at))}</span>${ips.map(ip=>`<span>${esc(ip)}</span>`).join('')}</div></section>`;
}

function readableTitle(evt) {
  return EVENT_META[evt.event_type]?.name || evt.title || evt.event_type || '未知事件';
}

function renderDiagnosticEvent(evt, levelClass) {
  const meta = EVENT_META[evt.event_type] || { name: evt.event_type || '未知事件', icon:'📌', impact:'暂无内置解释，请查看原始消息和关键字段。', action:'根据 payload 字段和后端日志进一步排查。' };
  const payload = evt.payload && typeof evt.payload === 'object' ? evt.payload : {};
  const keyFields = compactFields(payload, ['ip','status','uuid','host','port','protocol','latency_ms','loss','error','reason','channel','chat_id','metric','value','threshold']);
  const raw = [evt.message, payloadPreview(payload)].filter(Boolean).join(' ｜ ');
  return `
    <article class="ops-diag-card ${levelClass} ${evt.event_type === 'agent_push_ok' ? 'heartbeat' : ''}">
      <div class="ops-diag-main">
        <div class="ops-diag-icon">${esc(meta.icon)}</div>
        <div class="ops-diag-body">
          <div class="ops-diag-title-row">
            <strong>${esc(meta.name)}</strong>
            <span class="ops-level ${levelClass}">${esc(evt.level || 'info')}</span>
            <code>${esc(evt.event_type || '—')}</code>
          </div>
          <div class="ops-diag-title">${esc(evt.title || meta.name)}</div>
          <div class="ops-diag-grid">
            <div><span>时间</span><b>${esc(fmtTime(evt.created_at))}</b></div>
            <div><span>节点</span><button class="ops-node-filter" data-server="${esc(evt.server_id || '')}">${esc(evt.server_id || '全部/无')}</button></div>
            <div><span>规则</span><b>${esc(evt.rule_id || '—')}</b></div>
          </div>
          <div class="ops-diag-explain"><b>影响：</b>${esc(meta.impact)}</div>
          <div class="ops-diag-action"><b>建议：</b>${esc(meta.action)}</div>
          ${keyFields ? `<div class="ops-diag-fields">${keyFields}</div>` : ''}
          ${raw ? `<details class="ops-diag-raw"><summary>原始详情</summary><pre>${esc(raw)}</pre></details>` : ''}
        </div>
      </div>
    </article>`;
}

function compactFields(payload, keys) {
  const items = keys.filter(k => payload[k] !== undefined && payload[k] !== null && payload[k] !== '').map(k => `<span><em>${esc(k)}</em>${esc(payload[k])}</span>`);
  return items.join('');
}
function payloadPreview(payload) {
  const keys = Object.keys(payload || {});
  if (!keys.length) return '';
  try { return JSON.stringify(payload).slice(0, 500); } catch { return String(payload).slice(0, 500); }
}
