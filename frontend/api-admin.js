/**
 * frontend/api-admin.js
 * 管理接口封装 —— 仅供 admin.html 使用
 * 统一处理 Authorization 头、401/403 跳转
 */

'use strict';

const BASE = '/api';
const TOKEN_KEY = 'authToken';

// ── 令牌管理 ──────────────────────────────────────────────────────────────────

export function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
    if (token) {
        localStorage.setItem(TOKEN_KEY, token);
    } else {
        localStorage.removeItem(TOKEN_KEY);
    }
}

export function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
}

// ── 核心请求方法 ─────────────────────────────────────────────────────────────

/**
 * 带 JWT 的请求
 * @param {string} path - API 路径（不含 /api 前缀）
 * @param {object} opts - fetch options（method, body 等）
 * @returns {Promise<any>} 解析后的 JSON
 */
async function adminFetch(path, opts = {}) {
    const token = getToken();
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(opts.headers || {}),
    };

    const resp = await fetch(BASE + path, {
        method: opts.method || 'GET',
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    if (resp.status === 401 || resp.status === 403) {
        // 令牌失效或权限不足 → 清理状态并跳转登录
        clearToken();
        if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('admin:unauthorized', { detail: { status: resp.status } }));
        }
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
    }

    if (!resp.ok) {
        let detail = '';
        try {
            const json = await resp.json();
            detail = json.msg || json.error || '';
        } catch (_) { /* ignore */ }
        const err = new Error(detail || `HTTP ${resp.status}`);
        err.status = resp.status;
        throw err;
    }

    return resp.json();
}

// ── 认证 ──────────────────────────────────────────────────────────────────────

/** 登录，返回 { access_token, refresh_token, user } */
export async function login(username, password) {
    const data = await fetch(BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    if (!data.ok) {
        const json = await data.json().catch(() => ({}));
        throw new Error(json.msg || '用户名或密码错误');
    }
    const result = await data.json();
    setToken(result.access_token);
    return result;
}

/** 刷新 Access Token */
export async function refreshToken() {
    return adminFetch('/auth/refresh', { method: 'POST' });
}

/** 获取当前用户信息 */
export async function getCurrentUser() {
    return adminFetch('/auth/me');
}

/** 修改密码 */
export async function changePassword(oldPassword, newPassword) {
    return adminFetch('/auth/change-password', {
        method: 'POST',
        body: { old_password: oldPassword, new_password: newPassword },
    });
}

// ── 服务器管理 ────────────────────────────────────────────────────────────────

/** 列出所有服务器（管理视图，含敏感字段） */
export async function listServers() {
    return adminFetch('/servers/');
}

/** 获取单台服务器详情 */
export async function getServer(id) {
    return adminFetch(`/servers/${id}`);
}

/** 创建服务器 */
export async function createServer(data) {
    return adminFetch('/servers/', { method: 'POST', body: data });
}

/** 更新服务器 */
export async function updateServer(id, data) {
    return adminFetch(`/servers/${id}`, { method: 'PUT', body: data });
}

/** 删除服务器 */
export async function deleteServer(id) {
    return adminFetch(`/servers/${id}`, { method: 'DELETE' });
}

/** 推送实时指标 */
export async function pushMetrics(id, metrics) {
    return adminFetch(`/servers/${id}/metrics`, { method: 'POST', body: metrics });
}

/** 获取历史探针数据 */
export async function getHistory(id, days = 1, limit = 100) {
    return adminFetch(`/servers/${id}/history?days=${days}&limit=${limit}`);
}

// ── 探针 ──────────────────────────────────────────────────────────────────────

/** TCP Ping */
export async function tcpPing(host, port = 80, count = 5) {
    return adminFetch('/probe/ping', { method: 'POST', body: { host, port, count } });
}

/** 批量 TCP Ping */
export async function tcpPingBatch(serverIds) {
    return adminFetch('/probe/ping/batch', { method: 'POST', body: { server_ids: serverIds } });
}

/** 抓取探针数据 */
export async function fetchProbe(serverIds) {
    return adminFetch('/probe/fetch-probe', { method: 'POST', body: { server_ids: serverIds } });
}

// ── Telegram ──────────────────────────────────────────────────────────────────

/** 获取 Telegram 配置 */
export async function getTelegramConfig() {
    return adminFetch('/telegram/config');
}

/** 保存 Telegram 配置 */
export async function saveTelegramConfig(config) {
    return adminFetch('/telegram/config', { method: 'POST', body: config });
}

/** 发送测试消息 */
export async function sendTelegramTest() {
    return adminFetch('/telegram/test', { method: 'POST' });
}

/** 手动推送消息 */
export async function sendTelegramMessage(text) {
    return adminFetch('/telegram/send', { method: 'POST', body: { text } });
}

/** 获取告警规则 */
export async function getAlertRules() {
    return adminFetch('/telegram/alerts');
}

/** 保存告警规则 */
export async function saveAlertRules(rules) {
    return adminFetch('/telegram/alerts', { method: 'POST', body: { rules } });
}

// ── 地理（管理视图可用） ──────────────────────────────────────────────────────

/** 获取服务器经纬度列表（含管理元数据） */
export async function getServerCoords() {
    return adminFetch('/geo/servers/coords');
}

// ── 暴露全局（兼容非模块脚本） ───────────────────────────────────────────────

window.AdminAPI = {
    getToken, setToken, clearToken,
    login, refreshToken, getCurrentUser, changePassword,
    listServers, getServer, createServer, updateServer, deleteServer,
    pushMetrics, getHistory,
    tcpPing, tcpPingBatch, fetchProbe,
    getTelegramConfig, saveTelegramConfig, sendTelegramTest,
    sendTelegramMessage, getAlertRules, saveAlertRules,
    getServerCoords,
};
