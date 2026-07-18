import { request } from './base.js';

export async function fetchServerGroups() { return (await request('/server-groups')).groups || []; }
export async function createServerGroup(payload) { return (await request('/server-groups', { method: 'POST', body: JSON.stringify(payload) })).group; }
export async function updateServerGroup(id, payload) { return (await request(`/server-groups/${id}`, { method: 'PUT', body: JSON.stringify(payload) })).group; }
export async function deleteServerGroup(id) { return request(`/server-groups/${id}`, { method: 'DELETE' }); }
