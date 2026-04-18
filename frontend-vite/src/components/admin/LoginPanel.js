/**
 * components/admin/LoginPanel.js
 * 登录面板：渲染表单、处理登录、触发成功/失败回调
 */
import { login } from '../../api/auth.js';

export class LoginPanel {
  /**
   * @param {string} mountId  挂载容器 ID
   * @param {{ onSuccess: () => void }} callbacks
   */
  constructor(mountId, { onSuccess } = {}) {
    this._el = document.getElementById(mountId);
    this._onSuccess = onSuccess || (() => {});
    this._render();
    this._bind();
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <div style="position:fixed;inset:0;z-index:400;background:var(--bg);display:flex;align-items:center;justify-content:center" id="loginOverlay">
        <div class="login-box" onclick="event.stopPropagation()">
          <div class="login-logo">
            <div class="login-logo-text">VPS<span style="color:var(--gold)">·</span>星图</div>
            <div class="login-logo-sub">管理员登录</div>
          </div>
          <div class="login-field">
            <label>用户名</label>
            <input class="login-input" id="lp-user" placeholder="admin" autocomplete="username">
          </div>
          <div class="login-field">
            <label>密码</label>
            <input class="login-input" id="lp-pass" type="password" placeholder="••••••••" autocomplete="current-password">
          </div>
          <div class="login-err" id="lp-err"></div>
          <button class="login-btn" id="lp-btn">登 录</button>
          <div style="text-align:center;margin-top:14px">
            <a href="/" style="font-size:11px;color:var(--text3);text-decoration:none">← 返回前台</a>
          </div>
        </div>
      </div>`;
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────

  _bind() {
    const btn  = this._el.querySelector('#lp-btn');
    const pass = this._el.querySelector('#lp-pass');
    btn.addEventListener('click',  () => this._submit());
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') this._submit(); });
  }

  async _submit() {
    const u   = this._el.querySelector('#lp-user').value.trim();
    const p   = this._el.querySelector('#lp-pass').value;
    const err = this._el.querySelector('#lp-err');
    const btn = this._el.querySelector('#lp-btn');
    if (!u || !p) return;

    btn.textContent = '登录中...'; btn.disabled = true; err.textContent = '';
    try {
      await login(u, p);
      this.hide();
      this._onSuccess();
    } catch (e) {
      err.textContent = e.message || '登录失败，请重试';
      this._el.querySelector('#lp-pass').value = '';
    } finally {
      btn.textContent = '登 录'; btn.disabled = false;
    }
  }

  // ── 公开 ─────────────────────────────────────────────────────────────────

  show() { this._el.style.display = ''; }
  hide() { this._el.style.display = 'none'; }
}
