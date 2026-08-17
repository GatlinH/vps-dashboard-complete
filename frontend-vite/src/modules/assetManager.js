export function createAssetManager({ state, metric, statusLabel, formatExpiryCountdown, toDisplay, getMonthlyPrice }) {
  function renderInventoryRows(rows = []) {
    return rows.slice(0, 5).map((row, idx) => `<tr><td>ASSET-${idx + 1}</td><td>${row.name}</td><td>${row.city || row.location || 'vector'}</td><td>${statusShortLabel(row.status)}</td><td>${(row.uuid || `phase-${idx + 1}`).slice(0, 13)}</td></tr>`).join('');
  }

  function renderSummaryStats() {
    const rows = Array.isArray(state.servers) ? state.servers : [];
    const total = rows.length;
    const online = rows.filter((server) => server.status === 'online').length;
    const warn = rows.filter((server) => server.status === 'warn').length;
    const offline = rows.filter((server) => server.status !== 'online' && server.status !== 'warn').length;
    return `<div class="detail-metrics-grid compact detail-metrics-grid-dense">${metric('总节点', total)}${metric('在线', online)}${metric('波动', warn)}${metric('离线', offline)}</div>`;
  }

  function statusShortLabel(status) {
    return status === 'online' ? 'ONLINE' : status === 'warn' ? 'WARN' : 'OFFLINE';
  }

  function buildAssetNarrative(server, rv, pct, pingData) {
    const provider = server.provider || server.provider_guess || '未知供应商';
    const loc = server.location || server.city || server.region || server.country || '未知地区';
    const latency = pingData?.stats?.avg_ms != null ? `${pingData.stats.avg_ms}ms` : '暂无 TCP 采样';
    return `${server.name} 当前位于 ${loc}，供应商 ${provider}，月均成本 ${toDisplay(getMonthlyPrice(server))}，剩余价值 ${toDisplay(rv.value)}，流量使用 ${pct.toFixed(1)}%，链路表现 ${latency}。`;
  }

  function buildAssetRiskChips(server, rv, pct, heartbeatPct, pingData) {
    const chips = [statusLabel(server.status), formatExpiryCountdown(server.expiry)];
    if (pct >= 85) chips.push('流量偏高');
    if (Number(heartbeatPct || 0) < 95) chips.push('稳定率偏低');
    if ((pingData?.stats?.loss_pct || 0) > 0) chips.push('存在丢包');
    if (rv.daysLeft <= 7) chips.push('临近续费');
    return chips;
  }

  return { renderInventoryRows, renderSummaryStats, statusShortLabel, buildAssetNarrative, buildAssetRiskChips };
}
