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

const API_ROOT = window.__API_ROOT__ || (location.port === "5000" ? `${location.protocol}//${location.hostname}:5000` : location.origin);
const BASE = `${API_ROOT}/api/v1`
const API_SCHEMA_VERSION = '2026-04-23'
const _CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

async function adminFetch(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase()
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-Client-Schema-Version': API_SCHEMA_VERSION,
    ...(opts.headers || {}),
  }

  if (_CSRF_METHODS.has(method)) {
    const csrf = getCsrfToken(path)
    if (csrf) headers['X-CSRF-Token'] = csrf
  }

  const resp = await fetch(BASE + path, {
    method,
    headers,
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })

  if (resp.status === 401) {
    window.dispatchEvent(new CustomEvent('admin:unauthorized', { detail: { status: resp.status } }))
    const err = new Error(`HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }

  if (!resp.ok) {
    let detail = ''
    try {
      const json = await resp.json()
      detail = json.msg || json.error || json.message || ''
    } catch (_) {}
    const err = new Error(detail || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }

  return resp.json()
}

export async function login(username, password, totpCode = '') {
  const body = { username, password };
  if (totpCode) body.totp_code = totpCode;
  const data = await fetch(BASE + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  })
  if (!data.ok) {
    const json = await data.json().catch(() => ({}))
    const err = new Error(json.msg || '用户名或密码错误')
    err.status = data.status
    throw err
  }
  return data.json()
}

export async function refreshToken() { return adminFetch('/auth/refresh', { method: 'POST' }) }
export async function getCurrentUser() { return adminFetch('/auth/me') }
export async function changePassword(oldPassword, newPassword) {
  return adminFetch('/auth/change-password', { method: 'POST', body: { old_password: oldPassword, new_password: newPassword } })
}
export async function listUsers(role = '') {
  const q = role ? `?role=${encodeURIComponent(role)}` : ''
  return adminFetch(`/auth/users${q}`)
}
export async function updateUserRole(userId, role) {
  return adminFetch(`/auth/users/${userId}/role`, { method: 'PATCH', body: { role } })
}

export async function listSessions() { return adminFetch('/auth/sessions') }
export async function deleteSession(sessionId) { return adminFetch(`/auth/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }) }
export async function deleteOtherSessions() { return adminFetch('/auth/sessions', { method: 'DELETE' }) }


export async function updateProfile(data) { return adminFetch('/auth/profile', { method: 'PATCH', body: data }) }
export async function getTwoFactorStatus() { return adminFetch('/auth/2fa/status') }
export async function setupTwoFactor() { return adminFetch('/auth/2fa/setup', { method: 'POST' }) }
export async function enableTwoFactor(code, secret = '') { return adminFetch('/auth/2fa/enable', { method: 'POST', body: { code, secret } }) }
export async function disableTwoFactor(password, code = '') { return adminFetch('/auth/2fa/disable', { method: 'POST', body: { password, code } }) }
export async function getExternalAccounts() { return adminFetch('/auth/external-accounts') }
export async function unlinkExternalAccount(provider) { return adminFetch(`/auth/external-accounts/${encodeURIComponent(provider)}`, { method: 'DELETE' }) }
export function externalAccountBindUrl(provider) { return `/api/v1/auth/external-accounts/${encodeURIComponent(provider)}/start` }

export async function getSettingsSummary() { return adminFetch('/ops/settings-summary') }
export async function getSiteSettings() { return adminFetch('/ops/settings/site') }
export async function saveSiteSettings(data) { return adminFetch('/ops/settings/site', { method: 'PUT', body: data }) }
export async function generateSiteShareLink(hours = 24) { return adminFetch('/ops/settings/site/share/generate', { method: 'POST', body: { hours } }) }
export async function revokeSiteShareLink() { return adminFetch('/ops/settings/site/share/revoke', { method: 'POST' }) }
export async function getGeneralSettings() { return adminFetch('/ops/settings/general') }
export async function saveGeneralSettings(data) { return adminFetch('/ops/settings/general', { method: 'PUT', body: data }) }
export async function updateGeoipDatabase() { return adminFetch('/ops/settings/general/geoip/update', { method: 'POST' }) }
export async function getCloudflareSettings() { return adminFetch('/ops/settings/reverse-proxy/cloudflare') }
export async function saveCloudflareSettings(data) { return adminFetch('/ops/settings/reverse-proxy/cloudflare', { method: 'PUT', body: data }) }
export async function refreshCloudflareSettings() { return adminFetch('/ops/settings/reverse-proxy/cloudflare/refresh', { method: 'POST' }) }
export async function getLoginSettings() { return adminFetch('/ops/settings/login') }
export async function saveLoginSettings(data) { return adminFetch('/ops/settings/login', { method: 'PUT', body: data }) }
export async function getNotificationSettings() { return adminFetch('/ops/settings/notifications') }
export async function saveNotificationSettings(data) { return adminFetch('/ops/settings/notifications', { method: 'PUT', body: data }) }
export async function testNotificationSettings() { return adminFetch('/ops/settings/notifications/test', { method: 'POST' }) }

