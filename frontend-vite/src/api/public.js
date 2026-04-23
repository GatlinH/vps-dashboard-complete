/**
 * src/api/public.js
 * 公开只读接口封装 —— 无需鉴权
 * 从 frontend/api-public.js 迁移，改为 ES Module 标准导出格式
 */

const BASE = '/api/v1'
const API_SCHEMA_VERSION = '2026-04-23'

/**
 * 通用 GET 请求（无鉴权头）
 * @param {string} path
 * @returns {Promise<any>}
 */
async function publicGet(path) {
  const resp = await fetch(BASE + path, {
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Client-Schema-Version': API_SCHEMA_VERSION },
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
  return publicGet(`/probe/ip-info${qs}`)
}

/** 地图瓦片 URL 构造（直接在 <img> 或 canvas 中使用） */
export function tileURL(z, x, y) {
  return `${BASE}/geo/tile/${z}/${x}/${y}.png`
}
