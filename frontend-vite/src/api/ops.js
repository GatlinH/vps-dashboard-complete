import { request } from './base.js';

export async function fetchOpsSummary() {
  return request('/ops/summary');
}

export async function fetchOpsEvents(params = {}) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set('limit', params.limit);
  if (params.event_type) qs.set('event_type', params.event_type);
  if (params.server_id) qs.set('server_id', params.server_id);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return request(`/ops/events${suffix}`);
}
