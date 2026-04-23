/**
 * api/servers.js
 * 服务器管理接口：查询列表、新增、删除
 * 统一做后端字段 → 前端字段的映射（cpu_cores → cpu 等）
 */
import { request } from './base.js';

/** 后端字段 → 前端字段映射 */
function normalize(s) {
  return {
    ...s,
    group:    s.group_name  || s.group  || '默认分组',
    bw:       s.bandwidth   || s.bw     || '不限',
    cpu:      s.cpu_cores   || s.cpu    || 1,
    ram:      s.ram_gb      || s.ram    || 1,
    disk:     s.disk_gb     || s.disk   || 20,
    cpu_use:  s.cpu_use  || 0,
    ram_use:  s.ram_use  || 0,
    disk_use: s.disk_use || 0,
    net_up:   s.net_up   || 0,
    net_down: s.net_down || 0,
    uptime:   s.uptime   || '—',
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
    name:       payload.name,
    ip:         payload.ip,
    group:      payload.group      || '默认分组',
    flag:       payload.flag       || '🌐',
    location:   payload.location   || '',
    bandwidth:  payload.bw         || '不限',
    cpu_cores:  parseInt(payload.cpu)  || 1,
    ram_gb:     parseFloat(payload.ram) || 1,
    disk_gb:    parseInt(payload.disk) || 20,
    price:      parseFloat(payload.price) || 0,
    period:     payload.period     || 'monthly',
    expiry:     payload.expiry     || null,
    probe_url:  payload.probe      || '',
    note:       payload.note       || '',
  };
  return request('/servers/', { method: 'POST', body: JSON.stringify(body) });
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
