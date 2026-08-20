import { state } from '../store/state.js';
import { LANGUAGE_PACKS, currentLanguage, t } from '../core/preferences.js';
import { escapeHtmlAttribute, escapeHtmlText as escapeHtml } from '../utils/escapeHtml.js';

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

function normalizeArchitectureLabel(value) {
  const text = firstText(value);
  if (text === '—') return text;
  const normalized = text.toLowerCase().replace(/[\s_-]/g, '');
  // Keep the kernel-reported architecture visible. AMD64/ARM64 are familiar
  // platform aliases, not a replacement for the actual reported value.
  if (normalized === 'x8664' || normalized === 'amd64') return 'x86_64 (AMD64)';
  if (normalized === 'aarch64' || normalized === 'arm64') return 'aarch64 (ARM64)';
  if (normalized === 'armv7' || normalized === 'armv7l') return 'ARMv7';
  if (normalized === 'i386' || normalized === 'i686' || normalized === 'x86') return 'x86';
  return text;
}

function renderRuntimeEnvironmentCard(server) {
  const cfg = server?.agent_config || {};
  const meta = cfg?.inventory_meta || {};
  // Labels carry their i18n key so a language switch can retranslate them in place.
  // Hardcoded label strings here stayed frozen in the render language.
  const fields = [
    ['envOs', normalizeOsLabel(server?.os || meta.os || cfg.os)],
    ['envKernel', firstText(server?.kernel_version, server?.kernel, meta.kernel_version, meta.kernel, cfg.kernel_version, cfg.kernel)],
    ['envArch', normalizeArchitectureLabel(server?.arch || meta.arch || cfg.arch)],
    ['envCpuModel', firstText(server?.cpu_model, server?.cpu_name, meta.cpu_model, meta.cpu_name, cfg.cpu_model, cfg.cpu_name)],
  ];
  return `<section class="probe-card runtime-env-card" aria-label="${escapeHtmlAttribute(t('envRuntime'))}">
    <div class="probe-card-head"><h2 data-i18n="envRuntime">${t('envRuntime')}</h2><span>ENV • 01</span></div>
    <div class="runtime-env-grid">
      ${fields.map(([key, value]) => `<div class="runtime-env-field"><span data-i18n="${key}">${escapeHtml(t(key))}</span><strong>${escapeHtml(value)}</strong></div>`).join('')}
    </div>
  </section>`;
}


