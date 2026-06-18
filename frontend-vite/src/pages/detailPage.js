import { state } from '../store/state.js';
import { LANGUAGE_PACKS, currentLanguage, t } from '../core/preferences.js';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>\"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[ch]));
}


export function detailLoadingShell() {
  return `
    <section class="detail-page-shell starship-console-page">
      <div class="detail-page-topbar">
        <a class="detail-back-link" href="/" data-i18n="back">${t('back')}</a>
        <div class="detail-page-tools">
          <button class="theme-toggle" id="themeToggle" type="button" onclick="toggleTheme()" aria-label="${t('themeAria')}">
            <span id="themeIcon">☾</span><span id="themeLabel">${document.documentElement.getAttribute('data-theme') === 'light' ? t('daylight') : t('bridge')}</span>
          </button>
          <select class="language-select" id="languageSelect" onchange="setLanguage(this.value)" aria-label="${t('langAria')}">
            ${Object.entries(LANGUAGE_PACKS).map(([code, pack]) => `<option value="${code}" ${currentLanguage === code ? 'selected' : ''}>${pack.name}</option>`).join('')}
          </select>
          <div class="currency-switch detail-currency-switch">
            <button class="currency-btn ${state.currency === 'CNY' ? 'active' : ''}" onclick="setCurrency('CNY')">CNY</button>
            <button class="currency-btn ${state.currency === 'USD' ? 'active' : ''}" onclick="setCurrency('USD')">USD</button>
            <button class="currency-btn ${state.currency === 'EUR' ? 'active' : ''}" onclick="setCurrency('EUR')">EUR</button>
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
    helpers,
  } = ctx;
  const h = helpers;
  const targetCount = ((ctx.detailCachedPingTargets || pingTargetsData)?.targets || []).length || 0;
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
          <div><span data-i18n="runtime">${t('runtime')}</span><strong>${h.formatZhDuration(resolvedServer.uptime)}</strong></div>
          <div><span data-i18n="expiry">${t('expiry')}</span><strong>${h.formatExpiryCountdown(resolvedServer.expiry)}</strong></div>
          <div class="fleet-online ${resolvedServer.status}"><strong>${h.statusLabel(resolvedServer.status)}</strong><span>Agent / 心跳</span></div>
        </div>
      </header>

      ${h.renderHealthSummary(resolvedServer, probeRows, ctx.detailCachedPingTargets || pingTargetsData, displayCpuSeries, displayRamSeries)}

      <aside class="fleet-left-rail">
        <div class="fleet-panel node-card">
          <div class="fleet-title" data-i18n="nodeTelemetry">${t('nodeTelemetry')}</div>
          <div class="fleet-info-list">
            <div><span data-i18n="ip">${t('ip')}</span><strong>${escapeHtml(h.maskIpForPublicDisplay(resolvedServer.ip || resolvedServer.name))}</strong><em>${escapeHtml(resolvedServer.city || resolvedServer.location || '—')}</em></div>
            <div><span data-i18n="arch">${t('arch')}</span><strong>${escapeHtml(resolvedServer.arch || 'Arch')}</strong></div>
            <div><span data-i18n="memory">${t('memory')}</span><strong>${resolvedServer.ram || '—'} GB · ${h.pctFmt(resolvedServer.ram_use)}%</strong></div>
            <div><span data-i18n="disk">${t('disk')}</span><strong>${resolvedServer.disk || '—'} GB · ${h.pctFmt(resolvedServer.disk_use)}%</strong></div>
            ${h.renderCompactNodeFacts(resolvedServer)}
          </div>
        </div>
        ${h.renderFleetInsignia()}
      </aside>

      ${h.renderRealtimeResourcePanels(resolvedServer, trafficData, upSeries, downSeries, displayCpuSeries, displayRamSeries)}

      <main class="fleet-chart-matrix">
        <div class="fleet-chart-card compact-metric-card network-throughput-card"><div class="fleet-chart-head"><span>网络吞吐量 · 12小时 · 自动量程</span><strong>↑ ${h.detailRateValue(displayUpSeries, resolvedServer.net_up)} · ↓ ${h.detailRateValue(displayDownSeries, resolvedServer.net_down)}</strong></div><div class="network-legend"><i class="up"></i>上行 <i class="down"></i>下行</div><canvas id="detailNetworkChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card ping-multi-card"><div class="fleet-chart-head"><span>PING · ICMP 真实采样 · 12小时 · 失败不画 0</span><strong>${targetCount} 目标</strong></div><canvas id="detailPingChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card resource-mini-card"><div class="fleet-chart-head"><span>CPU 使用率 · 2小时</span><strong>${h.detailMetricValue(displayCpuSeries, resolvedServer.cpu_use, '%')}</strong></div><canvas id="detailCpuChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card resource-mini-card"><div class="fleet-chart-head"><span>内存使用率 · 2小时</span><strong>${h.detailMetricValue(displayRamSeries, resolvedServer.ram_use, '%')}</strong></div><canvas id="detailMemoryChart"></canvas></div>
        <div class="fleet-chart-card pseudo data-freshness-card compact-metric-card resource-mini-card"><div class="fleet-chart-head"><span>${t('dataFreshness')} · 2小时实时滚动</span><strong>${freshMeta.ageText}</strong></div><div class="freshness-meta"><span>${t('sampleInterval')}: ${freshMeta.sampleSec ? `${freshMeta.sampleSec}s` : '—'}</span><span class="freshness-latest">${t('latestSample')}: ${freshMeta.ageText}</span></div><canvas id="detailFreshnessChart"></canvas></div>
      </main>

      <section class="fleet-right-zone">
        <div class="fleet-panel fleet-database-panel">
          <div class="fleet-title">节点资产记录</div>
          <div class="fleet-table-wrap"><table class="fleet-table"><thead><tr><th data-i18n="identity">${t('identity')}</th><th data-i18n="supplier">${t('supplier')}</th><th data-i18n="city">${t('city')}</th><th data-i18n="ip">${t('ip')}</th><th data-i18n="arch">${t('arch')}</th><th data-i18n="disk">${t('disk')}</th><th data-i18n="uuid">${t('uuid')}</th></tr></thead><tbody>${h.renderNodeDatabaseRows(resolvedServer, stateServers)}</tbody></table></div>
        </div>
        <div class="fleet-probe-grid">
          <div class="fleet-panel fleet-starmap-panel">
            <div class="fleet-title fleet-starmap-title">VPS·星图</div>
            <div id="detailGlobeStarmapMount" class="detail-globe-starmap-mount"></div>
          </div>
          <div class="fleet-panel fleet-probe-table-panel">
            <div class="fleet-title">全球探针延迟</div>
            <table class="fleet-table compact"><thead><tr><th data-i18n="probe">${t('probe')}</th><th>ms</th><th data-i18n="loss">${t('loss')} %</th><th>链路</th></tr></thead><tbody>${h.renderProbeRows(pingTargetsData, pingData)}</tbody></table>
          </div>
        </div>
      </section>

      <footer class="fleet-console-footer">Starfleet Network Services · Advanced Quantum Diagnostics · Sector Monitor</footer>
    </section>`;
}
