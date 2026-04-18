/**
 * components/admin/ThemeEditor.js
 * 界面主题编辑器：预设主题切换、CSS 变量调色盘、自定义 CSS 注入
 */

const THEMES = [
  { name: '深空蓝（默认）', swatches: ['#070b14','#63b3ed','#f6c90e','#38ef7d'],
    vars: { '--bg':'#070b14','--bg2':'#0d1525','--bg3':'#111d33','--accent':'#63b3ed','--gold':'#f6c90e','--green':'#38ef7d','--purple':'#a78bfa','--text':'#e2e8f0' } },
  { name: '暗夜紫晶', swatches: ['#0e0714','#c084fc','#fbbf24','#34d399'],
    vars: { '--bg':'#0e0714','--bg2':'#160e22','--bg3':'#1e1230','--accent':'#c084fc','--gold':'#fbbf24','--green':'#34d399','--purple':'#818cf8','--text':'#e2e8f0' } },
  { name: '极简黑白', swatches: ['#0a0a0a','#ffffff','#d4af37','#6ee7b7'],
    vars: { '--bg':'#0a0a0a','--bg2':'#111111','--bg3':'#1a1a1a','--accent':'#ffffff','--gold':'#d4af37','--green':'#6ee7b7','--purple':'#a0a0a0','--text':'#f0f0f0' } },
  { name: '赛博朋克', swatches: ['#0d0221','#00fff9','#ffee00','#ff00ff'],
    vars: { '--bg':'#0d0221','--bg2':'#14032e','--bg3':'#1c0440','--accent':'#00fff9','--gold':'#ffee00','--green':'#39ff14','--purple':'#ff00ff','--text':'#e0e0ff' } },
  { name: '碳黑橙', swatches: ['#0d0c0b','#f97316','#eab308','#86efac'],
    vars: { '--bg':'#0d0c0b','--bg2':'#161412','--bg3':'#1e1b18','--accent':'#f97316','--gold':'#eab308','--green':'#86efac','--purple':'#c4b5fd','--text':'#e7e5e4' } },
  { name: '深林绿', swatches: ['#050e08','#4ade80','#fde047','#a3e635'],
    vars: { '--bg':'#050e08','--bg2':'#0a1a10','--bg3':'#0f2418','--accent':'#4ade80','--gold':'#fde047','--green':'#86efac','--purple':'#a3e635','--text':'#dcfce7' } },
];

const COLOR_VARS = [
  { key: '--bg',      label: '背景色' },
  { key: '--bg2',     label: '面板背景' },
  { key: '--bg3',     label: '输入框背景' },
  { key: '--accent',  label: '主强调色' },
  { key: '--gold',    label: '金色（价格/价值）' },
  { key: '--green',   label: '绿色（在线/健康）' },
  { key: '--red',     label: '红色（离线/危险）' },
  { key: '--purple',  label: '紫色（装饰）' },
  { key: '--text',    label: '主文本色' },
  { key: '--text2',   label: '次文本色' },
];

export class ThemeEditor {
  constructor(mountId) {
    this._el         = document.getElementById(mountId);
    this._activeIdx  = parseInt(localStorage.getItem('vps_theme_idx') || '0');
    this._render();
    this._bind();
    this._loadSavedCSS();
  }

  // ── 骨架渲染 ─────────────────────────────────────────────────────────────

  _render() {
    this._el.innerHTML = /* html */`
      <div class="admin-section-title">前端界面主题</div>

      <div class="admin-card">
        <div class="admin-card-title">🎨 预设主题</div>
        <div class="theme-grid" id="te-presets"></div>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">🖌 颜色变量调节</div>
        <div class="var-sliders" id="te-sliders"></div>
        <button class="add-btn" style="margin-top:14px" id="te-apply-colors">应用颜色</button>
      </div>

      <div class="admin-card">
        <div class="admin-card-title">💻 自定义 CSS 注入</div>
        <div style="font-size:12px;color:var(--text3);margin-bottom:10px">
          直接编写 CSS 代码，实时注入到前台页面。支持覆盖任意样式变量和类。
        </div>
        <textarea class="css-editor" id="te-css" placeholder=":root {
  --accent: #ff6b6b;
  --bg: #0a0a0f;
}

.server-card {
  border-radius: 20px;
}"></textarea>
        <div style="display:flex;gap:10px;margin-top:10px">
          <button class="add-btn" id="te-preview">▶ 实时预览</button>
          <button id="te-save-css" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border2);color:var(--accent);cursor:pointer;font-size:13px">💾 保存</button>
          <button id="te-reset-css" style="padding:8px 18px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);color:var(--text3);cursor:pointer;font-size:13px">重置</button>
        </div>
        <div id="te-css-msg" style="margin-top:8px;font-size:12px;min-height:18px"></div>
      </div>`;

    this._renderPresets();
    this._renderSliders();
  }

