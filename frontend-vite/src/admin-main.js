/**
 * src/admin-main.js 
 * 适配美化版 admin.html 的后台逻辑
 */

import './styles/admin.css'; // 确保引入样式
import './styles/hermes_admin_polish_20260706.css';
import './styles/hermes_admin_ui_hardening_20260706.css';
import './styles/hermes_admin_ops_diagnostics_20260706.css';
import './styles/hermes_admin_spacing_sessions_20260706.css';
import './styles/hermes_admin_verified_fixes_20260706.css';
import './styles/hermes_admin_table_sticky_actions_20260706.css';
import './styles/hermes_admin_session_audit_20260706.css';
import './styles/hermes_admin_ui_audit_fixes_20260706.css';
import './styles/hermes_admin_ui_audit_final_20260706.css';
import './styles/hermes_admin_user_reported_fixes_20260706.css';
import './styles/hermes_admin_node_table_complete_20260706.css';
import './styles/hermes_admin_node_table_readability_20260706.css';
import './styles/hermes_admin_node_table_clean_select_20260706.css';
import './styles/hermes_admin_node_checkbox_square_20260706.css';
import './styles/hermes_admin_ops_filter_spacing_20260706.css';
import './styles/hermes_admin_settings_ops_functional_20260706.css';
import './styles/hermes_admin_site_settings_redesign_20260707.css';
import './styles/hermes_admin_site_settings_layout_fix_20260707.css';
import './styles/hermes_admin_notify_management_bottom_20260707.css';
import './styles/hermes_admin_proxy_redesign_20260707.css';
import './styles/hermes_admin_proxy_spacing_fix_20260707.css';
import './styles/hermes_admin_proxy_lift_20260707.css';
import './styles/hermes_admin_theme_followups_20260707.css';
import { applyAdminTextLanguage, initAdminTextI18nObserver } from './admin-i18n-runtime.js';
import { logout, checkSession } from './api/auth.js';
import { ServerManager } from './components/admin/ServerManager.js';
import { PingTool } from './components/admin/PingTool.js';
import { TelegramPanel } from './components/admin/TelegramPanel.js';
import { LoginPanel } from './components/admin/LoginPanel.js';
import { OpsPanel } from './components/admin/OpsPanel.js';
import { AccountPanel } from './components/admin/AccountPanel.js';
import { UserAdminPanel } from './components/admin/UserAdminPanel.js';
import { SettingsPanel } from './components/admin/SettingsPanel.js';
import { ThemeManagementPanel } from './components/admin/ThemeManagementPanel.js';

// 全局实例引用
let _serverMgr, _pingTool, _tgPanel, _opsPanel, _accountPanel, _userAdminPanel, _settingsPanel, _themePanel;

const ADMIN_THEMES = {
  bridge: {'--bg-base':'#050814','--bg-panel':'rgba(9,18,34,.84)','--primary':'#ffb454','--primary-hover':'#ffd27a','--text-main':'#edf6ff','--text-muted':'#8ea9c8','--border':'rgba(102,217,255,.18)','--red':'#ff5f7e','--green':'#5df2b6'},
  'komari-light': {'--bg-base':'#f7f8fb','--bg-panel':'#ffffff','--primary':'#6366f1','--primary-hover':'#4f46e5','--text-main':'#111827','--text-muted':'#64748b','--border':'#e5e7eb','--red':'#ef4444','--green':'#16a34a'},
  'ops-dark': {'--bg-base':'#0f172a','--bg-panel':'#111827','--primary':'#38bdf8','--primary-hover':'#7dd3fc','--text-main':'#f8fafc','--text-muted':'#94a3b8','--border':'#334155','--red':'#fb7185','--green':'#22c55e'},
  ice: {'--bg-base':'#edf4fb','--bg-panel':'#ffffff','--primary':'#3b82f6','--primary-hover':'#2563eb','--text-main':'#102033','--text-muted':'#64748b','--border':'#dbe7f3','--red':'#ef4444','--green':'#0f766e'},
};
function applySavedAdminTheme() {
  const key = localStorage.getItem('vps_default_theme') || 'bridge';
  const vars = ADMIN_THEMES[key] || ADMIN_THEMES['komari-light'];
  Object.entries(vars).forEach(([k,v]) => document.documentElement.style.setProperty(k,v));
  const css = localStorage.getItem('vps_custom_css') || '';
  if (css) {
    let tag = document.getElementById('custom-css-inject');
    if (!tag) { tag = document.createElement('style'); tag.id = 'custom-css-inject'; document.head.appendChild(tag); }
    tag.textContent = css;
  }
}

