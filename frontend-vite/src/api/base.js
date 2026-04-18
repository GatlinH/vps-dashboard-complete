/**
 * api/base.js
 * 底层请求封装：统一 Base URL、Bearer Token 注入、401 自动登出
 */

const BASE = '/api/v1';

/** 读取本地 token */
export const getToken = () => localStorage.getItem('authToken');

/** 保存 token */
export const setToken = (t) => localStorage.setItem('authToken', t);

/** 清除 token（登出时调用） */
export const clearToken = () => localStorage.removeItem('authToken');

/**
 * 核心请求函数
 * @param {string} path      相对于 /api/v1 的路径，如 '/servers/'
 * @param {object} [opts]    fetch options 扩展（method / body 等）
 * @param {boolean} [auth]   是否携带 Bearer token，默认 true
 * @returns {Promise<any>}   解析后的 JSON
 * @throws {ApiError}
 */
export async function request(path, opts = {}, auth = true) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(BASE + path, { ...opts, headers });

  // 401 → 触发全局登出事件
  if (res.status === 401 || res.status === 403) {
    clearToken();
    window.dispatchEvent(new CustomEvent('admin:logout'));
    throw new ApiError(res.status, '登录已过期，请重新登录');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.msg || data.message || `请求失败 (${res.status})`);
  return data;
}

/** 自定义错误类，便于业务层识别 */
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}
