export function buildServerPayload(payload, { forCreate = false } = {}) {
  return {
    name: payload.name,
    ip: payload.ip,
    ...(payload.group_id != null
      ? { group_id: payload.group_id }
      : { group: payload.group || '默认分组' }),
    flag: payload.flag || '🌐',
    location: payload.location || '',
    bandwidth: payload.bw || '待 Agent 回填',
    ...(forCreate
      ? {
          cpu_cores: payload.cpu === '' || payload.cpu == null ? 0 : parseInt(payload.cpu) || 0,
          ram_gb: payload.ram === '' || payload.ram == null ? 0 : parseFloat(payload.ram) || 0,
          disk_gb: payload.disk === '' || payload.disk == null ? 0 : parseInt(payload.disk) || 0,
        }
      : {}),
    price: parseFloat(payload.price) || 0,
    period: payload.period || 'monthly',
    expiry: payload.expiry || null,
    probe_url: payload.probe || '',
    note: payload.note || '',
    provider: payload.provider || '',
    tags: Array.isArray(payload.tags)
      ? payload.tags
      : String(payload.tags || '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean),
    traffic_limit_gb:
      payload.traffic_limit_gb === '' || payload.traffic_limit_gb == null
        ? 0
        : parseFloat(payload.traffic_limit_gb) || 0,
    traffic_reset_day:
      payload.traffic_reset_day === '' || payload.traffic_reset_day == null
        ? 1
        : parseInt(payload.traffic_reset_day) || 1,
    ...(forCreate
      ? {
          agent_config: payload.agent_config || {},
          provision_agent: payload.provisionAgent !== false,
        }
      : {}),
  };
}
