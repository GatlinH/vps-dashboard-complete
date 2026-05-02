/**
 * api/base.js
 * 底层请求封装：统一 Base URL、credentials cookie、CSRF 防护
 *
 * P1-7: 认证改为 httpOnly cookie，不再使用 localStorage 存储 token。
 * 浏览器自动携带 access_token_cookie（httpOnly），JS 只需读取
 * 非 httpOnly 的 csrf_access_token cookie 并注入 X-CSRF-Token 头。
 */

import { getCsrfToken } from './csrf.js';

const BASE = '/api/v1';

// HTTP 方法集合：需要发送 CSRF token 的写操作
const _CSRF_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Re-export getCsrfToken for consumers that import directly from base.js
export { getCsrfToken };

/**
 * 核心请求函数
 * @param {string} path      相对于 /api/v1 的路径，如 '/servers/'
 * @param {object} [opts]    fetch options 扩展（method / body 等）
 * @param {boolean} [auth]   是否携带 CSRF token（写操作），默认 true
 * @returns {Promise<any>}   解析后的 JSON
 * @throws {ApiError}
 */
export async function request(path, opts = {}, auth = true) {
  const method = (opts.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };

  if (auth && _CSRF_METHODS.has(method)) {
    const csrf = getCsrfToken(path);
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }

  let res;
  try {
    res = await fetch(BASE + path, {
      ...opts,
      method,
      headers,
      credentials: 'include',  // Required for httpOnly cookie auth
    });
  } catch (error) {
    throw new ApiError(0, '网络异常，请稍后重试', { error_type: 'NETWORK_ERROR', raw: String(error) });
  }

  // 已登录请求在 401/403 时触发全局登出；未登录请求（如登录接口）交由业务层处理原始错误
  if (auth && (res.status === 401 || res.status === 403)) {
    window.dispatchEvent(new CustomEvent('admin:logout'));
    throw new ApiError(res.status, '登录已过期，请重新登录');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.msg || data.message || `请求失败 (${res.status})`, data);
  return data;
}

/** 自定义错误类，便于业务层识别 */
export class ApiError extends Error {
  constructor(status, message, payload = null) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
    this.payload = payload;
  }
}
