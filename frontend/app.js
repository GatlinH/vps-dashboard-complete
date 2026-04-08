/**
 * frontend/app.js - VPS 星图 核心应用模块
 * 完全重构版本，去除不必要依赖，采用模块化设计
 */

// =====================================================
// 1. API 服务层
// =====================================================

class APIService {
    constructor(baseURL = '/api') {
        this.baseURL = baseURL;
        this.token = localStorage.getItem('authToken');
        this.timeout = 10000;
    }

    // 设置认证令牌
    setToken(token) {
        this.token = token;
        localStorage.setItem('authToken', token);
    }

    // 通用请求方法
    async request(endpoint, options = {}) {
        const url = `${this.baseURL}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            ...options.headers,
        };

        if (this.token) {
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), this.timeout);

            const response = await fetch(url, {
                method: options.method || 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined,
                signal: controller.signal,
                ...options,
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                if (response.status === 401) {
                    this.handleUnauthorized();
                }
                throw new APIError(`HTTP ${response.status}`, response.status);
            }

            return await response.json();
        } catch (error) {
            console.error(`API Error [${endpoint}]:`, error);
            throw error;
        }
    }

    // 认证 API
    async login(username, password) {
        return this.request('/auth/login', {
            method: 'POST',
            body: { username, password },
        });
    }

    async refreshToken() {
        return this.request('/auth/refresh', { method: 'POST' });
    }

    async getCurrentUser() {
        return this.request('/auth/me');
    }

    // 服务器 API
    async listServers(useCache = true) {
        return this.request('/servers/', { useCache });
    }

    async getServer(id) {
        return this.request(`/servers/${id}`);
    }

    async createServer(data) {
        return this.request('/servers/', {
            method: 'POST',
            body: data,
        });
    }

    async updateServer(id, data) {
        return this.request(`/servers/${id}`, {
            method: 'PUT',
            body: data,
        });
    }

    async deleteServer(id) {
        return this.request(`/servers/${id}`, { method: 'DELETE' });
    }

    async pushMetrics(id, metrics) {
        return this.request(`/servers/${id}/metrics`, {
            method: 'POST',
            body: metrics,
        });
    }

    // 探针 API
    async tcpPing(ip, port = 443) {
        return this.request('/probe/ping', {
            method: 'POST',
            body: { ip, port },
        });
    }

    async batchPing(targets) {
        return this.request('/probe/ping/batch', {
            method: 'POST',
            body: { targets },
        });
    }

    async fetchProbe(url) {
        return this.request('/probe/fetch-probe', {
            method: 'POST',
            body: { url },
        });
    }

    async getIPInfo(ip) {
        return this.request(`/probe/ip-info?ip=${ip}`);
    }

    // 地理 API
    async getTileMap(z, x, y) {
        return this.request(`/geo/tile/${z}/${x}/${y}.png`);
    }

    async getCountries() {
        return this.request('/geo/countries');
    }

    async getServerCoords() {
        return this.request('/geo/servers/coords');
    }

    // Telegram API
    async getTelegramConfig() {
        return this.request('/telegram/config');
    }

    async saveTelegramConfig(config) {
        return this.request('/telegram/config', {
            method: 'POST',
            body: config,
        });
    }

    async sendTelegramTest() {
        return this.request('/telegram/test', { method: 'POST' });
    }

    handleUnauthorized() {
        localStorage.removeItem('authToken');
        window.location.reload();
    }

    // AFF 市场 API
    async listAffProducts(params = {}) {
        const qs = new URLSearchParams(params).toString();
        return this.request(`/aff/${qs ? '?' + qs : ''}`);
    }

    async createAffProduct(data) {
        return this.request('/aff/', { method: 'POST', body: data });
    }

    async updateAffProduct(id, data) {
        return this.request(`/aff/${id}`, { method: 'PUT', body: data });
    }

    async deleteAffProduct(id) {
        return this.request(`/aff/${id}`, { method: 'DELETE' });
    }

    // 汇率 API
    async getExchangeRates(base = 'CNY') {
        return this.request(`/exchange/rates?base=${base}`);
    }
}

// 自定义错误类
class APIError extends Error {
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = 'APIError';
    }
}

// =====================================================
// 2. 数据缓存层
// =====================================================

class CacheManager {
    constructor(ttl = 15000) { // 默认 15 秒
        this.cache = new Map();
        this.ttl = ttl;
    }

    set(key, value, ttl = this.ttl) {
        const expiresAt = Date.now() + ttl;
        this.cache.set(key, { value, expiresAt });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;

        if (Date.now() > item.expiresAt) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    has(key) {
        return this.get(key) !== null;
    }

    clear() {
        this.cache.clear();
    }

    delete(key) {
        this.cache.delete(key);
    }
}

// =====================================================
// 3. 事件系统
// =====================================================

class EventBus {
    constructor() {
        this.events = new Map();
    }

    on(event, callback) {
        if (!this.events.has(event)) {
            this.events.set(event, []);
        }
        this.events.get(event).push(callback);
        
        // 返回取消订阅函数
        return () => {
            const handlers = this.events.get(event);
            const index = handlers.indexOf(callback);
            if (index > -1) handlers.splice(index, 1);
        };
    }

    emit(event, data) {
        if (!this.events.has(event)) return;
        this.events.get(event).forEach(callback => {
            try {
                callback(data);
            } catch (error) {
                console.error(`Event handler error [${event}]:`, error);
            }
        });
    }

    off(event) {
        this.events.delete(event);
    }
}

// =====================================================
// 4. 应用状态管理
// =====================================================

class AppStore {
    constructor() {
        this.state = {
            // 认证状态
            isAuthenticated: !!localStorage.getItem('authToken'),
            currentUser: null,
            token: localStorage.getItem('authToken'),

            // UI 状态
            currentPage: 'dashboard',
            currentCurrency: localStorage.getItem('currency') || 'CNY',
            theme: localStorage.getItem('theme') || 'dark',
            sidebarOpen: true,

            // 业务数据
            servers: [],
            serverMetrics: new Map(),
            selectedServer: null,
            probeResults: [],

            // 全球数据
            countries: null,
            serverCoords: [],

            // 加载状态
            loading: {
                servers: false,
                probe: false,
                metrics: false,
            },

            // 错误信息
            errors: [],

            // 缓存元数据
            lastUpdate: {
                servers: null,
                metrics: null,
            },
        };

        this.eventBus = new EventBus();
    }

    // 获取状态
    getState() {
        return Object.freeze(JSON.parse(JSON.stringify(this.state)));
    }

    // 更新状态（支持路径式更新）
    setState(updates) {
        const oldState = this.getState();
        Object.assign(this.state, updates);
        this.eventBus.emit('stateChange', { oldState, newState: this.getState() });
    }

    // 订阅状态变化
    subscribe(callback) {
        return this.eventBus.on('stateChange', callback);
    }

    // 添加错误
    addError(error, duration = 3000) {
        const id = Date.now();
        const errorObj = { id, message: error, timestamp: Date.now() };
        this.state.errors.push(errorObj);
        this.eventBus.emit('error', errorObj);

        setTimeout(() => {
            this.state.errors = this.state.errors.filter(e => e.id !== id);
        }, duration);
    }

    // 清除错误
    clearErrors() {
        this.state.errors = [];
    }
}

// =====================================================
// 5. 应用核心
// =====================================================

class VPSDashboardApp {
    constructor(config = {}) {
        this.config = {
            apiURL: config.apiURL || '/api',
            updateInterval: config.updateInterval || 15000, // 15秒
            maxRetries: config.maxRetries || 3,
            ...config,
        };

        // 初始化各个模块
        this.api = new APIService(this.config.apiURL);
        this.cache = new CacheManager();
        this.store = new AppStore();
        this.eventBus = this.store.eventBus;

        // 定时任务
        this.updateIntervals = new Map();

        // 初始化
        this.init();
    }

    async init() {
        console.log('🚀 VPS Dashboard 应用启动中...');

        // 恢复认证状态
        if (this.store.state.isAuthenticated) {
            try {
                const user = await this.api.getCurrentUser();
                this.store.setState({ currentUser: user });
            } catch (error) {
                console.warn('获取用户信息失败:', error);
                this.store.setState({ isAuthenticated: false });
            }
        }

        // 触发初始化事件
        this.eventBus.emit('appReady', { app: this });
    }

    // ====== 认证方法 ======
    async login(username, password) {
        try {
            const response = await this.api.login(username, password);
            this.api.setToken(response.access_token);
            
            const user = await this.api.getCurrentUser();
            this.store.setState({
                isAuthenticated: true,
                currentUser: user,
                token: response.access_token,
            });

            this.eventBus.emit('loginSuccess', user);
            return user;
        } catch (error) {
            this.store.addError('登录失败: ' + error.message);
            throw error;
        }
    }

    async logout() {
        this.api.setToken(null);
        this.cache.clear();
        this.store.setState({
            isAuthenticated: false,
            currentUser: null,
            token: null,
            servers: [],
        });
        this.eventBus.emit('logoutSuccess');
    }

    // ====== 服务器管理 ======
    async loadServers(forceRefresh = false) {
        const cacheKey = 'servers:list';

        if (!forceRefresh && this.cache.has(cacheKey)) {
            const cached = this.cache.get(cacheKey);
            this.store.setState({ servers: cached });
            return cached;
        }

        this.store.setState({ 'loading.servers': true });

        try {
            const response = await this.api.listServers();
            const servers = response.servers || [];

            this.cache.set(cacheKey, servers);
            this.store.setState({
                servers,
                'lastUpdate.servers': Date.now(),
                'loading.servers': false,
            });

            this.eventBus.emit('serversLoaded', servers);
            return servers;
        } catch (error) {
            this.store.addError('加载服务器列表失败');
            this.store.setState({ 'loading.servers': false });
            throw error;
        }
    }

    async createServer(serverData) {
        try {
            const created = await this.api.createServer(serverData);
            this.cache.delete('servers:list');
            await this.loadServers(true);
            this.eventBus.emit('serverCreated', created);
            return created;
        } catch (error) {
            this.store.addError('创建服务器失败');
            throw error;
        }
    }

    async updateServer(id, data) {
        try {
            const updated = await this.api.updateServer(id, data);
            this.cache.delete('servers:list');
            await this.loadServers(true);
            this.eventBus.emit('serverUpdated', updated);
            return updated;
        } catch (error) {
            this.store.addError('更新服务器失败');
            throw error;
        }
    }

    async deleteServer(id) {
        try {
            await this.api.deleteServer(id);
            this.cache.delete('servers:list');
            await this.loadServers(true);
            this.eventBus.emit('serverDeleted', id);
        } catch (error) {
            this.store.addError('删除服务器失败');
            throw error;
        }
    }

    // ====== 实时更新 ======
    startMetricsPolling(interval = this.config.updateInterval) {
        if (this.updateIntervals.has('metrics')) {
            clearInterval(this.updateIntervals.get('metrics'));
        }

        const poll = async () => {
            try {
                const servers = this.store.state.servers;
                if (servers.length === 0) return;

                // 并发获取所有服务器指标
                const results = await Promise.allSettled(
                    servers.map(s => this.api.getServer(s.id))
                );

                const metrics = new Map();
                results.forEach((result, index) => {
                    if (result.status === 'fulfilled') {
                        metrics.set(servers[index].id, result.value);
                    }
                });

                this.store.setState({ serverMetrics: metrics });
                this.eventBus.emit('metricsUpdated', metrics);
            } catch (error) {
                console.error('指标更新失败:', error);
            }
        };

        // 立即执行一次
        poll();

        // 设置定时轮询
        const intervalId = setInterval(poll, interval);
        this.updateIntervals.set('metrics', intervalId);

        console.log(`✓ 指标轮询已启动 (间隔: ${interval}ms)`);
    }

    stopMetricsPolling() {
        if (this.updateIntervals.has('metrics')) {
            clearInterval(this.updateIntervals.get('metrics'));
            this.updateIntervals.delete('metrics');
            console.log('✓ 指标轮询已停止');
        }
    }

    // ====== 探针操作 ======
    async tcpPingServer(server) {
        try {
            this.store.setState({ 'loading.probe': true });
            const result = await this.api.tcpPing(server.ip);
            this.store.setState({ 'loading.probe': false });
            this.eventBus.emit('probeResult', result);
            return result;
        } catch (error) {
            this.store.setState({ 'loading.probe': false });
            this.store.addError('TCP Ping 失败');
            throw error;
        }
    }

    async batchTcpPing(servers) {
        try {
            this.store.setState({ 'loading.probe': true });
            const targets = servers.map(s => ({ ip: s.ip, port: 443 }));
            const results = await this.api.batchPing(targets);
            this.store.setState({ 'loading.probe': false });
            this.eventBus.emit('batchProbeResult', results);
            return results;
        } catch (error) {
            this.store.setState({ 'loading.probe': false });
            this.store.addError('批量 Ping 失败');
            throw error;
        }
    }

    // ====== 地理数据 ======
    async loadGeoData() {
        try {
            const [countries, coords] = await Promise.all([
                this.api.getCountries(),
                this.api.getServerCoords(),
            ]);

            this.store.setState({
                countries,
                serverCoords: coords,
            });

            this.eventBus.emit('geodataLoaded', { countries, coords });
        } catch (error) {
            console.error('加载地理数据失败:', error);
        }
    }

    // ====== 清理资源 ======
    destroy() {
        this.stopMetricsPolling();
        this.cache.clear();
        this.updateIntervals.forEach(interval => clearInterval(interval));
        console.log('✓ 应用已销毁');
    }
}

// =====================================================
// 6. 导出
// =====================================================

window.VPSDashboard = VPSDashboardApp;
window.APIService = APIService;
window.AppStore = AppStore;
window.EventBus = EventBus;
window.CacheManager = CacheManager;

// 导出默认实例
const app = new VPSDashboardApp();
window.app = app;

export default app;
