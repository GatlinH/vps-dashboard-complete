import '../globals/dashboardGlobals.js';
/**
 * src/api/public.js
 * 公开只读接口封装 —— 无需鉴权
 * 从 frontend/api-public.js 迁移，改为 ES Module 标准导出格式
 */

const API_ROOT = window.__DBG__.API_ROOT || (location.port === "5000" ? `${location.protocol}//${location.hostname}:5000` : location.origin);
const BASE = `${API_ROOT}/api/v1`
const API_SCHEMA_VERSION = '2026-04-23'

/**
 * 通用 GET 请求（无鉴权头）
 * @param {string} path
 * @returns {Promise<any>}
 */
async function publicGet(path) {
  const url = new URL(BASE + path, location.origin)
  url.searchParams.set('_ts', String(Date.now()))
  const resp = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
    cache: 'no-store',
  })
  if (!resp.ok) {
    const payload = await resp.json().catch(() => ({}))
    const err = new Error(payload.message || payload.msg || payload.error || `HTTP ${resp.status}`)
    err.status = resp.status
    err.errorCode = payload.error_code
    throw err
  }
  return resp.json()
}

/** 获取服务器列表（公开视图，敏感字段已过滤） */
export async function listServersPublic() {
  return publicGet('/servers/')
}

/** 获取国家矢量地图数据 */
export async function getCountries() {
  return publicGet('/geo/countries')
}

/**
 * 获取服务器经纬度列表（公开）
 * @param {{mode?: 'list'|'aggregate', page?: number, per_page?: number}} options
 */
export async function getServerCoords(options = {}) {
  const mode = options.mode || 'list'
  const params = new URLSearchParams({ mode })
  if (options.page) params.set('page', String(options.page))
  if (options.per_page) params.set('per_page', String(options.per_page))
  return publicGet(`/geo/servers/coords?${params.toString()}`)
}

/** 查询 IP 地理信息（公开，无需鉴权） */
export async function getIPInfo(ip = '') {
  const qs = ip ? `?ip=${encodeURIComponent(ip)}` : ''
  return publicGet(`/geo/ip${qs}`)
}

/** 获取 AFF 列表 */
export async function listAffProducts(params = {}) {
  const qs = new URLSearchParams();
  if (params.stock) qs.set('stock', params.stock);
  if (params.provider) qs.set('provider', params.provider);
  if (params.group_name) qs.set('group_name', params.group_name);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return publicGet(`/aff/${suffix}`);
}

/** 地图瓦片 URL 构造（直接在 <img> 或 canvas 中使用） */
export function tileURL(z, x, y) {
  return `${BASE}/geo/tile/${z}/${x}/${y}.png`
}

/**
 * 交易估值：计算剩余价值与建议售价
 * POST /api/v1/exchange/estimate
 * @param {{
 *   price: number,
 *   period: string,
 *   buy_date?: string,
 *   expiry?: string,
 *   premium_percent?: number
 * }} params
 * @returns {Promise<{ok: boolean, data: object}>}
 */
export async function postEstimate(params) {
  const resp = await fetch(BASE + '/exchange/estimate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(params),
  })
  const payload = await resp.json().catch(() => ({}))
  if (!resp.ok) {
    const err = new Error(payload.error || `HTTP ${resp.status}`)
    err.status = resp.status
    throw err
  }
  return payload
}
