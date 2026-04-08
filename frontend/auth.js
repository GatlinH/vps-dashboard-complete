/**
 * frontend/auth.js - 前端认证管理模块
 *
 * 功能：
 *  - 通过后端 /api/auth/login 进行真实 JWT 登录
 *  - Token 存储（localStorage 支持"记住我"，否则 sessionStorage）
 *  - 请求自动添加 Authorization 头
 *  - Access Token 过期前自动刷新（使用 Refresh Token）
 *  - 无效 Token 时自动打开登录窗口
 *  - 登录尝试计数
 */

'use strict';

const AUTH_CONFIG = {
    loginUrl: '/api/auth/login',
    refreshUrl: '/api/auth/refresh',
    meUrl: '/api/auth/me',
    accessKey: 'vps_access_token',
    refreshKey: 'vps_refresh_token',
    userKey: 'vps_user',
    rememberKey: 'vps_remember',
    // 提前多少毫秒刷新 token（2 分钟）
    refreshBeforeMs: 2 * 60 * 1000,
    // Access Token 默认有效期（15 分钟，与后端一致）
    defaultAccessTtlMs: 15 * 60 * 1000,
    // 自动刷新最短等待时间（毫秒）
    minRefreshDelayMs: 10 * 1000,
};

class AuthManager {
    constructor() {
        this._refreshTimer = null;
        this._loginAttempts = 0;
    }

    // ── 存储帮助 ───────────────────────────────────────────────────────────

    _store() {
        return localStorage.getItem(AUTH_CONFIG.rememberKey) === '1'
            ? localStorage
            : sessionStorage;
    }

    _saveTokens(accessToken, refreshToken, remember) {
        if (remember) {
            localStorage.setItem(AUTH_CONFIG.rememberKey, '1');
        } else {
            localStorage.removeItem(AUTH_CONFIG.rememberKey);
        }
        const store = remember ? localStorage : sessionStorage;
        store.setItem(AUTH_CONFIG.accessKey, accessToken);
        if (refreshToken) {
            store.setItem(AUTH_CONFIG.refreshKey, refreshToken);
        }
    }

    _clearTokens() {
        [localStorage, sessionStorage].forEach(s => {
            s.removeItem(AUTH_CONFIG.accessKey);
            s.removeItem(AUTH_CONFIG.refreshKey);
            s.removeItem(AUTH_CONFIG.userKey);
        });
        localStorage.removeItem(AUTH_CONFIG.rememberKey);
    }

    getAccessToken() {
        return (
            localStorage.getItem(AUTH_CONFIG.accessKey) ||
            sessionStorage.getItem(AUTH_CONFIG.accessKey) ||
            null
        );
    }

    getRefreshToken() {
        return (
            localStorage.getItem(AUTH_CONFIG.refreshKey) ||
            sessionStorage.getItem(AUTH_CONFIG.refreshKey) ||
            null
        );
    }

    getUser() {
        try {
            const raw =
                localStorage.getItem(AUTH_CONFIG.userKey) ||
                sessionStorage.getItem(AUTH_CONFIG.userKey);
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    _saveUser(user) {
        this._store().setItem(AUTH_CONFIG.userKey, JSON.stringify(user));
    }

    isAuthenticated() {
        return !!this.getAccessToken();
    }

    // ── JWT 解析 ───────────────────────────────────────────────────────────

    _parseJwt(token) {
        try {
            const payload = token.split('.')[1];
            return JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
        } catch {
            return null;
        }
    }

    _tokenExpiresIn(token) {
        const payload = this._parseJwt(token);
        if (!payload || !payload.exp) return 0;
        return payload.exp * 1000 - Date.now();
    }

    // ── 自动刷新 ───────────────────────────────────────────────────────────

    _scheduleRefresh(accessToken) {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        const expiresIn = this._tokenExpiresIn(accessToken);
        const delay = Math.max(
            expiresIn - AUTH_CONFIG.refreshBeforeMs,
            AUTH_CONFIG.minRefreshDelayMs
        );
        this._refreshTimer = setTimeout(() => this._doRefresh(), delay);
    }

    async _doRefresh() {
        const refreshToken = this.getRefreshToken();
        if (!refreshToken) {
            this._handleExpired();
            return;
        }
        try {
            const res = await fetch(AUTH_CONFIG.refreshUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${refreshToken}`,
                },
            });
            if (!res.ok) throw new Error(`Token refresh failed (${res.status})`);
            const data = await res.json();
            const newAccess = data.access_token;
            const remember = localStorage.getItem(AUTH_CONFIG.rememberKey) === '1';
            // /api/auth/refresh returns a new access token only; pass null for refreshToken
            this._saveTokens(newAccess, null, remember);
            this._scheduleRefresh(newAccess);
            console.log('[Auth] Access token refreshed');
        } catch (err) {
            console.warn('[Auth] Token refresh failed, re-login required', err);
            this._handleExpired();
        }
    }

    _handleExpired() {
        this._clearTokens();
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        // 通知全局 UI 重新显示登录框
        window.dispatchEvent(new CustomEvent('auth:expired'));
    }

    // ── 核心 API ───────────────────────────────────────────────────────────

    /**
     * 登录
     * @param {string} username
     * @param {string} password
     * @param {boolean} remember - 是否记住我
     * @returns {Promise<{user: object}>}
     */
    async login(username, password, remember = false) {
        this._loginAttempts += 1;

        const res = await fetch(AUTH_CONFIG.loginUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.msg || `登录失败 (${res.status})`);
        }

        const data = await res.json();
        this._saveTokens(data.access_token, data.refresh_token, remember);
        this._saveUser(data.user);
        this._scheduleRefresh(data.access_token);
        this._loginAttempts = 0;

        window.dispatchEvent(new CustomEvent('auth:login', { detail: data.user }));
        return data.user;
    }

    /** 退出登录 */
    logout() {
        if (this._refreshTimer) clearTimeout(this._refreshTimer);
        this._clearTokens();
        window.dispatchEvent(new CustomEvent('auth:logout'));
    }

    /**
     * 携带 Authorization 头发起请求，401 时自动处理
     * @param {string} url
     * @param {RequestInit} options
     */
    async apiFetch(url, options = {}) {
        const token = this.getAccessToken();
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const res = await fetch(url, { ...options, headers });

        if (res.status === 401) {
            // 尝试刷新一次
            try {
                await this._doRefresh();
                const newToken = this.getAccessToken();
                if (newToken) {
                    headers['Authorization'] = `Bearer ${newToken}`;
                    return fetch(url, { ...options, headers });
                }
            } catch {
                // ignore – _doRefresh already fires auth:expired
            }
            this._handleExpired();
        }

        return res;
    }

    /** 恢复会话（页面刷新后调用） */
    restoreSession() {
        const token = this.getAccessToken();
        if (!token) return false;
        const expiresIn = this._tokenExpiresIn(token);
        if (expiresIn <= 0) {
            // 尝试用 refresh token 续期
            this._doRefresh();
            return false; // 暂时认为未登录，等刷新完成
        }
        this._scheduleRefresh(token);
        return true;
    }

    /** 当前登录尝试次数 */
    get loginAttempts() {
        return this._loginAttempts;
    }
}

// 单例导出
const authManager = new AuthManager();
window.authManager = authManager;
