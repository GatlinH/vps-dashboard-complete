import { state } from '../store/state.js';
import { LANGUAGE_PACKS, currentLanguage, t } from '../core/preferences.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '—';
}

function normalizeOsLabel(value) {
  const text = firstText(value);
  if (text === '—') return text;
  return text
    .replace(/^Debian GNU\/Linux\s+/i, 'debian ')
    .replace(/^Ubuntu\s+/i, 'ubuntu ')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .trim();
}

function renderRuntimeEnvironmentCard(server) {
  const cfg = server?.agent_config || {};
  const meta = cfg?.inventory_meta || {};
  const fields = [
    ['操作系统', normalizeOsLabel(server?.os || meta.os || cfg.os)],
    ['内核版本', firstText(server?.kernel_version, server?.kernel, meta.kernel_version, meta.kernel, cfg.kernel_version, cfg.kernel)],
    ['硬件架构', firstText(server?.arch, meta.arch, cfg.arch)],
    ['CPU 型号', firstText(server?.cpu_model, server?.cpu_name, meta.cpu_model, meta.cpu_name, cfg.cpu_model, cfg.cpu_name)],
  ];
  return `<section class="probe-card runtime-env-card" aria-label="运行环境">
    <div class="probe-card-head"><h2>运行环境</h2><span>ENV • 01</span></div>
    <div class="runtime-env-grid">
      ${fields.map(([label, value]) => `<div class="runtime-env-field"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
    </div>
  </section>`;
}


export function detailLoadingShell() {
  return `
    <section class="detail-page-shell starship-console-page">
      <div class="detail-page-topbar">
        <a class="detail-back-link" href="/" data-i18n="back">${t('back')}</a>
        <div class="detail-page-tools">
          <button class="theme-toggle" id="themeToggle" type="button" aria-label="${t('themeAria')}">
            <span id="themeIcon">☾</span><span id="themeLabel">${document.documentElement.getAttribute('data-theme') === 'light' ? t('daylight') : t('bridge')}</span>
          </button>
          <select class="language-select" id="languageSelect" aria-label="${t('langAria')}">
            ${Object.entries(LANGUAGE_PACKS).map(([code, pack]) => `<option value="${code}" ${currentLanguage === code ? 'selected' : ''}>${pack.name}</option>`).join('')}
          </select>
          <div class="currency-switch detail-currency-switch">
            <button class="currency-btn ${state.currency === 'CNY' ? 'active' : ''}" data-currency="CNY">CNY</button>
            <button class="currency-btn ${state.currency === 'USD' ? 'active' : ''}" data-currency="USD">USD</button>
            <button class="currency-btn ${state.currency === 'EUR' ? 'active' : ''}" data-currency="EUR">EUR</button>
          </div>
          <div class="rate-display" id="rateDisplay"></div>
        </div>
      </div>
      <div class="detail-page-grid" id="detailPageGrid" aria-busy="true"></div>
    </section>`;
}

export function renderDetailNotFound(serverId, escText = (v) => String(v ?? '')) {
  return `
    <section class="detail-page-shell starship-console-page">
      <a class="detail-back-link" href="/">← 返回星图</a>
      <div class="detail-error">未找到对应 VPS：${escText(serverId)}</div>
    </section>`;
}

export function renderDetailConsole(ctx) {
  const {
    resolvedServer,
    probeRows,
    pingTargetsData,
    peerPingTargetsData,
    pingData,
    trafficData,
    upSeries,
    downSeries,
    displayUpSeries = upSeries,
    displayDownSeries = downSeries,
    displayCpuSeries,
    displayRamSeries,
    freshMeta,
    stateServers,
    detailDays = 0,
    detailBucketMinutes = 5,
    helpers,
  } = ctx;
  const h = helpers;
  const displayPingTargetsData = ((pingTargetsData?.targets || []).length ? pingTargetsData : ctx.detailCachedPingTargets) || pingTargetsData || ctx.detailCachedPingTargets;
  const displayPeerPingTargetsData = ((peerPingTargetsData?.targets || []).length ? peerPingTargetsData : ctx.detailCachedPeerPingTargets) || peerPingTargetsData || ctx.detailCachedPeerPingTargets;
  const targetCount = (displayPingTargetsData?.targets || []).filter(t => t.type !== 'peer' && !String(t.key || '').startsWith('vps-')).length || 0;
  const historyLabel = detailDays === 0 ? '今天' : `${detailDays}天`;
  const sampleLabel = detailBucketMinutes === 0 ? '实时' : `${detailBucketMinutes}分钟采样`;
  return `
    <section class="fleet-detail-console">
      <header class="fleet-console-header">
        <div class="fleet-node-identity">
          ${h.renderFleetShip()}
          <div class="fleet-node-caption">
            <div class="fleet-micro" data-i18n="nodeId">${t('nodeId')}</div>
            <h1>${escapeHtml(resolvedServer.name)}</h1>
            <p>${escapeHtml(resolvedServer.city || resolvedServer.location || 'UNKNOWN SECTOR')} · ${escapeHtml(h.maskIpForPublicDisplay(resolvedServer.ip || 'NO-IP'))}</p>
          </div>
        </div>
        <div class="fleet-status-bank">
          <div><span data-i18n="sector">${t('sector')}</span><strong>${escapeHtml(resolvedServer.city || resolvedServer.region || resolvedServer.location || 'Unknown')}</strong></div>
          <div><span data-i18n="systemCore">${t('systemCore')}</span><strong>${resolvedServer.status === 'online' ? '稳定' : '告警'}</strong></div>
          <div><span data-i18n="runtime">${t('runtime')}</span><strong>${h.formatZhDuration(resolvedServer.uptime, resolvedServer.agent_key_created_at)}</strong></div>
          <div><span data-i18n="expiry">${t('expiry')}</span><strong>${h.formatExpiryCountdown(resolvedServer.expiry)}</strong></div>
          <div class="fleet-online ${resolvedServer.status}"><strong>${h.statusLabel(resolvedServer.status)}</strong><span>Agent / 心跳</span></div>
        </div>
      </header>

      ${h.renderHealthSummary(resolvedServer, probeRows, displayPingTargetsData, displayCpuSeries, displayRamSeries)}

      <aside class="fleet-left-rail">
        <div class="runtime-env-panel">
          ${renderRuntimeEnvironmentCard(resolvedServer)}
        </div>
      </aside>

      ${h.renderRealtimeResourcePanels(resolvedServer, trafficData, upSeries, downSeries, displayCpuSeries, displayRamSeries)}
      <main class="fleet-chart-matrix">
        <div class="fleet-chart-card compact-metric-card network-throughput-card"><div class="fleet-chart-head"><span>网络吞吐量 · ${historyLabel} · ${sampleLabel}</span><strong>↑ ${h.detailRateValue(displayUpSeries, resolvedServer.net_up)} · ↓ ${h.detailRateValue(displayDownSeries, resolvedServer.net_down)}</strong></div><div class="network-legend"><i class="up"></i>上行 <i class="down"></i>下行</div><canvas id="detailNetworkChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card ping-multi-card"><div class="fleet-chart-head"><span>PING 延迟 · ${historyLabel} · 掉线留空</span><strong>${targetCount} 目标</strong></div><canvas id="detailPingChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card resource-mini-card"><div class="fleet-chart-head"><span>CPU 使用率 · ${historyLabel} · ${sampleLabel}</span><strong>${h.detailMetricValue(displayCpuSeries, resolvedServer.cpu_use, '%')}</strong></div><canvas id="detailCpuChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card resource-mini-card"><div class="fleet-chart-head"><span>内存使用率 · ${historyLabel} · ${sampleLabel}</span><strong>${h.detailMetricValue(displayRamSeries, resolvedServer.ram_use, '%')}</strong></div><canvas id="detailMemoryChart"></canvas></div>
        <div class="fleet-chart-card pseudo data-freshness-card compact-metric-card resource-mini-card"><div class="fleet-chart-head"><span>${t('dataFreshness')} · ${historyLabel}</span><strong>${freshMeta.ageText}</strong></div><div class="freshness-meta"><span>${t('sampleInterval')}: ${freshMeta.sampleSec ? `${freshMeta.sampleSec}s` : '—'}</span><span class="freshness-latest">${t('latestSample')}: ${freshMeta.ageText}</span></div><canvas id="detailFreshnessChart"></canvas></div>
      </main>

      <section class="fleet-right-zone">
        <div class="fleet-probe-grid">
          <div class="fleet-panel fleet-starmap-panel">
            <div class="fleet-title fleet-starmap-title">VPS·星图</div>
            <div id="detailGlobeStarmapMount" class="detail-globe-starmap-mount"></div>
          </div>
          <div class="history-range-bar"><span class="history-range-label">${historyLabel} · ${sampleLabel}</span><div class="detail-history-range" role="group" aria-label="历史图表范围"><button type="button" class="detail-history-btn ${Number(detailDays) === 0 ? 'active' : ''}" data-detail-history-days="0">今天</button>${[1,2,3,4,5,6,7].map((d) => `<button type="button" class="detail-history-btn ${Number(detailDays) === d ? 'active' : ''}" data-detail-history-days="${d}">${d}天</button>`).join('')}</div></div>
          <div class="fleet-panel fleet-probe-table-panel">
            <div class="fleet-title">全球探针延迟</div>
            <table class="fleet-table compact"><thead><tr><th data-i18n="probe">${t('probe')}</th><th>ms</th><th data-i18n="loss">${t('loss')} %</th><th>链路</th></tr></thead><tbody>${h.renderProbeRows(displayPeerPingTargetsData, pingData)}</tbody></table>
          </div>
        </div>
      </section>

      <footer class="fleet-console-footer" aria-hidden="true"></footer>
    </section>`;
}