export async function listServers() { return adminFetch('/servers/') }
export async function getServer(id) { return adminFetch(`/servers/${id}`) }
export async function createServer(data) { return adminFetch('/servers/', { method: 'POST', body: data }) }
export async function updateServer(id, data) { return adminFetch(`/servers/${id}`, { method: 'PUT', body: data }) }
export async function deleteServer(id) { return adminFetch(`/servers/${id}`, { method: 'DELETE' }) }
export async function pushMetrics(id, metrics) { return adminFetch(`/servers/${id}/metrics`, { method: 'POST', body: metrics }) }
export async function getHistory(id, days = 1, limit = 100, offset = 0, exportType = '') {
  const params = new URLSearchParams({ days: String(days), limit: String(limit), offset: String(offset) })
  if (exportType) params.set('export', exportType)
  return adminFetch(`/servers/${id}/history?${params.toString()}`)
}
export async function tcpPing(host, port = 80, count = 5, protocol = 'tcp') { return adminFetch('/probe/ping', { method: 'POST', body: { host, port, count, protocol } }) }
export async function tcpPingBatch(serverIds) { return adminFetch('/probe/ping/batch', { method: 'POST', body: { server_ids: serverIds } }) }
export async function fetchProbe(serverIds) { return adminFetch('/probe/fetch-probe', { method: 'POST', body: { server_ids: serverIds } }) }
export async function getTelegramConfig() { return adminFetch('/telegram/config') }
export async function saveTelegramConfig(config) { return adminFetch('/telegram/config', { method: 'POST', body: config }) }
export async function sendTelegramTest() { return adminFetch('/telegram/test', { method: 'POST' }) }
export async function sendTelegramMessage(text) { return adminFetch('/telegram/send', { method: 'POST', body: { text } }) }
export async function getAlertRules() { return adminFetch('/telegram/alerts') }
export async function saveAlertRules(rules) { return adminFetch('/telegram/alerts', { method: 'POST', body: { rules } }) }
export async function getServerCoords() { return adminFetch('/geo/servers/coords') }


export async function uploadSiteFavicon(file) {
  const form = new FormData();
  form.append('icon', file);
  const headers = { Accept: 'application/json', 'X-Client-Schema-Version': API_SCHEMA_VERSION };
  const csrf = getCsrfToken('/ops/settings/site/favicon');
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const resp = await fetch(BASE + '/ops/settings/site/favicon', { method: 'POST', headers, credentials: 'include', body: form });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.msg || json.error || `HTTP ${resp.status}`);
  return json;
}

export async function resetSiteFavicon() { return adminFetch('/ops/settings/site/favicon', { method: 'DELETE' }) }
export function siteFaviconUrl() { return `${BASE}/ops/settings/site/favicon?ts=${Date.now()}` }
export function downloadSiteBackupUrl() { return `${BASE}/ops/settings/site/backup` }
export async function restoreSiteBackup(file) {
  const form = new FormData();
  form.append('backup', file);
  const headers = { Accept: 'application/json', 'X-Client-Schema-Version': API_SCHEMA_VERSION };
  const csrf = getCsrfToken('/ops/settings/site/backup/restore');
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const resp = await fetch(BASE + '/ops/settings/site/backup/restore', { method: 'POST', headers, credentials: 'include', body: form });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.msg || json.error || `HTTP ${resp.status}`);
  return json;
}