let _activeTab = 'servers';

/**
 * 核心：标签页切换逻辑
 * 适配了 .admin-tab 和 .admin-page 的新 CSS 结构
 */
function switchTab(tab, section = null) {
  _activeTab = tab;

  // 1. 切换导航按钮高亮
  document.querySelectorAll('.admin-tab').forEach(t => {
    const sameTab = t.dataset.tab === tab;
    t.classList.toggle('active', sameTab);
  });
  document.querySelectorAll('.admin-subtab').forEach(t => {
    t.classList.toggle('active', tab === 'settings' && (!section || t.dataset.settingsSection === section));
  });

  // 2. 切换页面内容显示（带淡入动画）
  document.querySelectorAll('.admin-page').forEach(p => {
    p.classList.remove('active');
  });
  const targetPage = document.getElementById(`tab-${tab}`);
  if (targetPage) {
    targetPage.classList.add('active');
    // 切换后自动滚动到页面顶部，体验更佳
    document.querySelector('.admin-body').scrollTo({ top: 0, behavior: 'smooth' });
  }

  // 3. 特殊逻辑：如果是 Ping 页面，刷新服务器列表
  if (tab === 'servers' && _serverMgr) { _serverMgr.reload(); }
  if (tab === 'network' && _pingTool && _serverMgr) { _pingTool.setServers(_serverMgr.servers); }
  if (tab === 'alerts' && _tgPanel) { _tgPanel.load(); }
  if (tab === 'account' && _accountPanel) { _accountPanel.load(); }
  if (tab === 'users' && _userAdminPanel) { _userAdminPanel.load(); }
  if (tab === 'settings' && _settingsPanel) { if (section) _settingsPanel.setSection(section); _settingsPanel.load(); }
  if (tab === 'ops' && _opsPanel) { _opsPanel.load(); }
  if (tab === 'theme' && _themePanel) { _themePanel.load(); }
}