export function detailLoadingShell(resolvedServer = {}) {
  const serverName = escapeHtml(firstText(resolvedServer.name, 'VPS 节点'));
  const location = escapeHtml(firstText(resolvedServer.city, resolvedServer.region, resolvedServer.location, '定位信息同步中'));
  const ip = escapeHtml(firstText(resolvedServer.ip, resolvedServer.public_ip, 'IP 同步中'));
  const status = escapeHtml(firstText(resolvedServer.status, '状态同步中'));
  const metricLabels = ['运行环境', '告警概览', '资源负载', '网络流量'];
  const chartLabels = ['网络吞吐量', 'PING 延迟', 'CPU 使用率', '内存使用率'];
  return `
    <section class="detail-page-shell starship-console-page detail-loading-page">
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
      <div class="detail-page-grid" id="detailPageGrid" aria-busy="true">
        <section class="fleet-detail-console detail-loading-console" aria-label="VPS 详情加载中">
          <header class="fleet-console-header detail-loading-header">
            <div class="fleet-node-identity">
              <div class="detail-loading-insignia" aria-hidden="true"></div>
              <div class="fleet-node-caption">
                <div class="fleet-micro">NODE / 同步中</div>
                <h1>${serverName}</h1>
                <p>${location} · ${ip} · ${status}</p>
                <span class="detail-loading-status" role="status">正在同步实时与历史指标</span>
              </div>
            </div>
            <div class="fleet-status-bank detail-loading-status-bank" aria-label="节点状态占位">
              ${['区域', '系统', '运行时长', '到期', 'Agent'].map((label) => `<div><span>${label}</span><strong class="detail-loading-line"></strong></div>`).join('')}
            </div>
          </header>
          <section class="detail-health-summary detail-loading-health" aria-label="运行健康摘要加载中">
            <div><span>运行健康</span><strong class="detail-loading-line"></strong><em>正在汇总节点信号</em></div>
            <div><span>资源负载</span><strong class="detail-loading-line"></strong><em>等待实时采样</em></div>
            <div><span>链路质量</span><strong class="detail-loading-line"></strong><em>等待探针回传</em></div>
          </section>
          <section class="probe-observability-grid detail-loading-metrics" aria-label="实时资源监控加载中">
            ${metricLabels.map((label) => `<article class="probe-card detail-loading-metric"><div class="probe-card-head"><h2>${label}</h2><span>SYNC</span></div><div class="detail-loading-lines"><i></i><i></i><i></i></div></article>`).join('')}
          </section>
          <main class="fleet-chart-matrix detail-loading-charts" aria-label="历史图表加载中">
            ${chartLabels.map((label) => `<article class="fleet-chart-card detail-loading-chart"><div class="fleet-chart-head"><span>${label}</span><strong class="detail-loading-line"></strong></div><div class="detail-loading-chart-wave" aria-hidden="true"></div></article>`).join('')}
          </main>
        </section>
      </div>
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
    vpsProbeTargetsData,
    pingData,
    trafficData,
    upSeries,
    downSeries,
    displayUpSeries = upSeries,
    displayDownSeries = downSeries,
    displayCpuSeries,
    displayRamSeries,
    processMeta,
    stateServers,
    detailDays = 0,
    detailBucketMinutes = 5,
    helpers,
  } = ctx;
  const h = helpers;
  const displayPingTargetsData = ((pingTargetsData?.targets || []).length ? pingTargetsData : ctx.detailCachedPingTargets) || pingTargetsData || ctx.detailCachedPingTargets;
  const targetCount = (displayPingTargetsData?.targets || []).length || 0;
  const historyLabel = detailDays === 0 ? t('rangeToday') : `${detailDays}${t('rangeDayUnit')}`;
  const sampleLabel = detailBucketMinutes === 0 ? t('rangeRealtime') : `${detailBucketMinutes}${t('rangeMinuteSampling')}`;
  const wideWindowLabel = `${detailDays}${t('rangeDayUnit')}`;
  const resourceWindowLabel = t('chartHours1');
  const resourceSampleLabel = t('chartRealtimeSampling');
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
          <div><span data-i18n="systemCore">${t('systemCore')}</span><strong data-i18n-core-status="${escapeHtmlAttribute(resolvedServer.status || '')}">${resolvedServer.status === 'online' ? t('coreStable') : t('coreAlert')}</strong></div>
          <div><span data-i18n="runtime">${t('runtime')}</span><strong data-i18n-uptime-raw="${escapeHtmlAttribute(String(resolvedServer.uptime ?? ''))}" data-i18n-uptime-since="${escapeHtmlAttribute(String(resolvedServer.agent_key_created_at ?? ''))}">${h.formatZhDuration(resolvedServer.uptime, resolvedServer.agent_key_created_at)}</strong></div>
          <div><span data-i18n="expiry">${t('expiry')}</span><strong data-i18n-expiry-raw="${escapeHtmlAttribute(String(resolvedServer.expiry ?? ''))}">${h.formatExpiryCountdown(resolvedServer.expiry)}</strong></div>
          <div class="fleet-online ${resolvedServer.status}"><strong data-i18n-status-label="${escapeHtmlAttribute(resolvedServer.status || '')}">${h.statusLabel(resolvedServer.status)}</strong><span data-i18n-heartbeat>Agent / ${t('heartbeat')}</span></div>
        </div>
      </header>

      ${h.renderHealthSummary(resolvedServer, probeRows, displayPingTargetsData, displayCpuSeries, displayRamSeries)}

      ${h.renderRealtimeResourcePanels(resolvedServer, trafficData, upSeries, downSeries, displayCpuSeries, displayRamSeries, renderRuntimeEnvironmentCard(resolvedServer))}
      <main class="fleet-chart-matrix">
        <div class="fleet-chart-card compact-metric-card network-throughput-card chart-loading"><div class="fleet-chart-head"><span data-i18n-chart="network">${t('chartNetworkThroughput')} · ${wideWindowLabel} · ${sampleLabel}</span><strong>↑ ${h.detailRateValue(displayUpSeries, resolvedServer.net_up)} · ↓ ${h.detailRateValue(displayDownSeries, resolvedServer.net_down)}</strong></div><div class="network-legend"><i class="up"></i><span data-i18n="chartUp">${t('chartUp')}</span> <i class="down"></i><span data-i18n="chartDown">${t('chartDown')}</span></div><div class="network-chart-surface"><canvas id="detailNetworkChart"></canvas></div></div>
        <div class="fleet-chart-card compact-metric-card ping-multi-card chart-loading"><div class="fleet-chart-head"><span data-i18n-chart="ping">${t('chartPingLatency')} · ${wideWindowLabel} · ${t('chartDropLeavesGap')}</span><strong class="detail-ping-target-count">${targetCount} ${Number(targetCount) === 1 ? t('chartTargetOne') : t('chartTargets')}</strong></div><canvas id="detailPingChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card resource-mini-card chart-loading"><div class="fleet-chart-head"><span data-i18n-chart="cpu">${t('chartCpuUsage')} · ${t('chartHours1')} · ${t('chartRealtimeSampling')}</span><strong>${h.detailMetricValue(displayCpuSeries, resolvedServer.cpu_use, '%')}</strong></div><canvas id="detailCpuChart"></canvas></div>
        <div class="fleet-chart-card compact-metric-card resource-mini-card chart-loading"><div class="fleet-chart-head"><span data-i18n-chart="memory">${t('chartMemoryUsage')} · ${t('chartHours1')} · ${t('chartRealtimeSampling')}</span><strong>${h.detailMetricValue(displayRamSeries, resolvedServer.ram_use, '%')}</strong></div><canvas id="detailMemoryChart"></canvas></div>
        <div class="fleet-chart-card pseudo process-count-card compact-metric-card resource-mini-card chart-loading"><div class="fleet-chart-head"><span data-i18n-chart="process">${t('chartProcessCount')} · ${t('chartHours1')}</span><strong>${processMeta.countText}</strong></div><div class="process-count-meta"><span>${processMeta.count == null ? t('waitingAgentProcessCount') : t('processTotalsOnly')}</span><span class="process-count-latest">${processMeta.count == null ? t('noSamplesAvailable') : t('hostLevelMonitoring')}</span></div><canvas id="detailProcessCountChart"></canvas></div>
      </main>

      <section class="fleet-right-zone">
        <div class="fleet-probe-grid">
          <div class="fleet-panel fleet-starmap-panel">
            <div class="fleet-title fleet-starmap-title">VPS·星图</div>
            <div id="detailGlobeStarmapMount" class="detail-globe-starmap-mount"></div>
          </div>
          <div class="history-range-bar"><span class="history-range-label">${historyLabel} · ${sampleLabel}</span><div class="detail-history-range" role="group" aria-label="历史图表范围">${[1,4,7,30,90].map((d) => `<button type="button" class="detail-history-btn ${Number(detailDays) === d ? 'active' : ''}" data-detail-history-days="${d}">${d}${t('rangeDayUnit')}</button>`).join('')}</div></div>
          <div class="fleet-panel fleet-probe-table-panel">
            <div class="fleet-title">全球 VPS 探针延迟 <small class="fleet-title-hint">当前节点 → 其它 VPS</small></div>
            <table class="fleet-table compact"><thead><tr><th>对端 VPS</th><th>ms</th><th data-i18n="loss">${t('loss')} %</th><th>链路</th></tr></thead><tbody>${h.renderGlobalVpsProbeRows(vpsProbeTargetsData || ctx.detailCachedVpsProbeTargets)}</tbody></table>
          </div>
        </div>
      </section>

      <footer class="fleet-console-footer" aria-hidden="true"></footer>
    </section>`;
}
