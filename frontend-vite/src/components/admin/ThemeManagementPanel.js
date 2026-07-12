import { getSiteSettings, saveSiteSettings } from '../../api/admin.js';

export class ThemeManagementPanel {
  constructor(mountId) {
    this._el = document.getElementById(mountId);
    this._data = {};
    this._render();
    this._bind();
  }

  _render() {
    this._el.innerHTML = `<div class="komari-theme-page">
      <div class="komari-page-head theme-head"><div><h2>站点外观</h2><p class="theme-head-note">管理站点图片、纹理、页脚与展示宽度；支持站内路径（如 /assets/custom/logo.png）或 https 外链；图片路径保存后由对应页面按需读取。</p></div></div>
      <section class="komari-panel theme-management-panel">
        <h3 class="theme-section-title">展示设置</h3>
        <div class="theme-setting-row"><div><strong>在网站中显示IP标签</strong><small>启用后在服务器列表中显示 IPv4 / IPv6 标签；需在设置中启用相关 IP 地址检测功能。</small></div><label class="komari-switch"><input id="theme-show-ip-labels" type="checkbox"><span></span></label></div>
        <div class="theme-setting-row"><div><strong>在详情页显示服务器列表</strong><small>启用后在服务器详情页面显示服务器列表，方便用户返回首页或切换到其他服务器。</small></div><label class="komari-switch"><input id="theme-detail-server-list" type="checkbox"><span></span></label></div>
        <div class="theme-field-block"><strong>背景图片路径/URL（桌面端）</strong><small>设置桌面端首页的自定义背景图片。</small><input id="theme-desktop-bg" class="form-input theme-image-url" data-preview="theme-desktop-bg-preview" type="text" placeholder="/assets/custom/login-background.png or https://example.com/background.jpg"><div class="theme-url-preview" id="theme-desktop-bg-preview">未设置</div></div>
        <div class="theme-field-block"><strong>背景图片路径/URL（移动端）</strong><small>设置移动端首页的自定义背景图片。留空时使用桌面端背景。</small><input id="theme-mobile-bg" class="form-input theme-image-url" data-preview="theme-mobile-bg-preview" type="text" placeholder="/assets/custom/mobile-background.png or https://example.com/mobile-background.jpg"><div class="theme-url-preview" id="theme-mobile-bg-preview">未设置</div></div>
        <h3 class="theme-section-title">图片位置自定义</h3>
        <div class="theme-image-grid">
          <div class="theme-field-block"><strong>登录页背景图片路径/URL</strong><small>覆盖后台/前台登录场景背景。</small><input id="theme-login-bg" class="form-input theme-image-url" data-preview="theme-login-bg-preview" type="text" placeholder="/assets/custom/login-background.png or https://example.com/login-bg.jpg"><div class="theme-url-preview" id="theme-login-bg-preview">未设置</div></div>
          <div class="theme-field-block"><strong>星空/星云背景图片路径/URL</strong><small>覆盖星图/后台空间底图。</small><input id="theme-starmap-bg" class="form-input theme-image-url" data-preview="theme-starmap-bg-preview" type="text" placeholder="/assets/custom/starmap-bg.jpg or https://example.com/starmap-bg.jpg"><div class="theme-url-preview" id="theme-starmap-bg-preview">未设置</div></div>
          <div class="theme-field-block"><strong>Logo / 站点标识图片路径/URL</strong><small>覆盖侧栏、登录与站点品牌图。</small><input id="theme-logo-image" class="form-input theme-image-url" data-preview="theme-logo-image-preview" type="text" placeholder="/assets/custom/login-logo-transparent.png or https://example.com/logo.png"><div class="theme-url-preview" id="theme-logo-image-preview">未设置</div></div>
          <div class="theme-field-block"><strong>Favicon 图标路径/URL</strong><small>覆盖浏览器标签页与快捷图标。</small><input id="theme-favicon-image" class="form-input theme-image-url" data-preview="theme-favicon-image-preview" type="text" placeholder="/assets/custom/favicon.png or https://example.com/favicon.png"><div class="theme-url-preview" id="theme-favicon-image-preview">未设置</div></div>
          <div class="theme-field-block"><strong>地球纹理图片路径/URL</strong><small>可选：覆盖地球底图纹理（留空使用默认真实影像）。</small><input id="theme-earth-texture" class="form-input theme-image-url" data-preview="theme-earth-texture-preview" type="text" placeholder="/assets/custom/earth.jpg or https://example.com/earth.jpg"><div class="theme-url-preview" id="theme-earth-texture-preview">未设置</div></div>
          <div class="theme-field-block"><strong>云层纹理图片路径/URL</strong><small>可选：覆盖地球云层纹理。</small><input id="theme-cloud-texture" class="form-input theme-image-url" data-preview="theme-cloud-texture-preview" type="text" placeholder="/assets/custom/clouds.png or https://example.com/clouds.png"><div class="theme-url-preview" id="theme-cloud-texture-preview">未设置</div></div>
          <div class="theme-field-block"><strong>飞船/装饰模型图片路径/URL</strong><small>覆盖首页飞船、装饰或插画图位。</small><input id="theme-hero-image" class="form-input theme-image-url" data-preview="theme-hero-image-preview" type="text" placeholder="/assets/custom/overview-visual-transparent.png or https://example.com/hero.png"><div class="theme-url-preview" id="theme-hero-image-preview">未设置</div></div>
          <div class="theme-field-block"><strong>默认节点图标路径/URL</strong><small>覆盖 VPS 节点 marker / 默认图标。</small><input id="theme-node-icon" class="form-input theme-image-url" data-preview="theme-node-icon-preview" type="text" placeholder="/assets/custom/node-icon.png or https://example.com/node-icon.png"><div class="theme-url-preview" id="theme-node-icon-preview">未设置</div></div>
        </div>
        <div class="theme-setting-row"><div><strong>商城节点位置</strong><small>最前：商城节点显示在前面；保持：按权重排序，不区分在线/离线；最后：商城节点显示在最后。</small></div><select id="theme-marketplace-pos" class="form-input theme-select"><option value="first">最前的</option><option value="keep">保持</option><option value="last">最后的</option></select></div>
        <div class="theme-field-block"><strong>自定义页脚HTML</strong><small>设置自定义页脚 HTML 内容，以替换网站页脚和授权信息。</small><textarea id="theme-footer-html" class="form-input" rows="7"></textarea></div>
        <div class="theme-field-block"><strong>主要内容宽度</strong><small>调整主要内容最大宽度，单位为视口宽度百分比 VW；设置为 100 表示占满宽度。</small><input id="theme-main-width" class="form-input" type="number" min="40" max="100" step="1" value="100"></div>
        <div class="theme-action-row"><button class="komari-primary" id="theme-save-bottom" type="button">保存</button><span id="theme-msg" class="komari-msg"></span></div>
      </section>
    </div>`;
  }