  // ── 预设主题 ─────────────────────────────────────────────────────────────

  _renderPresets() {
    this._el.querySelector('#te-presets').innerHTML = THEMES.map((t, i) => /* html */`
      <div class="theme-preset ${i === this._activeIdx ? 'active' : ''}" data-theme-idx="${i}">
        <div class="theme-swatch">
          ${t.swatches.map(c => `<div class="swatch" style="background:${c}"></div>`).join('')}
        </div>
        <div class="theme-name">${t.name}</div>
      </div>`).join('');
  }

  _applyTheme(idx) {
    this._activeIdx = idx;
    localStorage.setItem('vps_theme_idx', idx);
    Object.entries(THEMES[idx].vars).forEach(([k, v]) =>
      document.documentElement.style.setProperty(k, v));
    this._renderPresets();
    this._renderSliders();
  }

  // ── 颜色滑块 ─────────────────────────────────────────────────────────────

  _renderSliders() {
    this._el.querySelector('#te-sliders').innerHTML = COLOR_VARS.map(({ key, label }) => {
      const cur = getComputedStyle(document.documentElement).getPropertyValue(key).trim() || '#000000';
      const hex = cur.startsWith('#') ? cur : this._rgbToHex(cur);
      return /* html */`
        <div class="var-row">
          <label>
            <span>${label}</span>
            <code style="font-size:10px;color:var(--text3)">${key}</code>
          </label>
          <input type="color" value="${hex}" data-css-var="${key}">
        </div>`;
    }).join('');
  }

  _applyColors() {
    this._el.querySelectorAll('#te-sliders input[type=color]').forEach(inp =>
      document.documentElement.style.setProperty(inp.dataset.cssVar, inp.value));
  }

  // ── 自定义 CSS ────────────────────────────────────────────────────────────

  _loadSavedCSS() {
    const saved = localStorage.getItem('vps_custom_css') || '';
    this._el.querySelector('#te-css').value = saved;
    if (saved) this._injectCSS(saved);
  }

  _injectCSS(css) {
    let tag = document.getElementById('custom-css-inject');
    if (!tag) { tag = document.createElement('style'); tag.id = 'custom-css-inject'; document.head.appendChild(tag); }
    tag.textContent = css;
  }

  // ── 事件绑定 ─────────────────────────────────────────────────────────────

  _bind() {
    // 预设主题委托
    this._el.querySelector('#te-presets').addEventListener('click', e => {
      const card = e.target.closest('[data-theme-idx]');
      if (card) this._applyTheme(Number(card.dataset.themeIdx));
    });

    // 颜色实时预览
    this._el.querySelector('#te-sliders').addEventListener('input', e => {
      if (e.target.dataset.cssVar)
        document.documentElement.style.setProperty(e.target.dataset.cssVar, e.target.value);
    });

    this._el.querySelector('#te-apply-colors').addEventListener('click', () => this._applyColors());

    this._el.querySelector('#te-preview').addEventListener('click', () => {
      const css = this._el.querySelector('#te-css').value;
      this._injectCSS(css);
      this._msg('✅ CSS 已实时注入', 'green');
    });

    this._el.querySelector('#te-save-css').addEventListener('click', () => {
      const css = this._el.querySelector('#te-css').value;
      localStorage.setItem('vps_custom_css', css);
      this._injectCSS(css);
      this._msg('✅ 已保存并应用', 'green');
    });

    this._el.querySelector('#te-reset-css').addEventListener('click', () => {
      this._el.querySelector('#te-css').value = '';
      localStorage.removeItem('vps_custom_css');
      const tag = document.getElementById('custom-css-inject');
      if (tag) tag.remove();
      this._msg('已重置为默认样式', 'blue');
    });
  }

  // ── 工具 ─────────────────────────────────────────────────────────────────

  _msg(text, type) {
    const el = this._el.querySelector('#te-css-msg');
    const colors = { green: 'var(--green)', red: 'var(--red)', blue: 'var(--accent)' };
    el.style.color = colors[type] || 'var(--text2)';
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3500);
  }

  _rgbToHex(rgb) {
    const m = rgb.match(/\d+/g);
    if (!m || m.length < 3) return '#000000';
    return '#' + m.slice(0, 3).map(x => parseInt(x).toString(16).padStart(2, '0')).join('');
  }
}
