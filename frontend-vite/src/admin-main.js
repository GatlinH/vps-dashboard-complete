/**
 * src/admin-main.js 
 * 适配美化版 admin.html 的后台逻辑
 */

import './styles/admin.css'; // 确保引入样式
import { logout } from './api/auth.js';
import { ServerMgr } from './components/admin/ServerMgr.js';
import { PingTool } from './components/admin/PingTool.js';
import { TelegramPanel } from './components/admin/TelegramPanel.js';
import { ThemeEditor } from './components/admin/ThemeEditor.js';
import { AgentPanel } from './components/admin/AgentPanel.js';
import { LoginPanel } from './components/admin/LoginPanel.js';

// 全局实例引用
let _serverMgr, _pingTool, _tgPanel, _themeEditor, _agentPanel;
let _activeTab = 'servers';

/**
 * 核心：标签页切换逻辑
 * 适配了 .admin-tab 和 .admin-page 的新 CSS 结构
 */
function switchTab(tab) {
  _activeTab = tab;

  // 1. 切换导航按钮高亮
  document.querySelectorAll('.admin-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
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
  if (tab === 'ping' && _serverMgr) {
    _pingTool.setServers(_serverMgr.servers);
  }
}

/**
 * 登出处理：增加确认交互
 */
async function adminLogout() {
  if (confirm('确定要退出管理后台吗？')) {
    logout();
    showLogin();
    // 清理界面状态
    document.getElementById('admin-panel').style.display = 'none';
  }
}

/**
 * 初始化后台面板
 */
async function showAdminPanel() {
  document.getElementById('login-mount').innerHTML = '';
  document.getElementById('admin-panel').style.display = 'flex';

  // 按需初始化各个功能组件
  if (!_serverMgr) {
    _serverMgr = new ServerMgr('tab-servers');
    _pingTool = new PingTool('tab-ping');
    _tgPanel = new TelegramPanel('tab-telegram');
    _themeEditor = new ThemeEditor('tab-theme');
    _agentPanel = new AgentPanel('tab-agent');
  }

  // 加载数据
  try {
    await _serverMgr.reload();
    _pingTool.setServers(_serverMgr.servers);
    await _tgPanel.load();
    await _agentPanel.load();
    
    // 默认跳转到当前激活页
    switchTab(_activeTab);
  } catch (err) {
    console.error('后台数据加载失败:', err);
  }
}

/**
 * 显示登录界面
 */
function showLogin() {
  new LoginPanel('login-mount', {
    onSuccess: () => showAdminPanel()
  });
}

// ─── 初始化启动 ─────────────────────────────────────────────────────────

function boot() {
  // 检查登录状态并初始化
  const token = localStorage.getItem('admin_token');
  if (token) {
    showAdminPanel();
  } else {
    showLogin();
  }
}

// 将函数暴露给 window，以便 HTML 中的 onclick 事件调用
window.switchTab = switchTab;
window.adminLogout = adminLogout;

boot();
