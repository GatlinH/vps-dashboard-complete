// ===== VPS 星图 - 完整前端脚本 =====

'use strict';

const appState = {
    currentPage: 'dashboard',
    currentCurrency: 'CNY',
    exchangeRates: { CNY: 1, USD: 7.26, EUR: 8.5 },
    servers: [],
    authToken: localStorage.getItem('authToken') || null,
    isAuthenticated: !!localStorage.getItem('authToken'),
    currentUser: localStorage.getItem('currentUser') || null
};

function switchPage(pageId) {
    const pages = document.querySelectorAll('.page');
    pages.forEach(p => p.classList.remove('active'));
    const target = document.getElementById('page-' + pageId);
    if (target) {
        target.classList.add('active');
        if (pageId === 'dashboard') initDashboard();
    }
}

function setCurrency(cur) {
    appState.currentCurrency = cur;
    document.querySelectorAll('.currency-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    showNotification(`已切换到 ${cur}`);
}

function openLoginModal() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    modal.innerHTML = `<div class="modal"><div class="modal-header"><div class="modal-title">🔐 登录</div><button class="modal-close" onclick="this.closest('.modal-overlay').remove()" style="cursor:pointer">✕</button></div><div style="padding:1.5rem"><input class="form-input" id="user" placeholder="用户名" style="width:100%;margin-bottom:10px"><input class="form-input" id="pass" type="password" placeholder="密码" style="width:100%;margin-bottom:10px"><button class="login-btn" onclick="performLogin()" style="width:100%;cursor:pointer">登录</button></div></div>`;
    document.body.appendChild(modal);
}

function performLogin() {
    const user = document.getElementById('user')?.value;
    const pass = document.getElementById('pass')?.value;
    if (user && pass && user.length >= 3 && pass.length >= 6) {
        appState.authToken = 'token_' + btoa(user + Date.now());
        appState.isAuthenticated = true;
        appState.currentUser = user;
        localStorage.setItem('authToken', appState.authToken);
        localStorage.setItem('currentUser', user);
        document.querySelector('.modal-overlay').remove();
        updateAuthUI();
        showNotification(`欢迎 ${user}！`);
    }
}

function logout() {
    appState.authToken = null;
    appState.isAuthenticated = false;
    localStorage.removeItem('authToken');
    localStorage.removeItem('currentUser');
    updateAuthUI();
    showNotification('已退出登录');
}

function updateAuthUI() {
    const loginBtn = document.getElementById('loginBtn');
    const avatar = document.getElementById('adminAvatar');
    if (appState.isAuthenticated) {
        if (loginBtn) loginBtn.style.display = 'none';
        if (avatar) avatar.style.display = 'flex';
    } else {
        if (loginBtn) loginBtn.style.display = 'flex';
        if (avatar) avatar.style.display = 'none';
    }
}

function initDashboard() {
    appState.servers = [
        { id: 1, name: 'US-LA-01', ip: '192.168.1.1', location: '美国洛杉矶', status: 'online', cpu: 45, mem: 68, disk: 32, flag: '🇺🇸', uptime: '45d' },
        { id: 2, name: 'JP-TK-01', ip: '192.168.1.2', location: '日本东京', status: 'online', cpu: 32, mem: 54, disk: 45, flag: '🇯🇵', uptime: '89d' },
        { id: 3, name: 'UK-LD-01', ip: '192.168.1.3', location: '英国伦敦', status: 'warn', cpu: 78, mem: 82, disk: 56, flag: '🇬🇧', uptime: '12d' },
        { id: 4, name: 'SG-01', ip: '192.168.1.4', location: '新加坡', status: 'offline', cpu: 0, mem: 0, disk: 0, flag: '🇸🇬', uptime: '0d' }
    ];
    updateStatsBar();
    renderServers();
}

function updateStatsBar() {
    const online = appState.servers.filter(s => s.status === 'online').length;
    const offline = appState.servers.filter(s => s.status === 'offline').length;
    const warn = appState.servers.filter(s => s.status === 'warn').length;
    const avg = (appState.servers.reduce((a,b)=>a+b.cpu,0)/appState.servers.length).toFixed(1);
    const statsBar = document.getElementById('statsBar');
    if (statsBar) statsBar.innerHTML = `
        <div class="stat-card blue"><div class="stat-label">在线</div><div class="stat-val green">${online}</div></div>
        <div class="stat-card red"><div class="stat-label">离线</div><div class="stat-val red">${offline}</div></div>
        <div class="stat-card gold"><div class="stat-label">预警</div><div class="stat-val gold">${warn}</div></div>
        <div class="stat-card purple"><div class="stat-label">平均CPU</div><div class="stat-val">${avg}%</div></div>`;
}

function renderServers() {
    const grid = document.getElementById('serverGrid');
    if (!grid) return;
    grid.innerHTML = appState.servers.map(s => `
        <div class="server-card" onclick="openServerDetail(${s.id})" style="cursor:pointer">
            <div class="card-status-line status-${s.status}"></div>
            <div class="card-header"><div class="card-name"><span class="flag">${s.flag}</span><span>${s.name}</span></div><span class="status-dot ${s.status}"></span></div>
            <div style="font-size:12px;color:var(--text3);margin:8px 0">${s.location}</div>
            <div style="font-size:11px;color:var(--text3);margin-bottom:12px">IP: ${s.ip}</div>
            <div class="metrics">
                <div class="metric-row"><span class="metric-label">CPU</span><div class="metric-bar"><div class="metric-fill fill-blue" style="width:${s.cpu}%"></div></div><span class="metric-val">${s.cpu}%</span></div>
                <div class="metric-row"><span class="metric-label">内存</span><div class="metric-bar"><div class="metric-fill fill-green" style="width:${s.mem}%"></div></div><span class="metric-val">${s.mem}%</span></div>
                <div class="metric-row"><span class="metric-label">硬盘</span><div class="metric-bar"><div class="metric-fill fill-orange" style="width:${s.disk}%"></div></div><span class="metric-val">${s.disk}%</span></div>
            </div>
        </div>`).join('');
}