  _bind() {
    this._el.querySelector('#theme-save-bottom').addEventListener('click', () => this.save());
    this._el.addEventListener('input', (e) => { if (e.target?.classList?.contains('theme-image-url')) this._updatePreview(e.target); });
  }

  async load() {
    try {
      const data = await getSiteSettings();
      this._data = data || {};
      this._check('#theme-show-ip-labels', data.show_ip_labels !== false);
      this._check('#theme-detail-server-list', data.show_detail_server_list !== false);
      this._set('#theme-desktop-bg', data.desktop_background_url || '');
      this._set('#theme-mobile-bg', data.mobile_background_url || '');
      const images = data.custom_images || {};
      this._set('#theme-login-bg', images.login_background_url || data.login_background_url || '');
      this._set('#theme-starmap-bg', images.starmap_background_url || data.starmap_background_url || '');
      this._set('#theme-logo-image', images.logo_image_url || data.logo_image_url || '');
      this._set('#theme-favicon-image', images.favicon_image_url || data.favicon_image_url || '');
      this._set('#theme-earth-texture', images.earth_texture_url || data.earth_texture_url || '');
      this._set('#theme-cloud-texture', images.cloud_texture_url || data.cloud_texture_url || '');
      this._set('#theme-hero-image', images.hero_image_url || data.hero_image_url || '');
      this._set('#theme-node-icon', images.node_icon_url || data.node_icon_url || '');
      this._refreshPreviews();
      this._set('#theme-marketplace-pos', data.marketplace_node_position || 'last');
      this._set('#theme-footer-html', data.custom_footer_html || '');
      this._set('#theme-main-width', data.main_content_width ?? 100);
    } catch (e) {
      this._msg(e.message || '主题设置加载失败', 'err');
    }
  }

  async save() {
    try {
      const payload = {
        ...this._data,
        show_ip_labels: this._isChecked('#theme-show-ip-labels'),
        show_detail_server_list: this._isChecked('#theme-detail-server-list'),
        desktop_background_url: this._val('#theme-desktop-bg').trim(),
        mobile_background_url: this._val('#theme-mobile-bg').trim(),
        custom_images: {
          ...(this._data.custom_images || {}),
          login_background_url: this._val('#theme-login-bg').trim(),
          starmap_background_url: this._val('#theme-starmap-bg').trim(),
          logo_image_url: this._val('#theme-logo-image').trim(),
          favicon_image_url: this._val('#theme-favicon-image').trim(),
          earth_texture_url: this._val('#theme-earth-texture').trim(),
          cloud_texture_url: this._val('#theme-cloud-texture').trim(),
          hero_image_url: this._val('#theme-hero-image').trim(),
          node_icon_url: this._val('#theme-node-icon').trim(),
        },
        login_background_url: this._val('#theme-login-bg').trim(),
        starmap_background_url: this._val('#theme-starmap-bg').trim(),
        logo_image_url: this._val('#theme-logo-image').trim(),
        favicon_image_url: this._val('#theme-favicon-image').trim(),
        earth_texture_url: this._val('#theme-earth-texture').trim(),
        cloud_texture_url: this._val('#theme-cloud-texture').trim(),
        hero_image_url: this._val('#theme-hero-image').trim(),
        node_icon_url: this._val('#theme-node-icon').trim(),
        marketplace_node_position: this._val('#theme-marketplace-pos') || 'last',
        custom_footer_html: this._val('#theme-footer-html'),
        main_content_width: Number(this._val('#theme-main-width') || 100),
      };
      const saved = await saveSiteSettings(payload);
      this._data = saved || payload;
      this._msg('✅ 主题设置已保存', 'ok');
    } catch (e) {
      this._msg(e.message || '保存失败', 'err');
    }
  }

  _val(sel) { return this._el.querySelector(sel).value; }
  _set(sel, v) { const el = this._el.querySelector(sel); if (el) el.value = v; }
  _updatePreview(input) { const target = input?.dataset?.preview ? this._el.querySelector(`#${input.dataset.preview}`) : null; if (target) target.textContent = input.value.trim() || '未设置'; }
  _refreshPreviews() { this._el.querySelectorAll('.theme-image-url').forEach((input) => this._updatePreview(input)); }
  _check(sel, v) { this._el.querySelector(sel).checked = !!v; }
  _isChecked(sel) { return !!this._el.querySelector(sel).checked; }
  _msg(text, kind='') { const el=this._el.querySelector('#theme-msg'); if(el){ el.textContent=text; el.className=`komari-msg ${kind}`; } }
}