const ADMIN_I18N = {
  zh:{help:'帮助',bridge:'舰桥',day:'日间',return_starmap:'返回星图',logout:'退出登录',servers:'服务器',settings:'设置',site:'站点',login:'登录',notify:'通知',general:'通用',proxy:'反向代理',alert_rules:'通知规则',latency_monitor:'延迟监测',sessions:'登录会话',account:'账户',logs:'日志',theme_management:'站点外观'},
  en:{help:'Help',bridge:'Bridge',day:'Day',return_starmap:'Return to Starmap',logout:'Logout',servers:'Servers',settings:'Settings',site:'Site',login:'Login',notify:'Notifications',general:'General',proxy:'Reverse Proxy',alert_rules:'Notification Rules',latency_monitor:'Latency Monitor',sessions:'Sessions',account:'Account',logs:'Logs',theme_management:'Default Theme'},
  ja:{help:'ヘルプ',bridge:'ブリッジ',day:'昼間',return_starmap:'星図へ戻る',logout:'ログアウト',servers:'サーバー',settings:'設定',site:'サイト',login:'ログイン',notify:'通知',general:'一般',proxy:'リバースプロキシ',alert_rules:'通知ルール',latency_monitor:'遅延監視',sessions:'セッション',account:'アカウント',logs:'ログ',theme_management:'デフォルトテーマ'},
  ko:{help:'도움말',bridge:'브리지',day:'주간',return_starmap:'별 지도 반환',logout:'로그아웃',servers:'서버',settings:'설정',site:'사이트',login:'로그인',notify:'알림',general:'일반',proxy:'리버스 프록시',alert_rules:'알림 규칙',latency_monitor:'지연 모니터',sessions:'세션',account:'계정',logs:'로그',theme_management:'기본 테마'},
  fr:{help:'Aide',bridge:'Passerelle',day:'Jour',return_starmap:'Retour à la carte',logout:'Déconnexion',servers:'Serveurs',settings:'Paramètres',site:'Site',login:'Connexion',notify:'Notifications',general:'Général',proxy:'Proxy inverse',alert_rules:'Règles de notification',latency_monitor:'Latence',sessions:'Sessions',account:'Compte',logs:'Journaux',theme_management:'Thème par défaut'},
  de:{help:'Hilfe',bridge:'Brücke',day:'Tag',return_starmap:'Zur Sternkarte',logout:'Abmelden',servers:'Server',settings:'Einstellungen',site:'Site',login:'Login',notify:'Benachrichtigungen',general:'Allgemein',proxy:'Reverse Proxy',alert_rules:'Benachrichtigungsregeln',latency_monitor:'Latenzmonitor',sessions:'Sitzungen',account:'Konto',logs:'Logs',theme_management:'Default Theme'},
  es:{help:'Ayuda',bridge:'Puente',day:'Día',return_starmap:'Volver al mapa',logout:'Cerrar sesión',servers:'Servidores',settings:'Ajustes',site:'Sitio',login:'Inicio',notify:'Notificaciones',general:'General',proxy:'Proxy inverso',alert_rules:'Reglas de notificación',latency_monitor:'Monitor de latencia',sessions:'Sesiones',account:'Cuenta',logs:'Registros',theme_management:'Tema predeterminado'},
  ru:{help:'Помощь',bridge:'Мостик',day:'День',return_starmap:'К звёздной карте',logout:'Выйти',servers:'Серверы',settings:'Настройки',site:'Сайт',login:'Вход',notify:'Уведомления',general:'Общие',proxy:'Обратный прокси',alert_rules:'Правила уведомлений',latency_monitor:'Монитор задержки',sessions:'Сеансы',account:'Аккаунт',logs:'Журналы',theme_management:'Тема по умолчанию'},
};
function applyAdminLanguage(lang) {
  const dict = ADMIN_I18N[lang] || ADMIN_I18N.zh;
  document.documentElement.lang = lang || 'zh';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (dict[key]) el.textContent = dict[key];
  });
  const btn = document.getElementById('admin-theme-toggle');
  if (btn) btn.textContent = document.body.classList.contains('admin-day-mode') ? dict.day : dict.bridge;
  applyAdminTextLanguage(lang || 'zh');
}
function initAdminToolbar() {
  const btn = document.getElementById('admin-theme-toggle');
  const sel = document.getElementById('admin-lang-select');

  const applyTheme = (mode) => {
    const isDay = mode === 'day';
    document.body.classList.toggle('admin-day-mode', isDay);
    document.body.classList.toggle('admin-bridge-mode', !isDay);
    document.body.style.setProperty('background', 'transparent', 'important');
    document.body.style.setProperty('background-color', 'transparent', 'important');
    document.body.style.setProperty('background-image', 'none', 'important');
    localStorage.setItem('vps_default_theme', isDay ? 'komari-light' : 'bridge');
    applyAdminLanguage(localStorage.getItem('admin_lang') || 'zh');
  };

  const lang = localStorage.getItem('admin_lang') || 'zh';
  if (sel) sel.value = lang;

  if (!document.documentElement.dataset.adminToolbarBound) {
    document.documentElement.dataset.adminToolbarBound = '1';

    document.addEventListener('click', (ev) => {
      const settingsToggle = ev.target.closest?.('#admin-settings-toggle, .admin-tab.has-children[data-tab="settings"]');
      if (!settingsToggle) return;
      ev.preventDefault();
      ev.stopPropagation();
      ev.stopImmediatePropagation?.();
      const settingsSubtabs = document.getElementById('admin-settings-subtabs') || settingsToggle.nextElementSibling;
      const collapsed = settingsSubtabs?.classList.toggle('is-collapsed');
      const caret = settingsToggle.querySelector('.settings-caret') || settingsToggle.querySelector('b');
      if (caret) caret.textContent = collapsed ? '⌃' : '⌄';
      settingsToggle.setAttribute('aria-expanded', String(!collapsed));
      if (!collapsed) switchTab('settings','site');
    }, true);

    document.addEventListener('click', (ev) => {
      const tabButton = ev.target.closest?.('.admin-tab[data-tab]:not(.has-children)');
      if (!tabButton) return;
      ev.preventDefault();
      switchTab(tabButton.dataset.tab);
    });

    document.addEventListener('click', (ev) => {
      const subtabButton = ev.target.closest?.('.admin-subtab[data-settings-section]');
      if (!subtabButton) return;
      ev.preventDefault();
      switchTab('settings', subtabButton.dataset.settingsSection || null);
    });

    document.addEventListener('click', (ev) => {
      const logoutButton = ev.target.closest?.('.btn-logout');
      if (!logoutButton) return;
      ev.preventDefault();
      adminLogout();
    });

    document.addEventListener('click', (ev) => {
      const collapseBtn = ev.target.closest?.('.notify-collapse');
      if (!collapseBtn) return;
      const card = collapseBtn.closest('#notify-settings-card,.komari-notify-settings-card');
      if (!card) return;
      ev.preventDefault();
      const collapsed = card.classList.toggle('is-collapsed');
      collapseBtn.textContent = collapsed ? '⌄' : '⌃';
      collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  initAdminTextI18nObserver(() => localStorage.getItem('admin_lang') || 'zh');
  applyTheme((localStorage.getItem('vps_default_theme') === 'komari-light') ? 'day' : 'bridge');
  btn?.addEventListener('click', () => applyTheme(document.body.classList.contains('admin-day-mode') ? 'bridge' : 'day'));
  sel?.addEventListener('change', () => {
    localStorage.setItem('admin_lang', sel.value || 'zh');
    applyAdminLanguage(sel.value || 'zh');
  });
}

function applyDeepLinkContext() {
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  const settingsSection = params.get('section');
  const editServerId = params.get('edit_server');
  const alertServerId = params.get('alert_server');
  const ruleType = params.get('rule_type');

  if (tab && ['servers','network','alerts','account','users','settings','ops','theme'].includes(tab)) {
    _activeTab = tab;
  }
  switchTab(_activeTab, _activeTab === 'settings' ? settingsSection : null);

  if (_activeTab === 'servers' && editServerId && _serverMgr) {
    _serverMgr.openEditById(editServerId);
  }
  if (_activeTab === 'alerts' && _tgPanel) {
    _tgPanel.prefillRule({ serverId: alertServerId, ruleType });
  }
}

/**
 * 登出处理：增加确认交互
 */
async function adminLogout() {
  if (confirm('确定要退出管理后台吗？')) {
    await logout();  // Revokes token and clears httpOnly cookies server-side
    showLogin();
    // 清理界面状态
    document.getElementById('admin-panel').style.display = 'none';
  }
}

/**
 * 初始化后台面板
 */
async function showAdminPanel() {
  document.getElementById('login-mount').replaceChildren();
  document.body.classList.remove('admin-preboot');
  document.body.classList.add('komari-admin-shell', 'admin-loading');
  // Keep the panel hidden until theme, toolbar labels and first data paint are ready.
  const panel = document.getElementById('admin-panel');
  if (panel) panel.style.display = 'none';
  applySavedAdminTheme();

  // 按需初始化各个功能组件
  if (!_serverMgr) {
    _serverMgr = new ServerManager('tab-servers');
    _pingTool = new PingTool('tab-network');
    _tgPanel = new TelegramPanel('tab-alerts');
    _accountPanel = new AccountPanel('tab-account');
    _userAdminPanel = new UserAdminPanel('tab-users');
    _settingsPanel = new SettingsPanel('tab-settings');
    _opsPanel = new OpsPanel('tab-ops');
    _themePanel = new ThemeManagementPanel('tab-theme');
  }

  // 加载数据
  try {
    await _serverMgr.reload();
    _pingTool.setServers(_serverMgr.servers);
    await _tgPanel.load();
    
    // 默认跳转到当前激活页 + deep link 上下文
    initAdminToolbar();
    applyDeepLinkContext();
  } catch (err) {
    console.error('后台数据加载失败:', err);
  } finally {
    document.body.classList.remove('admin-loading');
    const panel = document.getElementById('admin-panel');
    if (panel) panel.style.display = 'flex';
  }
}

/**
 * 显示登录界面
 */
function showLogin() {
  document.body.classList.remove('admin-preboot');
  new LoginPanel('login-mount', {
    onSuccess: () => showAdminPanel()
  });
}

// ─── 初始化启动 ─────────────────────────────────────────────────────────

async function boot() {
  // P1-7: no localStorage token check; verify session via httpOnly cookie.
  try {
    await checkSession();
    await showAdminPanel();
  } catch (e) {
    // Session expired or not logged in — show login page.
    // Log at debug level so developers can distinguish network errors from normal 401s.
    console.debug('[boot] session check failed, showing login:', e?.message || e);
    showLogin();
  }
}

applySavedAdminTheme();
boot();
