/**
 * api/csrf.js
 * 共享 CSRF token 工具函数（P1-7）
 *
 * flask-jwt-extended 以双提交 cookie 模式保护 httpOnly cookie 认证路径：
 *   - access_token_cookie  (httpOnly) — 由浏览器自动携带，JS 不可读
 *   - csrf_access_token    (非 httpOnly) — JS 可读，用于注入到 X-CSRF-Token 头
 *   - csrf_refresh_token   (非 httpOnly) — 仅在刷新端点调用时使用
 */

/** Path suffix identifying the refresh endpoint (used to select the correct CSRF cookie). */
const REFRESH_PATH_SUFFIX = '/auth/refresh';

/**
 * 从 document.cookie 中读取指定名称的 cookie 值。
 * 使用正则表达式匹配，可正确处理 cookie 值前后的空白。
 * @param {string} name - Cookie 名称（纯字母数字和 _ 字符）
 * @returns {string} cookie 值，找不到时返回空字符串
 */
export function readCookie(name) {
  // Escape special regex chars in name (name should be alphanumeric/_/- in practice,
  // but full escaping guards against any edge-case usage).
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

/**
 * 获取适用于给定 API 路径的 CSRF token。
 * - 刷新端点（路径结尾为 /auth/refresh）读取 csrf_refresh_token
 * - 其他端点读取 csrf_access_token
 * @param {string} [path=''] - API 路径
 * @returns {string} CSRF token 值，未登录时为空字符串
 */
export function getCsrfToken(path = '') {
  const cookieName = path.endsWith(REFRESH_PATH_SUFFIX)
    ? 'csrf_refresh_token'
    : 'csrf_access_token';
  return readCookie(cookieName);
}
