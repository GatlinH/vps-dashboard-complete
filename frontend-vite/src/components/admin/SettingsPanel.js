import { getSettingsSummary, getSiteSettings, saveSiteSettings, getGeneralSettings, saveGeneralSettings, updateGeoipDatabase, getCloudflareSettings, saveCloudflareSettings, refreshCloudflareSettings, getLoginSettings, saveLoginSettings, getNotificationSettings, saveNotificationSettings, testNotificationSettings, uploadSiteFavicon, resetSiteFavicon, siteFaviconUrl, downloadSiteBackupUrl, restoreSiteBackup, generateSiteShareLink, revokeSiteShareLink } from '../../api/admin.js';

export class SettingsPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._activeSection = 'site';
    this._render();
    this._bind();
  }

  _render() {
    this._el.innerHTML = `<div class="komari-settings-page"><div class="komari-page-head"><div><h2 id="settings-title">站点</h2><p id="settings-subtitle">设置站点名称、描述和展示行为。</p></div></div><div id="settings-banner"></div><div class="komari-section-tabs"><button data-section="site">站点</button><button data-section="login">登录</button><button data-section="notify">通知</button><button data-section="general">通用</button><button data-section="proxy">反向代理</button></div><div class="komari-settings-grid two"><section class="komari-panel komari-section-panel" data-settings-section="site"><div class="komari-panel-title"><span>站点名称</span><small>设置站点名称</small></div><div class="komari-form-grid one"><label><input id="site-name" class="form-input"></label></div><div class="komari-action-row"><button class="komari-primary" id="site-save">保存</button></div><div class="komari-panel-title sub"><span>站点描述</span><small>设置站点描述，用于元信息及社交媒体关联。</small></div><div class="komari-form-grid one"><label><textarea id="site-description" class="form-input" rows="3"></textarea></label></div><div class="komari-action-row"><button class="komari-primary" id="site-save-2">保存</button></div><div class="komari-toggle-row"><div><strong>允许跨域请求</strong><small>允许来自其他域名的请求访问 API</small></div><label class="komari-switch"><input id="site-cors" type="checkbox"><span></span></label></div><div class="komari-toggle-row"><div><strong>向访客显示部分 IP 地址</strong><small>未登录时仅展示部分隐藏 IP，用于部分主题显示 IP</small></div><label class="komari-switch"><input id="site-show-ip" type="checkbox"><span></span></label></div><div class="komari-panel-title sub"><span>代理连接地址</span><small>用于安装探针和配置代理连接地址</small></div><div class="komari-form-grid one"><label><input id="site-proxy-url" class="form-input" placeholder="http://127.0.0.1:25777"></label><div class="komari-inline-field"><span>临时分享</span><select id="site-auto-share" class="form-input"><option value="off">关闭</option><option value="manual">手动</option><option value="auto">自动</option></select></div><input id="site-custom-head" type="hidden"><input id="site-custom-body" type="hidden"></div><div class="komari-action-row"><button class="komari-primary" id="site-save-3">保存</button></div><h3 class="komari-settings-heading">私有站点</h3><div class="komari-toggle-row"><div><strong>私有站点</strong><small>开启后前台数据需要登录后才可查看。</small></div><label class="komari-switch"><input id="site-single-mode" type="checkbox"><span></span></label></div><div class="komari-setting-card site-share-card"><div class="komari-setting-copy"><strong>临时访问链接</strong><small>为访客生成限时访问链接，用于临时分享私有站点。</small></div><div class="site-share-controls"><input id="site-share-hours" class="form-input" type="number" min="1" max="720" value="24"><button class="komari-secondary" id="site-share-generate" type="button">生成链接</button><button class="komari-danger" id="site-share-revoke" type="button">撤销</button></div><input id="site-share-url" class="form-input" readonly placeholder="尚未生成临时访问链接"></div><h3 class="komari-settings-heading">习惯</h3><div class="komari-panel-title sub"><span>头部</span><small>添加自定义 HTML/CSS/JavaScript 到站点头部，这些内容将在所有页面加载</small></div><textarea class="form-input" rows="4" disabled></textarea><div class="komari-action-row"><button class="komari-primary">保存</button></div><div class="komari-panel-title sub"><span>自定义身体</span><small>在页面区域添加自定义内容</small></div><textarea class="form-input" rows="4" disabled></textarea><div class="komari-action-row"><button class="komari-primary">保存</button></div><div class="komari-site-bottom-tools" id="site-bottom-tools">
  <div class="komari-panel-title sub"><span>自定义图标</span><small>设置或更换站点图标。</small></div>
  <div class="komari-setting-card favicon-card">
    <div class="komari-setting-copy"><strong>当前网站图标</strong><small>Favicon 会显示在浏览器标签页、收藏夹和站点快捷方式中。</small></div>
    <div class="favicon-preview-wrap"><img id="site-favicon-preview" class="favicon-preview" alt="当前网站图标"><span id="site-favicon-state" class="favicon-state">默认</span></div>
  </div>
  <div class="komari-action-row"><button class="komari-danger" id="site-favicon-reset" type="button">恢复默认</button><button class="komari-primary" id="site-favicon-pick" type="button">更新 网站图标</button><input id="site-favicon-file" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.ico" hidden></div>
  <h3 class="komari-settings-heading">备份</h3>
  <div class="komari-backup-list">
    <div class="komari-backup-row"><div><strong>下载备份</strong><small>下载当前站点设置备份（站点、通用、登录、通知、反向代理配置）。</small></div><button class="komari-icon-button blue" id="site-backup-download" type="button" title="下载备份">↓</button></div>
    <div class="komari-backup-row"><div><strong>恢复备份</strong><small>从 ZIP 备份文件恢复站点设置，会覆盖当前配置。</small></div><button class="komari-secondary purple" id="site-backup-pick" type="button">选择</button><input id="site-backup-file" type="file" accept="application/zip,.zip" hidden></div>
  </div>
</div><div id="site-msg" class="komari-msg"></div></section><section class="komari-panel komari-section-panel" data-settings-section="general"><div class="komari-panel-title"><span>通用</span><small>geoip / history / grpc</small></div><div class="komari-form-grid one"><label><span>自动发现按钮内容</span><input id="general-auto-discovery" class="form-input"></label><label class="komari-inline-check"><input id="general-geoip-enabled" type="checkbox"> <span>完善归属信息 / 启用 GeoIP</span></label><label><span>GeoIP 数据源</span><select id="general-geoip-provider" class="form-input"><option value="ipinfo.io">ipinfo.io</option><option value="ip-api.com">ip-api.com</option><option value="geojs.io">geojs.io</option><option value="maxmind">maxmind</option></select></label><div class="komari-action-row geoip-update-row"><button class="komari-secondary" id="general-geoip-update" type="button">更新 GeoIP 数据库</button></div><label class="komari-inline-check"><input id="general-history-enabled" type="checkbox"> <span>开启历史记录</span></label><label><span>负载数据保存时间（小时）</span><input id="general-load-hours" class="form-input" type="number"></label><label><span>Ping 数据保存时间（小时）</span><input id="general-ping-hours" class="form-input" type="number"></label><h3 class="komari-settings-heading">哪吒兼容</h3><label class="komari-inline-check"><input id="general-grpc-enabled" type="checkbox"> <span>开启哪吒兼容 gRPC</span></label><label><span>哪吒 gRPC 监听地址</span><input id="general-grpc-listen" class="form-input" placeholder="0.0.0.0:5555"></label></div><div class="komari-action-row"><button class="komari-primary" id="general-save">保存通用设置</button></div><div id="general-msg" class="komari-msg"></div></section></div><div class="komari-settings-grid two" style="margin-top:18px"><section class="komari-panel komari-section-panel" data-settings-section="proxy"><div class="komari-panel-title"><span>Cloudflare 隧道</span><small>reverse proxy runtime</small></div><div id="cf-status-box" class="komari-kv-box">加载中...</div><div class="komari-form-grid one"><label><span>Cloudflare Tunnel 令牌</span><input id="cf-token" type="password" class="form-input" placeholder="请输入 Cloudflare Tunnel 令牌"></label><label><span>cloudflared 二进制路径</span><input id="cf-bin" class="form-input" placeholder="/usr/local/bin/cloudflared"></label></div><div class="komari-action-row"><button class="komari-primary" id="cf-save">保存 Cloudflare 设置</button><button class="komari-secondary" id="cf-refresh">刷新状态</button></div><div id="cf-msg" class="komari-msg"></div></section><section class="komari-panel komari-section-panel komari-login-panel" data-settings-section="login">
  <h3 class="login-section-heading first">登录</h3>
  <div class="login-setting-row"><div><strong>禁止密码登录</strong></div><label class="komari-switch"><input id="login-disable-password" type="checkbox"><span></span></label></div>
  <h3 class="login-section-heading">单点登录</h3>
  <div class="login-setting-row"><div><strong>启用单点登录</strong><small>允许用户通过第三方账户（如 GitHub）登录</small></div><label class="komari-switch"><input id="login-sso-enabled" type="checkbox"><span></span></label></div>
  <div class="login-setting-row"><div><strong>单点登录提供商</strong><small>选择用于单点登录的身份验证提供商</small></div><select id="login-sso-provider" class="login-provider-select"><option value="CloudflareAccess">CloudflareAccess</option><option value="generic">generic</option><option value="qq">qq</option><option value="github">github</option></select></div>
  <div class="login-param-card" id="login-param-card"><div class="login-param-head"><div><strong>登录参数</strong><small>设置您选择登录方式的详细信息</small></div><button class="login-collapse" type="button">⌃</button></div><div id="login-param-fields" class="login-param-fields"></div><div class="login-callback">回调地址: <span id="login-callback-url"></span></div><div class="login-save-row"><button class="komari-primary" id="login-save" type="button">保存</button></div></div>
  <h3 class="login-section-heading">API</h3>
  <div class="login-api-card"><strong>API密钥</strong><small>使用API密钥可以访问并操作后台资源，包括修改设置和账号密码等，请谨慎保管。留空表示取消API密钥功能。</small><input id="login-api-key" class="form-input" type="text"><div class="login-api-actions"><button class="login-generate" id="login-api-generate" type="button">生成</button><button class="komari-primary" id="login-api-save" type="button">保存</button></div></div>
  <input id="login-github-id" type="hidden"><input id="login-github-secret" type="hidden"><input id="login-allowed-emails" type="hidden"><input id="login-api-key-enabled" type="hidden"><input id="login-breakglass-enabled" type="hidden"><div id="login-runtime" hidden></div><div id="login-msg" class="komari-msg"></div>
</section></section></div><div class="komari-settings-grid two" style="margin-top:18px"><section class="komari-panel komari-section-panel" data-settings-section="notify">
  <div class="komari-notify-master-card"><div><strong>开启通知</strong><small>开启后可在需要时接收通知消息。</small></div><label class="komari-switch"><input id="notify-enabled" type="checkbox"><span></span></label></div>
  <div class="komari-notify-template-card"><div class="komari-notify-template-head"><div><strong>消息通知模板</strong><small>Komari 将使用此消息模板发送通知。</small></div></div><textarea id="notify-template" class="form-input notify-template-box" rows="8" placeholder="{{emoji}}{{title}}{{emoji}}&#10;Event: {{event}}&#10;Client: {{client}}"></textarea><div class="notify-save-row"><button class="komari-primary" id="notify-template-save" type="button">保存</button></div></div>
  <div class="komari-notify-settings-card" id="notify-settings-card"><div class="komari-notify-settings-head"><div><strong>发送设置</strong><small>详细设置您选择的信息发送渠道</small></div><select id="notify-channel" class="notify-select"><option>Javascript</option><option>Server酱Turbo</option><option>Server酱³</option><option>Server酱</option><option>bark</option><option>email</option><option>empty</option><option>telegram</option><option>webhook</option></select><button class="notify-collapse" type="button">⌃</button></div><div id="notify-channel-fields" class="notify-field-stack"></div><div class="notify-save-row"><button class="komari-primary" id="notify-save">保存</button></div><div id="notify-msg" class="komari-msg"></div></div>
  <div class="komari-notify-card"><div><strong>发送测试消息</strong><small>发送测试消息</small></div><button class="komari-primary" id="notify-test">GO</button></div>
  <div class="komari-note">正在寻找过期通知？ 已经迁移到通知-通用 ↗</div>
</section><section class="komari-panel komari-section-panel" data-settings-section="login notify proxy"><div class="komari-panel-title"><span>运行态摘要</span><small>security / oauth</small></div><div id="oauth-runtime" class="komari-kv-box">加载中...</div><div class="komari-note">登录配置已接入后台持久化；真正把这些配置写回环境变量 / OAuth 启动参数，还需要下一步接服务重载闭环。</div></section></div></div>`;
  }

  _bind() {
    this._el.querySelectorAll('.komari-section-tabs button').forEach((btn) => btn.addEventListener('click', () => this.setSection(btn.dataset.section)));
    this._el.querySelector('#site-save').addEventListener('click', () => this._saveSite());
    this._el.querySelector('#site-save-2').addEventListener('click', () => this._saveSite());
    this._el.querySelector('#site-save-3').addEventListener('click', () => this._saveSite());
    this._el.querySelector('#site-share-generate')?.addEventListener('click', () => this._generateShareLink());
    this._el.querySelector('#site-share-revoke')?.addEventListener('click', () => this._revokeShareLink());
    this._el.querySelector('#site-favicon-pick')?.addEventListener('click', () => this._el.querySelector('#site-favicon-file')?.click());
    this._el.querySelector('#site-favicon-file')?.addEventListener('change', (ev) => this._uploadFavicon(ev));
    this._el.querySelector('#site-favicon-reset')?.addEventListener('click', () => this._resetFavicon());
    this._el.querySelector('#site-backup-download')?.addEventListener('click', () => this._downloadBackup());
    this._el.querySelector('#site-backup-pick')?.addEventListener('click', () => this._el.querySelector('#site-backup-file')?.click());
    this._el.querySelector('#site-backup-file')?.addEventListener('change', (ev) => this._restoreBackup(ev));
    this._el.querySelector('#general-save').addEventListener('click', () => this._saveGeneral());
    this._el.querySelector('#general-geoip-update')?.addEventListener('click', () => this._updateGeoipDatabase());
    this._el.querySelector('#cf-save').addEventListener('click', () => this._saveCloudflare());
    this._el.querySelector('#cf-refresh').addEventListener('click', () => this._refreshCloudflare());
    this._el.querySelector('#login-save').addEventListener('click', () => this._saveLogin());
    this._el.querySelector('#login-api-save')?.addEventListener('click', () => this._saveLogin());
    this._el.querySelector('#login-api-generate')?.addEventListener('click', () => this._generateApiKey());
    this._el.querySelector('#login-sso-provider')?.addEventListener('change', () => this._renderLoginProviderFields());
    this._el.querySelector('.login-collapse')?.addEventListener('click', (ev) => { const card=this._el.querySelector('#login-param-card'); const collapsed=card.classList.toggle('is-collapsed'); ev.currentTarget.textContent=collapsed?'⌄':'⌃'; });
    this._el.querySelector('#notify-save').addEventListener('click', () => this._saveNotify());
    this._el.querySelector('#notify-template-save').addEventListener('click', () => this._saveNotify());
    this._el.querySelector('#notify-channel').addEventListener('change', () => this._renderNotifyChannelFields());
    this._el.querySelector('#notify-test').addEventListener('click', () => this._testNotify());
  }

  async load() {
    try {
      this._renderBanner();
      const [summary, site, general, cf, login, notify] = await Promise.all([
        getSettingsSummary(),
        getSiteSettings(),
        getGeneralSettings(),
        getCloudflareSettings(),
        getLoginSettings(),
        getNotificationSettings(),
      ]);
      this._fillSite(site);
      this._fillGeneral(general);
      this._fillCloudflare(cf);
      this._fillLogin(login);
      this._fillNotify(notify);
      this._fillRuntime(summary);
      this._showSection();
    } catch (e) {
      this._el.querySelector('#settings-banner').innerHTML = `<div class="komari-danger-banner">设置页加载失败：${esc(e.message || 'unknown')}</div>`;
    }
  }



  setSection(section = 'site') {
    this._activeSection = ['site','login','notify','general','proxy'].includes(section) ? section : 'site';
    this._showSection();
  }

  _showSection() {
    if (!this._el) return;
    const active = this._activeSection || 'site';
    const titles = {site:['站点','设置站点名称、描述和展示行为。'], login:['登录','登录、OAuth 和回退策略。'], notify:['通知','告警和消息渠道设置。'], general:['通用','GeoIP、历史记录和兼容接口。'], proxy:['反向代理','Cloudflare 隧道与反代运行状态。']};
    const title = this._el.querySelector('#settings-title'); const sub = this._el.querySelector('#settings-subtitle');
    if (title && titles[active]) { title.textContent = titles[active][0]; sub.textContent = titles[active][1]; }
    this._renderBanner();
    this._el.querySelectorAll('.komari-section-tabs button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.section === active);
    });
    document.querySelectorAll('.admin-subtab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.settingsSection === active);
    });
    this._el.querySelectorAll('.komari-section-panel').forEach((panel) => {
      const sections = String(panel.dataset.settingsSection || '').split(/\s+/);
      panel.classList.toggle('is-visible', sections.includes(active));
    });
  }

  _renderBanner() {
    this._el.querySelector('#settings-banner').replaceChildren();
  }

  _fillSite(data) {
    this._siteData = data || {};
    this._set('#site-name', data.site_name || '');
    this._set('#site-description', data.site_description || '');
    this._set('#site-proxy-url', data.proxy_url || '');
    this._set('#site-auto-share', data.auto_share || 'manual');
    this._check('#site-single-mode', !!data.single_site_mode);
    const shareUrl = data.share_url || '';
    this._set('#site-share-url', shareUrl);
    this._set('#site-custom-head', data.custom_head || '');
    this._set('#site-custom-body', data.custom_body || '');
    this._renderFavicon(data);
  }

  _renderFavicon(data = {}) {
    const info = data.favicon || {};
    const img = this._el.querySelector('#site-favicon-preview');
    const state = this._el.querySelector('#site-favicon-state');
    if (!img || !state) return;
    if (info.has_custom_icon) {
      img.src = siteFaviconUrl();
      state.textContent = '自定义';
      state.className = 'favicon-state custom';
    } else {
      img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#171923"/><circle cx="32" cy="32" r="18" fill="#6366f1"/><path d="M18 38c8-12 20-12 28 0" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="25" cy="27" r="3" fill="#fff"/><circle cx="39" cy="27" r="3" fill="#fff"/></svg>');
      state.textContent = '默认';
      state.className = 'favicon-state';
    }
  }

  _fillGeneral(data) {
    this._set('#general-auto-discovery', data.auto_discovery_button || '');
    this._check('#general-geoip-enabled', !!data.geoip_enabled);
    this._set('#general-geoip-provider', data.geoip_provider || 'ipinfo.io');
    this._check('#general-history-enabled', !!data.history_enabled);
    this._set('#general-load-hours', data.retention_load_hours ?? 720);
    this._set('#general-ping-hours', data.retention_ping_hours ?? 24);
    this._check('#general-grpc-enabled', !!data.nezha_grpc_enabled);
    this._set('#general-grpc-listen', data.nezha_grpc_listen || '0.0.0.0:5555');
  }

  _fillCloudflare(data) {
    const html = `<div><span>cloudflared</span><b>${data.installed ? '已安装' : '未安装'}</b></div><div><span>状态</span><b>${esc(data.status || 'stopped')}</b></div><div><span>已保存令牌</span><b>${esc(data.cloudflare_token_masked || '未保存')}</b></div><div><span>二进制路径</span><b>${esc(data.binary || data.cloudflared_bin || '未检测到')}</b></div>`;
    this._el.querySelector('#cf-status-box').innerHTML = html;
    this._set('#cf-bin', data.cloudflared_bin || data.binary || '');
    this._el.querySelector('#cf-token').value = '';
  }

  _fillLogin(data) {
    this._loginData = data || {};
    this._check('#login-disable-password', !!data.disable_password_login);
    this._check('#login-sso-enabled', !!data.sso_enabled);
    this._set('#login-sso-provider', data.sso_provider || 'CloudflareAccess');
    this._set('#login-api-key', data.api_key_masked || '');
    const apiInput = this._el.querySelector('#login-api-key');
    if (apiInput) {
      apiInput.placeholder = data.api_key_enabled ? '已启用（输入新密钥才会轮换）' : '未启用';
      apiInput.dataset.maskedValue = data.api_key_masked || '';
    }
    this._set('#login-github-id', data.github_client_id || '');
    this._el.querySelector('#login-github-secret').value = '';
    this._set('#login-allowed-emails', data.allowed_emails || '');
    this._set('#login-api-key-enabled', data.api_key_enabled ? '1' : '0');
    this._set('#login-breakglass-enabled', data.breakglass_enabled !== false ? '1' : '0');
    this._renderLoginProviderFields();
  }

  _renderLoginProviderFields() {
    const provider = this._val('#login-sso-provider') || 'CloudflareAccess';
    const cfg = ((this._loginData || {}).sso_config || {})[provider] || {};
    const e = esc;
    const input = (key, label, type='text') => `<label class="login-param-field"><span>${label}</span><input id="login-sso-${key}" class="form-input" type="${type}" value="${e(cfg[key] || '')}"></label>`;
    let html = '';
    if (provider === 'CloudflareAccess') html = input('team_domain','team_domain *') + input('policy_aud','policy_aud *');
    else if (provider === 'qq') html = input('aggregation_url','aggregation_url *') + input('app_id','app_id *') + input('app_key','app_key *','password') + input('login_type','login_type *');
    else if (provider === 'generic') html = input('client_id','客户端 ID *') + input('client_secret','客户端密钥 *','password') + input('authorization_url','授权 URL *') + input('token_url','令牌 URL *') + input('userinfo_url','用户信息 URL *') + input('scope','作用域') + input('user_id_field','用户 ID 字段 *');
    else html = input('client_id','客户端 ID *') + input('client_secret','客户端密钥 *','password');
    this._el.querySelector('#login-param-fields').innerHTML = html;
    const cb = `${location.protocol}//${location.hostname}:25774/api/oauth_callback`;
    this._el.querySelector('#login-callback-url').textContent = cb;
  }

  _fillNotify(data) {
    this._notifyData = data || {};
    this._check('#notify-enabled', !!data.enabled);
    this._set('#notify-channel', data.default_channel || 'telegram');
    this._set('#notify-template', data.message_template || '{{emoji}}{{title}}{{emoji}}\nEvent: {{event}}\nClient: {{client}}\nMessage: {{message}}\nTime: {{time}}');
    this._renderNotifyChannelFields();
  }

  _renderNotifyChannelFields() {
    const channel = this._val('#notify-channel');
    const data = this._notifyData || {};
    const channels = data.channels || {};
    const cfg = channels[channel] || {};
    const e = esc;
    const field = (id, label, help='', value='', type='text') => `<label class="notify-field"><span>${label}</span>${help ? `<small>${help}</small>` : ''}<input id="${id}" class="form-input" type="${type}" value="${e(value)}"></label>`;
    const select = (id, label, options, value='', help='') => `<label class="notify-field notify-select-field"><span>${label}</span>${help ? `<small>${help}</small>` : ''}<select id="${id}" class="notify-select small"><option value="">选择</option>${options.map(o => `<option value="${e(o)}" ${String(value)===String(o)?'selected':''}>${e(o)}</option>`).join('')}</select></label>`;
    const toggle = (id, label, help='', checked=false) => `<label class="notify-toggle-row"><div><strong>${label}</strong>${help ? `<small>${help}</small>` : ''}</div><span class="komari-switch"><input id="${id}" type="checkbox" ${checked?'checked':''}><span></span></span></label>`;
    let html = '';
    if (channel === 'Server酱Turbo') {
      html = field('notify-sct-api-url','api_url *','接口完整地址，例如 https://sctapi.ftqq.com/<sendkey>.send；参考：https://sct.ftqq.com/', cfg.api_url || '') + field('notify-sct-channel','channel','消息通道，可选，多个用 | 隔开，例如 9|66', cfg.channel || '') + field('notify-sct-noip','noip','是否隐藏调用IP，填 1 隐藏；为空则不隐藏', cfg.noip || '') + field('notify-sct-openid','openid','抄送 openid，测试号用 , 分隔；企业微信应用用 | 分隔', cfg.openid || '');
    } else if (channel === 'webhook') {
      html = field('notify-webhook-url','url *','', cfg.url || '') + select('notify-webhook-method','method',['POST','GET'], cfg.method || '') + field('notify-webhook-content-type','content_type','', cfg.content_type || '') + field('notify-webhook-headers','headers','HTTP headers in JSON format', cfg.headers || '') + field('notify-webhook-body','body','', cfg.body || '') + field('notify-webhook-username','username','', cfg.username || '') + field('notify-webhook-password','password','', cfg.password || '', 'password');
    } else if (channel === 'empty') {
      html = '';
      this._el.querySelector('#notify-settings-card')?.classList.add('is-empty-channel');
    } else if (channel === 'email') {
      html = field('notify-email-smtp','SMTP 服务器 *','', cfg.smtp_server || '') + field('notify-email-port','端口 *','', cfg.port ?? 0, 'number') + field('notify-email-username','用户名','', cfg.username || '') + field('notify-email-password','密码','', cfg.password || '', 'password') + field('notify-email-from','发件人邮箱','', cfg.from || '') + field('notify-email-to','收件人邮箱','', cfg.to || '') + toggle('notify-email-ssl','启用 SSL','', !!cfg.ssl) + toggle('notify-email-login-auth','use_login_auth','Use LOGIN authentication method instead of PLAIN. Enable this if you encounter authentication errors with Microsoft (Outlook/Office365), NetEase (163.com), or other email providers', !!cfg.use_login_auth);
    } else if (channel === 'Server酱³') {
      html = field('notify-sc3-api-url','api_url *','接口完整地址，例如 https://<uid>.push.ft07.com/send/<sendkey>.send；参考：https://sc3.ft07.com/', cfg.api_url || '') + field('notify-sc3-tags','tags','可选标签，使用 | 分割，例如 tag1|tag2|tag3', cfg.tags || '');
    } else if (channel === 'bark') {
      html = field('notify-bark-server-url','server_url *','Bark server URL, e.g., https://api.day.app or your self-hosted server address', cfg.server_url || '') + field('notify-bark-device-key','device_key *','Your Bark device key, which can be found in the Bark App', cfg.device_key || '') + field('notify-bark-icon','icon','Push notification icon, supports URL or system icon name', cfg.icon || '') + select('notify-bark-level','level',['active','timeSensitive','passive','critical'], cfg.level || '', 'Push notification level: active, timeSensitive (default), passive, critical');
    } else if (channel === 'telegram') {
      html = field('notify-tg-token','Telegram Bot Token *','', cfg.bot_token || '', 'password') + field('notify-tg-chat','Chat ID *','-1001234567890 或 @channel', cfg.chat_id || data.telegram_chat_id || '') + field('notify-tg-thread','message_thread_id','supergroup topic optional', cfg.message_thread_id || '') + field('notify-tg-endpoint','请求端点 *','https://api.telegram.org/bot', cfg.endpoint || 'https://api.telegram.org/bot');
    } else if (channel === 'Javascript') {
      html = '<label class="notify-field"><span>JavaScript 代码 *</span><small>实现 sendEvent(event)，支持 fetch/xhr/console.log，返回 Promise 或 boolean。</small><textarea id="notify-js-code" class="form-input" rows="7">'+e(cfg.code || '')+'</textarea></label>';
    } else {
      html = field('notify-serverchan-api-url','api_url *','Server酱接口完整地址', cfg.api_url || cfg.target || '');
    }
    if (channel !== 'empty') this._el.querySelector('#notify-settings-card')?.classList.remove('is-empty-channel');
    this._el.querySelector('#notify-channel-fields').innerHTML = html;
  }

  _fillRuntime(summary) {
    const oauth = summary.oauth || {};
    const sec = summary.security || {};
    this._el.querySelector('#oauth-runtime').innerHTML = `<div><span>GitHub OAuth</span><b>${pill(!!oauth.github, '已配置', '未配置')}</b></div><div><span>Google OAuth</span><b>${pill(!!oauth.google, '已配置', '未配置')}</b></div><div><span>白名单邮箱数</span><b>${esc(oauth.allowlist_count ?? 0)}</b></div><div><span>回调地址</span><b>${esc(oauth.callback_url || '—')}</b></div><div><span>Cookie Secure</span><b>${pill(!!sec.jwt_cookie_secure, '开启', '关闭')}</b></div><div><span>CSRF 保护</span><b>${pill(!!sec.jwt_cookie_csrf_protect, '开启', '关闭')}</b></div>`;
  }

  async _saveSite() {
    try {
      await saveSiteSettings({ site_name: this._val('#site-name'), site_description: this._val('#site-description'), proxy_url: this._val('#site-proxy-url'), auto_share: this._val('#site-auto-share'), single_site_mode: this._isChecked('#site-single-mode'), custom_head: this._val('#site-custom-head'), custom_body: this._val('#site-custom-body') });
      this._msg('#site-msg', '✅ 站点设置已保存', 'ok');
    } catch (e) { this._msg('#site-msg', e.message || '保存失败', 'err'); }
  }

  async _saveGeneral() {
    try {
      await saveGeneralSettings({ auto_discovery_button: this._val('#general-auto-discovery'), geoip_enabled: this._isChecked('#general-geoip-enabled'), geoip_provider: this._val('#general-geoip-provider'), history_enabled: this._isChecked('#general-history-enabled'), retention_load_hours: Number(this._val('#general-load-hours') || 720), retention_ping_hours: Number(this._val('#general-ping-hours') || 24), nezha_grpc_enabled: this._isChecked('#general-grpc-enabled'), nezha_grpc_listen: this._val('#general-grpc-listen') });
      this._msg('#general-msg', '✅ 通用设置已保存', 'ok');
    } catch (e) { this._msg('#general-msg', e.message || '保存失败', 'err'); }
  }

  async _saveCloudflare() {
    try {
      const payload = { cloudflared_bin: this._val('#cf-bin') };
      const token = this._val('#cf-token').trim();
      if (token) payload.cloudflare_token = token;
      const res = await saveCloudflareSettings(payload);
      this._fillCloudflare(res);
      this._msg('#cf-msg', '✅ Cloudflare 设置已保存', 'ok');
    } catch (e) { this._msg('#cf-msg', e.message || '保存失败', 'err'); }
  }

  async _refreshCloudflare() {
    try {
      const res = await refreshCloudflareSettings();
      this._fillCloudflare(res);
      this._msg('#cf-msg', '✅ 状态已刷新', 'ok');
    } catch (e) { this._msg('#cf-msg', e.message || '刷新失败', 'err'); }
  }

  async _saveLogin() {
    try {
      const provider = this._val('#login-sso-provider') || 'CloudflareAccess';
      const providerCfg = {};
      this._el.querySelectorAll('#login-param-fields input').forEach((inp) => {
        providerCfg[inp.id.replace('login-sso-','')] = inp.value || '';
      });
      const ssoConfig = { ...(((this._loginData || {}).sso_config) || {}), [provider]: providerCfg };
      const apiInput = this._el.querySelector('#login-api-key');
      const apiKey = this._val('#login-api-key').trim();
      const maskedApiKey = apiInput?.dataset?.maskedValue || '';
      const payload = {
        disable_password_login: this._isChecked('#login-disable-password'),
        sso_enabled: this._isChecked('#login-sso-enabled'),
        github_client_id: this._val('#login-github-id'),
        allowed_emails: this._val('#login-allowed-emails'),
        sso_provider: provider,
        sso_config: ssoConfig,
        breakglass_enabled: this._val('#login-breakglass-enabled') !== '0',
      };
      if (apiKey && apiKey !== maskedApiKey) {
        payload.api_key = apiKey;
        payload.api_key_enabled = true;
      }
      const secret = this._val('#login-github-secret').trim();
      if (secret) payload.github_client_secret = secret;
      const res = await saveLoginSettings(payload);
      this._fillLogin(res);
      this._msg('#login-msg', '✅ 登录设置已保存', 'ok');
    } catch (e) { this._msg('#login-msg', e.message || '保存失败', 'err'); }
  }

  _generateApiKey() {
    const arr = new Uint8Array(24);
    crypto.getRandomValues(arr);
    const key = 'vps_' + Array.from(arr, b => b.toString(16).padStart(2,'0')).join('');
    this._set('#login-api-key', key);
  }

  async _saveNotify() {
    try {
      const channel = this._val('#notify-channel');
      const channels = { ...((this._notifyData || {}).channels || {}) };
      const q = (sel) => this._el.querySelector(sel);
      const val = (sel) => q(sel)?.value || '';
      const checked = (sel) => !!q(sel)?.checked;
      let cfg = {};
      if (channel === 'Server酱Turbo') cfg = { api_url: val('#notify-sct-api-url'), channel: val('#notify-sct-channel'), noip: val('#notify-sct-noip'), openid: val('#notify-sct-openid') };
      else if (channel === 'webhook') cfg = { url: val('#notify-webhook-url'), method: val('#notify-webhook-method'), content_type: val('#notify-webhook-content-type'), headers: val('#notify-webhook-headers'), body: val('#notify-webhook-body'), username: val('#notify-webhook-username'), password: val('#notify-webhook-password') };
      else if (channel === 'empty') cfg = {};
      else if (channel === 'email') cfg = { smtp_server: val('#notify-email-smtp'), port: Number(val('#notify-email-port') || 0), username: val('#notify-email-username'), password: val('#notify-email-password'), from: val('#notify-email-from'), to: val('#notify-email-to'), ssl: checked('#notify-email-ssl'), use_login_auth: checked('#notify-email-login-auth') };
      else if (channel === 'Server酱³') cfg = { api_url: val('#notify-sc3-api-url'), tags: val('#notify-sc3-tags') };
      else if (channel === 'bark') cfg = { server_url: val('#notify-bark-server-url'), device_key: val('#notify-bark-device-key'), icon: val('#notify-bark-icon'), level: val('#notify-bark-level') };
      else if (channel === 'telegram') cfg = { bot_token: val('#notify-tg-token'), chat_id: val('#notify-tg-chat'), message_thread_id: val('#notify-tg-thread'), endpoint: val('#notify-tg-endpoint') || 'https://api.telegram.org/bot' };
      else if (channel === 'Javascript') cfg = { code: val('#notify-js-code') };
      else cfg = { api_url: val('#notify-serverchan-api-url') };
      channels[channel] = cfg;
      this._notifyData = await saveNotificationSettings({ enabled: this._isChecked('#notify-enabled'), default_channel: channel, message_template: this._val('#notify-template') || '{{emoji}}{{title}}{{emoji}}\nEvent: {{event}}\nClient: {{client}}\nMessage: {{message}}\nTime: {{time}}', channels, telegram_chat_id: cfg.chat_id || '' });
      this._msg('#notify-msg', '✅ 通知设置已保存', 'ok');
    } catch (e) { this._msg('#notify-msg', e.message || '保存失败', 'err'); }
  }

  async _testNotify() {
    try {
      this._msg('#notify-msg', '发送中...', '');
      const res = await testNotificationSettings();
      this._msg('#notify-msg', `✅ ${res.msg || '测试通知已发送'}`, 'ok');
    } catch (e) { this._msg('#notify-msg', e.message || '测试发送失败', 'err'); }
  }


  async _downloadBackup() {
    const btn = this._el.querySelector('#site-backup-download');
    try {
      if (btn) btn.disabled = true;
      this._msg('#site-msg', '正在生成备份...', '');
      const resp = await fetch(downloadSiteBackupUrl(), {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/zip' },
      });
      if (!resp.ok) {
        let detail = '';
        try {
          const json = await resp.json();
          detail = json.msg || json.error || json.message || '';
        } catch (_) {}
        throw new Error(detail || `下载失败 HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      if (!blob || blob.size < 64) throw new Error('下载失败：备份文件为空');
      const disposition = resp.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i);
      const filename = decodeURIComponent(match?.[1] || match?.[2] || `vps-dashboard-site-backup-${Date.now()}.zip`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      this._msg('#site-msg', `✅ 已下载备份：${filename}`, 'ok');
    } catch (e) {
      this._msg('#site-msg', e.message || '下载备份失败', 'err');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async _restoreBackup(ev) {
    const input = ev?.currentTarget || this._el.querySelector('#site-backup-file');
    const file = input?.files?.[0];
    if (!file) return;
    try {
      this._msg('#site-msg', '正在恢复备份...', '');
      const res = await restoreSiteBackup(file);
      if (res?.site) this._fillSite(res.site);
      this._msg('#site-msg', `✅ ${res?.msg || '备份已恢复'}${Array.isArray(res?.restored) ? `：${res.restored.join(', ')}` : ''}`, 'ok');
    } catch (e) {
      this._msg('#site-msg', e.message || '恢复备份失败', 'err');
    } finally {
      if (input) input.value = '';
    }
  }

  _val(sel) { return this._el.querySelector(sel).value; }
  _set(sel, v) { this._el.querySelector(sel).value = v; }
  _check(sel, v) { this._el.querySelector(sel).checked = v; }
  _isChecked(sel) { return !!this._el.querySelector(sel).checked; }
  _msg(sel, text, kind) { const el = this._el.querySelector(sel); el.textContent = text; el.className = `komari-msg ${kind}`; }
}

function pill(ok, yes, no) { return `<span class="acct-pill ${ok ? 'ok' : 'warn'}">${esc(ok ? yes : no)}</span>`; }
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch])); }
