/**
 * api/auth.js
 * 认证相关接口：登录 / 登出 / 会话检查
 *
 * P1-7: 认证改为 httpOnly cookie，不再在 localStorage 中存储 token。
 * 登录后 token 由服务端通过 Set-Cookie 写入 httpOnly cookie；
 * 登出需调用服务端接口以清除 cookie。
 */
import { request } from './base.js';

/**
 * 登录
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{user: object}>}
 */
export async function login(username, password, totpCode = '') {
  const body = { username, password };
  if (totpCode) body.totp_code = totpCode;
  const data = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify(body),
  }, false);
  // Token is stored by the server in an httpOnly cookie — do NOT persist to localStorage.
  return data;
}

/**
 * 登出：调用服务端接口以吊销 token 并清除 httpOnly cookie。
 * 出错时静默忽略（session 可能已过期），调用方负责跳转登录页。
 */
export async function logout() {
  try {
    await request('/auth/logout', { method: 'POST' });
  } catch (_) {
    // Best-effort: cookie/session may already be expired.
  }
}

/**
 * 检查当前会话是否有效（用于页面初始化时判断是否已登录）。
 * @returns {Promise<{user: object}>} 已登录时返回用户信息
 * @throws {ApiError} 未登录时抛出 401
 */
export async function checkSession() {
  return request('/auth/me', {}, true);
}


export async function getOAuthProviders() {
  return request('/auth/oauth/providers', {}, false);
}


export function oauthLoginUrl(provider) {
  const API_ROOT = window.__DBG__.API_ROOT || (location.port === "5000" ? `${location.protocol}//${location.hostname}:5000` : location.origin);
  return `${API_ROOT}/api/v1/auth/oauth/${encodeURIComponent(provider)}/start`;
}


export async function verifyEmailToken(token) {
  return request('/auth/verify-email', {
    method: 'POST',
    body: JSON.stringify({ token }),
  }, false);
}


export async function resetPasswordWithToken(token, newPassword) {
  return request('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, new_password: newPassword }),
  }, false);
}
