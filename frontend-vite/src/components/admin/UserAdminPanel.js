import { listSessions, deleteSession, deleteOtherSessions } from '../../api/admin.js';

export class UserAdminPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._sessions = [];
    this._render();
    this._bind();
  }

  _render() {
    this._el.innerHTML = `
      <div class="admin-section-title">登录会话</div>
      <div class="admin-card session-admin-card session-audit-card">
        <div class="users-toolbar session-toolbar">
          <div>
            <div class="admin-card-title">登录安全审计</div>
            <div class="acct-subtle">检查当前管理员账户的登录设备、来源 IP、最近活跃和风险状态。当前登录不能在这里删除，请用“退出登录”结束。</div>
          </div>
          <div class="users-actions session-actions">
            <button id="sessions-delete-all" class="session-danger-btn session-action-btn">退出其他设备</button>
            <button id="sessions-refresh" class="add-btn session-action-btn">刷新</button>
          </div>
        </div>
        <div id="sessions-msg" class="acct-msg"></div>
        <div id="sessions-overview" class="session-overview-grid"></div>
        <div id="sessions-table-wrap" class="users-table-wrap session-table-wrap"></div>
      </div>
    `;
  }

  _bind() {
    this._el.querySelector('#sessions-refresh').addEventListener('click', () => this.load());
    this._el.querySelector('#sessions-delete-all').addEventListener('click', async () => {
      if (!confirm('确定退出除当前登录外的全部设备吗？')) return;
      try {
        const data = await deleteOtherSessions();
        this._flash(`已退出 ${data.deleted ?? 0} 个其他设备`, 'ok');
        await this.load();
      } catch (err) {
        this._flash(err.message || '退出其他设备失败', 'err');
      }
    });
    this._el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-delete-session]');
      if (!btn) return;
      const sid = btn.dataset.sessionId;
      if (!sid || !confirm('确定退出该设备吗？')) return;
      try {
        await deleteSession(sid);
        this._flash('已退出该设备', 'ok');
        await this.load();
      } catch (err) {
        this._flash(err.message || '退出设备失败', 'err');
        await this.load();
      }
    });
  }

  async load() {
    const wrap = this._el.querySelector('#sessions-table-wrap');
    const overview = this._el.querySelector('#sessions-overview');
    wrap.textContent = '加载中...';
    overview.innerHTML = '';
    try {
      const data = await listSessions();
      this._sessions = data.sessions || [];
      const effective = this._sessions.length ? this._sessions : [currentSessionFallback()];
      overview.innerHTML = renderSessionOverview(effective, data.count ?? this._sessions.length);
      wrap.innerHTML = renderSessionCards(effective);
    } catch (err) {
      wrap.innerHTML = `<div class="session-empty error">会话列表加载失败：${escapeHtml(err.message || 'unknown')}</div>`;
    }
  }

  _flash(text, kind) {
    const el = this._el.querySelector('#sessions-msg');
    el.textContent = text;
    el.className = `acct-msg ${kind}`;
  }
}

function renderSessionOverview(sessions, rawCount) {
  const active = sessions.length;
  const ips = new Set(sessions.map(s => s.latest_ip || s.ip).filter(Boolean));
  const stale = sessions.filter(s => ageHours(s.last_seen || s.last_login || s.created_at) > 24).length;
  const fallback = sessions.some(s => s.fallback);
  const risk = fallback ? '当前设备' : stale ? '需关注' : active > 1 ? '多设备' : '正常';
  return `
    <div class="session-stat"><span>活跃登录</span><strong>${active}</strong><small>${fallback ? '当前 Cookie 会话' : `后端记录 ${rawCount ?? active}`}</small></div>
    <div class="session-stat"><span>来源 IP</span><strong>${ips.size || '—'}</strong><small>${fallback ? '由当前连接推断' : (ips.size > 1 ? '存在多来源' : '单一来源')}</small></div>
    <div class="session-stat"><span>超过 24h</span><strong>${stale}</strong><small>${stale ? '建议检查' : '暂无过期风险'}</small></div>
    <div class="session-stat ${risk === '正常' || risk === '当前设备' ? 'ok' : 'warn'}"><span>安全状态</span><strong>${risk}</strong><small>${fallback ? '当前版本仅返回本设备会话' : '可退出其他设备'}</small></div>
  `;
}