function filterServers() {
    const term = (document.getElementById('searchBox')?.value || '').toLowerCase();
    document.querySelectorAll('.server-card').forEach((card, i) => {
        const s = appState.servers[i];
        if (!s) return;
        const match = !term || s.name.includes(term) || s.ip.includes(term) || s.location.includes(term);
        card.style.display = match ? 'block' : 'none';
    });
}

function openServerDetail(id) {
    const s = appState.servers.find(x => x.id === id);
    if (!s) return;
    const modal = document.createElement('div');
    modal.className = 'modal-overlay open';
    modal.innerHTML = `<div class="modal"><div class="modal-header"><div class="modal-title">${s.flag} ${s.name}</div><button class="modal-close" onclick="this.closest('.modal-overlay').remove()" style="cursor:pointer">✕</button></div><table class="spec-table"><tr><td>位置</td><td>${s.location}</td></tr><tr><td>IP</td><td>${s.ip}</td></tr><tr><td>CPU</td><td>${s.cpu}%</td></tr><tr><td>内存</td><td>${s.mem}%</td></tr><tr><td>硬盘</td><td>${s.disk}%</td></tr></table></div>`;
    document.body.appendChild(modal);
}

function openAddModal() {
    showNotification('✨ 功能开发中...');
}

function loadAffData() {
    const products = [
        { provider: 'Vultr', cpu: 2, ram: 4, price: 18 },
        { provider: 'Linode', cpu: 4, ram: 8, price: 24 },
        { provider: 'DigitalOcean', cpu: 1, ram: 1, price: 5 },
        { provider: 'Hetzner', cpu: 4, ram: 16, price: 28 }
    ];
    const grid = document.getElementById('affGrid');
    if (grid) grid.innerHTML = products.map(p => `
        <div class="aff-card">
            <div class="aff-card-header"><div class="aff-provider">${p.provider}</div><div class="aff-stock stock-available">✓ 充足</div></div>
            <div class="aff-card-body">
                <div class="aff-spec-grid"><div><div class="aff-spec-key">CPU</div><div class="aff-spec-val">${p.cpu}核</div></div><div><div class="aff-spec-key">内存</div><div class="aff-spec-val">${p.ram}GB</div></div></div>
                <div class="aff-price"><div class="aff-price-main">$${p.price}</div><div class="aff-price-period">/月</div></div>
                <div class="aff-links"><button class="aff-link-btn aff-btn-buy" style="cursor:pointer" onclick="showNotification('开发中...')">购买</button></div>
            </div>
        </div>`).join('');
}

function initGlobe() {
    const canvas = document.getElementById('globe-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(7,11,20,0.8)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(99,179,237,0.4)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(canvas.width/2, canvas.height/2, 120, 0, Math.PI*2);
    ctx.stroke();
}

function adjustZoom(d) {
    const z = Math.max(0.5, Math.min(3, (parseFloat(document.getElementById('zoomLabel')?.textContent||'1')+d)));
    const l = document.getElementById('zoomLabel');
    if (l) l.textContent = z.toFixed(2)+'×';
}

function onFetchToggleChange(c) {
    showNotification(c ? '✓ 已启用自动抓取' : '✓ 已禁用自动抓取');
}

function manualGlobeFetch() {
    showNotification('↻ 正在获取数据...');
}

function initCalculator() {}
function switchCalcTab(t) {}
function fillProbeData(id) {
    showNotification('✓ 正在填充数据...');
}

function loadTrafficData() {
    const t = document.getElementById('page-traffic');
    if (t) t.innerHTML = `<div class="page-title">流量统计</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px"><div class="traffic-card"><h3 style="color:var(--text)">入站</h3><div class="traffic-numbers"><div class="traffic-num-item"><div class="traffic-num-label">已用</div><div class="traffic-num-val">256GB</div></div><div class="traffic-num-item"><div class="traffic-num-label">限制</div><div class="traffic-num-val">1000GB</div></div></div></div></div>`;
}

function prefetchGlobeTiles() {}
function updatePrices() {}

function showNotification(msg) {
    const n = document.createElement('div');
    n.style.cssText = 'position:fixed;top:20px;right:20px;background:linear-gradient(135deg,rgba(99,179,237,0.9),rgba(167,139,250,0.8));color:white;padding:14px 20px;border-radius:8px;z-index:9999;font-size:13px';
    n.textContent = msg;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 3000);
}

function initStarfield() {
    const c = document.getElementById('starfield');
    if (!c) return;
    const ctx = c.getContext('2d');
    c.width = window.innerWidth;
    c.height = window.innerHeight;
    ctx.fillStyle = 'rgba(7,11,20,1)';
    ctx.fillRect(0, 0, c.width, c.height);
    for (let i = 0; i < 150; i++) {
        ctx.fillStyle = `rgba(255,255,255,${Math.random()*0.7+0.3})`;
        ctx.fillRect(Math.random()*c.width, Math.random()*c.height, Math.random()*1.5, Math.random()*1.5);
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initStarfield();
    updateAuthUI();
    if (appState.authToken) appState.isAuthenticated = true, updateAuthUI();
    initDashboard();
    const s = document.getElementById('searchBox');
    if (s) s.addEventListener('input', filterServers);
    console.log('✓ VPS星图已加载');
});

window.addEventListener('resize', initStarfield);