/**
 * src/api/admin.js
 * 管理接口封装 —— 仅供管理后台使用
 * 从 frontend/api-admin.js 迁移，改为 ES Module 标准导出格式
 *
 * P1-7: 认证改为 httpOnly cookie + CSRF 防护，不再使用 localStorage 存储 token。
 * 浏览器自动携带 access_token_cookie（httpOnly）；写操作须附带 X-CSRF-Token 头
 * (值从非 httpOnly 的 csrf_access_token / csrf_refresh_token cookie 中读取)。
 */

import { getCsrfToken } from './csrf.js';

const BASE = '/api/v1'
const API_SCHEMA_VERSION = '2026-04-23'

// HTTP 方法集合：需要发送 CSRF token 的写操作
const _CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// ── 核心请求方法 ─────────────────────────────────────────────────────────────

/**
 * 带 CSRF 防护的认证请求（通过 httpOnly cookie 自动携带凭证）
 * @param {string} path - API 路径（不含 /api 前缀）
 * @param {object} opts - fetch options（method, body 等）
 * @returns {Promise<any>} 解析后的 JSON
 */
async function adminFetch(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase()
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Schema-Version': API_SCHEMA_VERSION,
    ...(opts.headers || {}),
  }

  // Attach CSRF token for state-changing requests (double-submit cookie pattern)
  if (_CSRF_METHODS.has(method)) {
    const csrf = getCsrfToken(path)
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const resp = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'include',  // Required for httpOnly cookie auth
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

  if (resp.status === 401 || resp.status === 403) {
    window.dispatchEvent(new CustomEvent('admin:unauthorized', { detail: { status: resp.status } }))
    const err = new Error(`HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }

  if (!resp.ok) {
    let detail = ''
    try {
      const json = await resp.json()
      detail = json.msg || json.error || ''
    } catch (_) { /* ignore */ }
    const err = new Error(detail || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }

  return resp.json()
}

// ── 认证 ──────────────────────────────────────────────────────────────────────

/** 登录；token 由服务端写入 httpOnly cookie，不再存入 localStorage */
export async function login(username, password) {
  const data = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',  // Required for cookie to be set
    body: JSON.stringify({ username, password }),
  })
  if (!data.ok) {
    const json = await data.json().catch(() => ({}))
    throw new Error(json.msg || '用户名或密码错误')
  }
  const result = await data.json()
  // Do NOT store tokens in localStorage (P1-7)
  return result
}

/** 刷新 Access Token */
export async function refreshToken() {
  return adminFetch('/auth/refresh', { method: 'POST' })
}

/** 获取当前用户信息 */
export async function getCurrentUser() {
  return adminFetch('/auth/me')
}

/** 修改密码 */
export async function changePassword(oldPassword, newPassword) {
  return adminFetch('/auth/change-password', {
    method: 'POST',
    body: { old_password: oldPassword, new_password: newPassword },
  })
}

// ── 服务器管理 ────────────────────────────────────────────────────────────────

/** 列出所有服务器（管理视图，含敏感字段） */
export async function listServers() {
  return adminFetch('/servers/')
}

/** 获取单台服务器详情 */
export async function getServer(id) {
  return adminFetch(`/servers/${id}`)
}

/** 创建服务器 */
export async function createServer(data) {
  return adminFetch('/servers/', { method: 'POST', body: data })
}

/** 更新服务器 */
export async function updateServer(id, data) {
  return adminFetch(`/servers/${id}`, { method: 'PUT', body: data })
}

/** 删除服务器 */
export async function deleteServer(id) {
  return adminFetch(`/servers/${id}`, { method: 'DELETE' })
}

/** 推送实时指标 */
export async function pushMetrics(id, metrics) {
  return adminFetch(`/servers/${id}/metrics`, { method: 'POST', body: metrics })
}

/** 获取历史探针数据（支持 offset 分页与 CSV 导出） */
export async function getHistory(id, days = 1, limit = 100, offset = 0, exportType = '') {
  const params = new URLSearchParams({
    days: String(days),
    limit: String(limit),
    offset: String(offset),
  })
  if (exportType) params.set('export', exportType)
  return adminFetch(`/servers/${id}/history?${params.toString()}`)
}

// ── 探针 ──────────────────────────────────────────────────────────────────────

/** TCP Ping */
export async function tcpPing(host, port = 80, count = 5) {
  return adminFetch('/probe/ping', { method: 'POST', body: { host, port, count } })
}

/** 批量 TCP Ping */
export async function tcpPingBatch(serverIds) {
  return adminFetch('/probe/ping/batch', { method: 'POST', body: { server_ids: serverIds } })
}

/** 抓取探针数据 */
export async function fetchProbe(serverIds) {
  return adminFetch('/probe/fetch-probe', { method: 'POST', body: { server_ids: serverIds } })
}

// ── Telegram ──────────────────────────────────────────────────────────────────

/** 获取 Telegram 配置 */
export async function getTelegramConfig() {
  return adminFetch('/telegram/config')
}

/** 保存 Telegram 配置 */
export async function saveTelegramConfig(config) {
  return adminFetch('/telegram/config', { method: 'POST', body: config })
}

/** 发送测试消息 */
export async function sendTelegramTest() {
  return adminFetch('/telegram/test', { method: 'POST' })
}

/** 手动推送消息 */
export async function sendTelegramMessage(text) {
  return adminFetch('/telegram/send', { method: 'POST', body: { text } })
}

/** 获取告警规则 */
export async function getAlertRules() {
  return adminFetch('/telegram/alerts')
}

/** 保存告警规则 */
export async function saveAlertRules(rules) {
  return adminFetch('/telegram/alerts', { method: 'POST', body: { rules } })
}

// ── 地理 ──────────────────────────────────────────────────────────────────────

/** 获取服务器经纬度列表 */
export async function getServerCoords() {
  return adminFetch('/geo/servers/coords')
}