function renderSessionCards(sessions) {
  if (!sessions.length) sessions = [currentSessionFallback()];
  return `<div class="session-card-list">${sessions.map(renderSessionCard).join('')}</div>`;
}

function renderSessionCard(s) {
  const sid = String(s.id || '');
  const isCurrent = !!(s.current || s.fallback);
  const ip = s.latest_ip || s.ip || '—';
  const last = s.last_seen || s.last_login || s.created_at;
  const expires = s.expires_at;
  const risk = sessionRisk(s);
  return `
    <article class="session-device-card ${isCurrent ? 'current' : ''} ${risk.level}">
      <div class="session-device-main">
        <div class="session-device-icon">${deviceIcon(s.ua || s.user_agent)}</div>
        <div>
          <div class="session-device-title">${isCurrent ? '本次登录' : '已登录设备'} ${isCurrent ? '<span class="session-current-pill">当前</span>' : ''}</div>
          <div class="session-device-ua">${escapeHtml(shortUA(s.ua || s.user_agent || '未知浏览器'))}</div>
        </div>
      </div>
      <div class="session-device-meta">
        <div><span>来源 IP</span><b>${escapeHtml(ip)}</b></div>
        <div><span>最近活跃</span><b>${fmtRelative(last)}</b></div>
        <div><span>过期时间</span><b>${fmt(expires)}</b></div>
        <div><span>会话 ID</span><b><code title="${escapeHtml(sid)}">${escapeHtml(sid ? sid.slice(0, 12) + '…' : '—')}</code></b></div>
      </div>
      <div class="session-device-footer">
        <span class="session-risk ${risk.level}">${risk.text}</span>
        ${s.fallback ? '<small>后端当前只返回本设备 Cookie，会话审计已按当前设备展示。</small>' : ''}
        ${isCurrent ? '<button class="session-action-btn ghost" disabled>当前登录</button>' : `<button class="session-action-btn danger" data-delete-session="1" data-session-id="${escapeHtml(sid)}">退出此设备</button>`}
      </div>
    </article>
  `;
}

function sessionRisk(s) {
  if (s.fallback) return { level:'ok', text:'当前设备' };
  if (ageHours(s.last_seen || s.last_login || s.created_at) > 24) return { level:'warn', text:'长期未活跃' };
  return { level:'ok', text:'正常活跃' };
}
function currentSessionFallback() {
  return { id:'current-cookie-session', current:true, fallback:true, ua:navigator.userAgent, ip:'当前连接', latest_ip:'当前连接', created_at:new Date().toISOString(), last_login:new Date().toISOString() };
}
function deviceIcon(ua) {
  const s = String(ua || '').toLowerCase();
  if (s.includes('mobile') || s.includes('android') || s.includes('iphone')) return '📱';
  if (s.includes('linux')) return '🖥️';
  if (s.includes('mac')) return '💻';
  if (s.includes('windows')) return '🪟';
  return '🌐';
}
function shortUA(ua) {
  const s = String(ua || '');
  const browser = (s.match(/(HeadlessChrome|Chrome|Firefox|Safari|Edg)\/([\d.]+)/) || []);
  const os = (s.match(/\(([^)]+)\)/) || [])[1] || '';
  return browser[1] ? `${browser[1]} ${browser[2]} · ${os.split(';').slice(0,2).join(' / ')}` : s.slice(0,96);
}
function toDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v * 1000);
  const n = Number(v);
  if (Number.isFinite(n) && n > 1000000000) return new Date(n * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
function ageHours(v) {
  const d = toDate(v);
  return d ? Math.max(0, (Date.now() - d.getTime()) / 36e5) : 0;
}
function fmt(v) {
  const d = toDate(v);
  if (!d) return '—';
  try { return d.toLocaleString('zh-CN'); } catch { return String(v); }
}
function fmtRelative(v) {
  const d = toDate(v);
  if (!d) return '—';
  const text = d.toLocaleString('zh-CN');
  const sec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  let rel = '刚刚';
  if (sec >= 86400) rel = `${Math.floor(sec / 86400)}天${Math.floor((sec % 86400) / 3600)}小时前`;
  else if (sec >= 3600) rel = `${Math.floor(sec / 3600)}小时前`;
  else if (sec >= 60) rel = `${Math.floor(sec / 60)}分钟前`;
  return `${text}（${rel}）`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}
