/**
 * api/servers.js
 * 服务器管理接口：查询列表、新增、删除
 * 统一做后端字段 → 前端字段的映射（cpu_cores → cpu 等）
 */
import { request } from './base.js';

/** 后端字段 → 前端字段映射 */
function normalize(s) {
  const cfg = s.agent_config && typeof s.agent_config === 'object' ? s.agent_config : {};
  const meta = cfg.inventory_meta && typeof cfg.inventory_meta === 'object' ? cfg.inventory_meta : {};
  return {
    ...s,
    agent_config: cfg,
    group:    s.group_name  || s.group  || '默认分组',
    bw:       s.bandwidth   || s.bw     || '不限',
    cpu:      s.cpu_cores   || s.cpu    || 1,
    ram:      s.ram_gb      || s.ram    || 1,
    disk:     s.disk_gb     || s.disk   || 20,
    traffic_limit_gb: s.traffic_limit_gb ?? 0,
    traffic_reset_day: s.traffic_reset_day ?? 1,
    cpu_use:  s.cpu_use  || 0,
    ram_use:  s.ram_use  || 0,
    disk_use: s.disk_use || 0,
    net_up:   s.net_up   || 0,
    net_down: s.net_down || 0,
    uptime:   s.uptime   || '—',
    provider: s.provider || '',
    provider_guess: s.provider_guess || meta.provider_guess || cfg.provider_guess || meta.org || meta.isp || '',
    city: s.city || meta.city || cfg.city || '',
    region: s.region || meta.region || cfg.region || '',
    country: s.country || meta.country || cfg.country || '',
    lat: s.lat ?? meta.lat ?? cfg.lat ?? null,
    lon: s.lon ?? meta.lon ?? cfg.lon ?? null,
    tags: Array.isArray(s.tags) ? s.tags : [],
  };
}

/**
 * 获取服务器列表
 * @returns {Promise<object[]>}
 */
export async function fetchServers() {
  const data = await request('/servers/');
  return (data.servers || []).map(normalize);
}

/**
 * 新增服务器
 * @param {object} payload 表单数据（前端字段）
 * @returns {Promise<object>}
 */
export async function createServer(payload) {
  const body = {
    name: payload.name,
    ip: payload.ip,
    group: payload.group || '默认分组',
    flag: payload.flag || '🌐',
    location: payload.location || '',
    bandwidth: payload.bw || '待 Agent 回填',
    cpu_cores: payload.cpu === '' || payload.cpu == null ? 0 : (parseInt(payload.cpu) || 0),
    ram_gb: payload.ram === '' || payload.ram == null ? 0 : (parseFloat(payload.ram) || 0),
    disk_gb: payload.disk === '' || payload.disk == null ? 0 : (parseInt(payload.disk) || 0),
    price: parseFloat(payload.price) || 0,
    period: payload.period || 'monthly',
    expiry: payload.expiry || null,
    probe_url: payload.probe || '',
    note: payload.note || '',
    provider: payload.provider || '',
    tags: Array.isArray(payload.tags) ? payload.tags : String(payload.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    traffic_limit_gb: payload.traffic_limit_gb === '' || payload.traffic_limit_gb == null ? 0 : (parseFloat(payload.traffic_limit_gb) || 0),
    traffic_reset_day: payload.traffic_reset_day === '' || payload.traffic_reset_day == null ? 1 : (parseInt(payload.traffic_reset_day) || 1),
    agent_config: payload.agent_config || {},
    provision_agent: payload.provisionAgent !== false,
  };
  const data = await request('/servers/', { method: 'POST', body: JSON.stringify(body) });
  return {
    ...(data.server ? normalize(data.server) : normalize(data)),
    _agent: data.agent || null,
  };
}

/**
 * 删除服务器
 * @param {number|string} id
 */
export async function deleteServer(id) {
  return request(`/servers/${id}`, { method: 'DELETE' });
}

export async function generateAgentKey(id) {
  return request(`/servers/${id}/agent-key/generate`, { method: 'POST' });
}

export async function rotateAgentKey(id) {
  return request(`/servers/${id}/agent-key/rotate`, { method: 'POST' });
}

export async function getAgentOverview(id) {
  return request(`/servers/${id}/agent-overview`);
}

export async function updateAgentConfig(id, config) {
  return request(`/servers/${id}/agent-config`, {
    method: 'PUT',
    body: JSON.stringify(config || {}),
  });
}

export async function enqueueAgentCommand(id, payload) {
  return request(`/servers/${id}/agent-commands`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}


export async function fetchAgentInstallCommand(id, agentKey) {
  return request(`/servers/${id}/agent-install-command`, {
    method: 'POST',
    body: JSON.stringify({ agent_key: agentKey }),
  });
}


export async function updateServer(id, payload) {
  const body = {
    name: payload.name,
    ip: payload.ip,
    group: payload.group || '默认分组',
    flag: payload.flag || '🌐',
    location: payload.location || '',
    bandwidth: payload.bw || '待 Agent 回填',
    price: parseFloat(payload.price) || 0,
    period: payload.period || 'monthly',
    expiry: payload.expiry || null,
    probe_url: payload.probe || '',
    note: payload.note || '',
    provider: payload.provider || '',
    tags: Array.isArray(payload.tags) ? payload.tags : String(payload.tags || '').split(',').map(s => s.trim()).filter(Boolean),
    traffic_limit_gb: payload.traffic_limit_gb === '' || payload.traffic_limit_gb == null ? 0 : (parseFloat(payload.traffic_limit_gb) || 0),
    traffic_reset_day: payload.traffic_reset_day === '' || payload.traffic_reset_day == null ? 1 : (parseInt(payload.traffic_reset_day) || 1),
  };
  return request(`/servers/${id}`, { method: 'PUT', body: JSON.stringify(body) });
}
