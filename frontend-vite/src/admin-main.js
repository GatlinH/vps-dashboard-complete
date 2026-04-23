/**
 * src/admin-main.js
 * 管理后台主入口：组装 LoginPanel、ServerManager、PingTool、TelegramPanel、ThemeEditor
 */

import './styles/main.css';
import './styles/admin.css';

import { getToken }       from './api/base.js';
import { logout }         from './api/auth.js';
import { LoginPanel }     from './components/admin/LoginPanel.js';
import { ServerManager }  from './components/admin/ServerManager.js';
import { PingTool }       from './components/admin/PingTool.js';
import { TelegramPanel }  from './components/admin/TelegramPanel.js';
import { ThemeEditor }    from './components/admin/ThemeEditor.js';
import { AgentPanel }     from './components/admin/AgentPanel.js';

// ── 全局 401 事件 → 强制回到登录页 ──────────────────────────────────────────
window.addEventListener('admin:logout', () => {
  showLogin();
});

// ── 组件实例 ─────────────────────────────────────────────────────────────────
let _loginPanel;
let _serverMgr;
let _pingTool;
let _tgPanel;
let _themeEditor;
let _agentPanel;
let _activeTab = 'servers';

// ── 初始化 ───────────────────────────────────────────────────────────────────

function boot() {
  // 应用已保存主题
  const themeIdx = parseInt(localStorage.getItem('vps_theme_idx') || '0');
  if (themeIdx > 0) {
    // 仅在 ThemeEditor 中完整处理；此处只做变量预注入
    const THEME_VARS = [
      {}, // 0 = 默认，不需要额外注入
      { '--bg':'#0e0714','--bg2':'#160e22','--bg3':'#1e1230','--accent':'#c084fc','--gold':'#fbbf24','--green':'#34d399','--text':'#e2e8f0' },
      { '--bg':'#0a0a0a','--bg2':'#111111','--bg3':'#1a1a1a','--accent':'#ffffff','--gold':'#d4af37','--green':'#6ee7b7','--text':'#f0f0f0' },
      { '--bg':'#0d0221','--bg2':'#14032e','--bg3':'#1c0440','--accent':'#00fff9','--gold':'#ffee00','--green':'#39ff14','--text':'#e0e0ff' },
      { '--bg':'#0d0c0b','--bg2':'#161412','--bg3':'#1e1b18','--accent':'#f97316','--gold':'#eab308','--green':'#86efac','--text':'#e7e5e4' },
      { '--bg':'#050e08','--bg2':'#0a1a10','--bg3':'#0f2418','--accent':'#4ade80','--gold':'#fde047','--green':'#86efac','--text':'#dcfce7' },
    ];
    const vars = THEME_VARS[themeIdx];
    if (vars) Object.entries(vars).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
  }
  const savedCSS = localStorage.getItem('vps_custom_css');
  if (savedCSS) {
    const tag = document.createElement('style'); tag.id = 'custom-css-inject';
    tag.textContent = savedCSS; document.head.appendChild(tag);
  }

  // 登录面板
  _loginPanel = new LoginPanel('login-mount', { onSuccess: showAdminPanel });

  // 已有 token → 直接进后台
  if (getToken()) {
    showAdminPanel();
  }
}

// ── 显示登录 ──────────────────────────────────────────────────────────────────

function showLogin() {
  document.getElementById('login-mount').style.display = '';
  document.getElementById('admin-panel').style.display = 'none';
}

// ── 显示后台面板 ──────────────────────────────────────────────────────────────

async function showAdminPanel() {
  document.getElementById('login-mount').style.display  = 'none';
  document.getElementById('admin-panel').style.display  = 'flex';

  // 懒初始化各组件（只初始化一次）
  if (!_serverMgr) {
    _serverMgr   = new ServerManager('tab-servers');
    _pingTool    = new PingTool('tab-ping');
    _tgPanel     = new TelegramPanel('tab-telegram');
    _themeEditor = new ThemeEditor('tab-theme');
    _agentPanel  = new AgentPanel('tab-agent');
  }

  // 加载数据
  await _serverMgr.reload();
  _pingTool.setServers(_serverMgr.servers);
  await _tgPanel.load();
  await _agentPanel.load();

  switchTab(_activeTab);
}

// ── Tab 切换 ─────────────────────────────────────────────────────────────────

function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.admin-page').forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-tab="${tab}"]`)?.classList.add('active');
  document.getElementById(`tab-${tab}`)?.classList.add('active');
  // Ping tab 需要最新服务器列表
  if (tab === 'ping' && _serverMgr) _pingTool.setServers(_serverMgr.servers);
}

// ── 登出 ─────────────────────────────────────────────────────────────────────

function adminLogout() {
  logout();
  showLogin();
}

// ── 暴露给 HTML 的全局函数 ────────────────────────────────────────────────────
window.switchTab    = switchTab;
window.adminLogout  = adminLogout;

boot();
