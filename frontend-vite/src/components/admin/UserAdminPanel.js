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
      <div class="admin-section-title">会话管理</div>
      <div class="admin-card session-admin-card">
        <div class="users-toolbar session-toolbar">
          <div>
            <div class="admin-card-title">登录会话</div>
            <div class="acct-subtle">查看当前账户的活跃后台登录会话；可删除其它会话，当前会话请通过“退出登录”结束。</div>
          </div>
          <div class="users-actions">
            <button id="sessions-delete-all" class="session-danger-btn">删除全部会话</button>
            <button id="sessions-refresh" class="add-btn">刷新</button>
          </div>
        </div>
        <div id="sessions-msg" class="acct-msg"></div>
        <div id="sessions-table-wrap" class="users-table-wrap session-table-wrap"></div>
      </div>
    `;
  }

  _bind() {
    this._el.querySelector('#sessions-refresh').addEventListener('click', () => this.load());
    this._el.querySelector('#sessions-delete-all').addEventListener('click', async () => {
      if (!confirm('确定删除除当前会话外的全部会话吗？')) return;
      try {
        const data = await deleteOtherSessions();
        this._flash(`已删除 ${data.deleted ?? 0} 个其它会话`, 'ok');
        await this.load();
      } catch (err) {
        this._flash(err.message || '删除全部会话失败', 'err');
      }
    });
    this._el.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-delete-session]');
      if (!btn) return;
      const sid = btn.dataset.sessionId;
      if (!sid || !confirm('确定删除该会话吗？')) return;
      try {
        await deleteSession(sid);
        this._flash('会话已删除', 'ok');
        await this.load();
      } catch (err) {
        this._flash(err.message || '删除会话失败', 'err');
        await this.load();
      }
    });
  }

  async load() {
    const wrap = this._el.querySelector('#sessions-table-wrap');
    wrap.innerHTML = '加载中...';
    try {
      const data = await listSessions();
      this._sessions = data.sessions || [];
      wrap.innerHTML = renderSessionTable(this._sessions);
    } catch (err) {
      wrap.innerHTML = `<div style="color:var(--red)">会话列表加载失败：${escapeHtml(err.message || 'unknown')}</div>`;
    }
  }

  _flash(text, kind) {
    const el = this._el.querySelector('#sessions-msg');
    el.textContent = text;
    el.className = `acct-msg ${kind}`;
  }
}

function renderSessionTable(sessions) {
  if (!sessions.length) return '<div class="acct-subtle">暂无会话记录。重新登录后会自动记录当前会话。</div>';
  const rows = sessions.map(s => {
    const sid = String(s.id || '');
    const shortId = sid ? `${escapeHtml(sid.slice(0, 8))}...` : '—';
    return `
      <tr>
        <td><code class="session-id-short" title="${escapeHtml(sid)}">${shortId}</code>${s.current ? ' <span class="session-current">(当前)</span>' : ''}</td>
        <td>${escapeHtml(s.ua || s.user_agent || '—')}</td>
        <td>${escapeHtml(s.ip || '—')}</td>
        <td>${escapeHtml(s.latest_ip || s.ip || '—')}</td>
        <td>${fmt(s.expires_at)}</td>
        <td>${fmtRelative(s.last_login || s.created_at)}</td>
        <td>${s.current ? '<span class="acct-subtle">—</span>' : `<button class="session-delete-link" data-delete-session="1" data-session-id="${escapeHtml(sid)}">删除</button>`}</td>
      </tr>
    `;
  }).join('');
  return `
    <table class="users-table sessions-table">
      <thead><tr><th>会话 ID</th><th>UA</th><th>IP</th><th>Latest IP</th><th>过期时间</th><th>上次登录</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function toDate(v) {
  if (!v) return null;
  if (typeof v === 'number') return new Date(v * 1000);
  const n = Number(v);
  if (Number.isFinite(n) && n > 1000000000) return new Date(n * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
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
  return `${text} (${rel})`;
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}
