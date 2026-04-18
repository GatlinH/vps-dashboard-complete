/**
 * api/auth.js
 * 认证相关接口：登录 / 登出
 */
import { request, setToken, clearToken } from './base.js';

/**
 * 登录
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{access_token: string}>}
 */
export async function login(username, password) {
  const data = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, false);
  if (data.access_token) setToken(data.access_token);
  return data;
}

/** 登出（清除本地 token，不需要请求服务端） */
export function logout() {
  clearToken();
}
