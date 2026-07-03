/**
 * components/admin/LoginPanel.js
 * 登录面板：渲染表单、处理登录、触发成功/失败回调
 */
import { login, getOAuthProviders } from '../../api/auth.js';

export class LoginPanel {
  /**
   * @param {string} mountId  挂载容器 ID
   * @param {{ onSuccess: () => void }} callbacks
   */
  constructor(mountId, { onSuccess } = {}) {
    this._el = document.getElementById(mountId);
    this._onSuccess = onSuccess || (() => {});
    this._oauth = { google: false, github: false };
    this._render();
    this._bind();
    this._loadOAuthProviders();
  }

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <div class="login-overlay" id="loginOverlay">
        <div class="login-box">
          <div class="login-logo">
            <div class="login-logo-text">VPS<span style="color:var(--gold)">·</span>星图</div>
            <div class="login-logo-sub">管理员登录 / Admin Access</div>
          </div>
          <div class="login-field">
            <label>用户名</label>
            <input class="login-input" id="lp-user" placeholder="admin" autocomplete="username">
          </div>
          <div class="login-field">
            <label>密码</label>
            <input class="login-input" id="lp-pass" type="password" placeholder="••••••••" autocomplete="current-password">
          </div>
          <div class="login-field" id="lp-totp-wrap" style="display:none">
            <label>双因素验证码</label>
            <input class="login-input" id="lp-totp" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码">
          </div>
          <div class="login-err" id="lp-err"></div>
          <button class="login-btn" id="lp-btn">登 录</button>
          <div class="login-divider"><span>或使用第三方登录</span></div>
          <div class="oauth-grid">
            <a class="oauth-btn oauth-google disabled" id="lp-google" href="#">Google 登录（未配置）</a>
            <a class="oauth-btn oauth-github disabled" id="lp-github" href="#">GitHub 登录（未配置）</a>
          </div>
          <div class="login-tip">第三方登录默认仅允许白名单邮箱进入管理后台；当前后台保持只读监控安全边界。</div>
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
    const totp = this._el.querySelector('#lp-totp');
    this._el.querySelector('.login-box')?.addEventListener('click', e => e.stopPropagation());
    btn.addEventListener('click',  () => this._submit());
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') this._submit(); });
    totp?.addEventListener('keydown', e => { if (e.key === 'Enter') this._submit(); });
  }

  async _loadOAuthProviders() {
    const err = this._el.querySelector('#lp-err');
    try {
      this._oauth = await getOAuthProviders();
    } catch (_) {}
    for (const provider of ['google', 'github']) {
      const el = this._el.querySelector(`#lp-${provider}`);
      if (!el) continue;
      if (this._oauth?.[provider]) {
        el.classList.remove('disabled');
        el.href = `/api/v1/auth/oauth/${provider}/start`;
        el.textContent = provider === 'google' ? '使用 Google 登录' : '使用 GitHub 登录';
      } else {
        el.classList.add('disabled');
        el.href = '#';
      }
    }
    const params = new URLSearchParams(window.location.search);
    const oauthErr = params.get('login_error');
    if (oauthErr) err.textContent = decodeURIComponent(oauthErr);
  }

  async _submit() {
    const u   = this._el.querySelector('#lp-user').value.trim();
    const p   = this._el.querySelector('#lp-pass').value;
    const code = this._el.querySelector('#lp-totp')?.value.trim() || '';
    const err = this._el.querySelector('#lp-err');
    const btn = this._el.querySelector('#lp-btn');
    if (!u || !p) return;

    btn.textContent = '登录中...'; btn.disabled = true; err.textContent = '';
    try {
      await login(u, p, code);
      this.hide();
      this._onSuccess();
    } catch (e) {
      if (e?.two_factor_required) {
        this._el.querySelector('#lp-totp-wrap').style.display = '';
        this._el.querySelector('#lp-totp')?.focus();
      }
      err.textContent = this._formatLoginError(e);
      if (!e?.two_factor_required) this._el.querySelector('#lp-pass').value = '';
    } finally {
      btn.textContent = '登 录'; btn.disabled = false;
    }
  }

  _formatLoginError(error) {
    const status = Number(error?.status || 0);
    if (status === 400) return '请输入用户名和密码';
    if (error?.two_factor_required) return '请输入双因素验证码';
    if (status === 401) return '用户名或密码错误';
    if (status === 403) return error?.message || '当前账号无权登录管理后台';
    if (status === 429) return error?.message || '尝试次数过多，请稍后再试';
    if (error?.name === 'TypeError') return '网络连接失败，请检查后重试';
    return error?.message || '登录失败，请重试';
  }

  // ── 公开 ─────────────────────────────────────────────────────────────────

  show() { this._el.style.display = ''; }
  hide() { this._el.style.display = 'none'; }
}
