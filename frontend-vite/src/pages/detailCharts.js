function ensureDenseSeries(series) {
  return (Array.isArray(series) ? series : []).map(Number).filter((v) => Number.isFinite(v));
}

function visiblePointRadius(points = [], radius = 3.5) {
  return 0;
}

function expandSinglePointSeries(points = [], deltaMs = 90 * 1000) {
  // Do not fake a short line for a single sample. Charts start drawing only after the next real agent interval.
  return Array.isArray(points) ? points : [];
}


function detailRateStepCeiling(valueKbps = 0) {
  const v = Math.max(0, Number(valueKbps) || 0);
  const steps = [10, 25, 50, 100, 200, 500, 1024, 2048, 5120, 10240, 51200, 102400];
  return steps.find(step => v <= step) || Math.ceil(v / 102400) * 102400;
}


function detailRateStepTicks(maxKbps = 0) {
  const max = detailRateStepCeiling(maxKbps);
  const candidates = [10, 25, 50, 100, 200, 500, 1024, 2048, 5120, 10240, 51200, 102400].filter(v => v > 0 && v <= max);
  if (!candidates.includes(max)) candidates.push(max);
  const tail = Array.from(new Set(candidates)).sort((a, b) => a - b).slice(-4);
  return [0, ...tail].filter((v, i, arr) => arr.indexOf(v) === i).sort((a, b) => a - b);
}

function detailRateStepLabel(valueKbps = 0) {
  const v = Math.max(0, Number(valueKbps) || 0);
  if (v >= 1024) {
    const mbps = v / 1024;
    return mbps >= 10 ? `${mbps.toFixed(0)}M` : `${mbps.toFixed(1).replace(/\.0$/, '')}M`;
  }
  return `${Math.round(v)}K`;
}


const NETWORK_EQUAL_STEP_AXIS = [
  { value: 0, label: '0' },
  { value: 50, label: '50K' },
  { value: 100, label: '100K' },
  { value: 200, label: '200K' },
  { value: 500, label: '500K' },
  { value: 1024, label: '1M' },
  { value: 51200, label: '50M' },
  { value: 128000, label: '125M' },
];

function networkEqualStepY(valueKbps = 0) {
  const v = Math.max(0, Number(valueKbps) || 0);
  const axis = NETWORK_EQUAL_STEP_AXIS;
  if (v <= axis[0].value) return 0;
  for (let i = 1; i < axis.length; i += 1) {
    if (v <= axis[i].value) {
      const lo = axis[i - 1].value;
      const hi = axis[i].value;
      const span = Math.max(1e-9, hi - lo);
      return (i - 1) + ((v - lo) / span);
    }
  }
  return axis.length - 1;
}

function networkEqualStepLabel(index = 0) {
  const i = Math.max(0, Math.min(NETWORK_EQUAL_STEP_AXIS.length - 1, Math.round(Number(index) || 0)));
  return NETWORK_EQUAL_STEP_AXIS[i].label;
}

function networkEqualStepSeries(points = []) {
  return (Array.isArray(points) ? points : []).map((p) => {
    const rawY = Number(p?.y || 0);
    const rawMaxY = Number(p?.maxY);
    return {
      ...p,
      rawY,
      rawMaxY: Number.isFinite(rawMaxY) ? rawMaxY : null,
      y: networkEqualStepY(rawY),
      maxY: Number.isFinite(rawMaxY) ? networkEqualStepY(rawMaxY) : null,
    };
  });
}

function isDetailMobileChart() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
}

function makeHudChartOptions(maxTicks = 5, yUnit = '') {
  const mobile = isDetailMobileChart();
  const tickLimit = mobile ? Math.min(4, maxTicks) : maxTicks;
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: { display: false },
      tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, titleColor: '#eaffff', bodyColor: '#bffffb' }
    },
    scales: {
      x: { ticks: { color: '#8ab5bd', maxRotation: 0, autoSkip: true, maxTicksLimit: tickLimit, font: { size: mobile ? 7 : 8 } }, grid: { color: 'rgba(98,245,238,0.13)' }, border: { color: 'rgba(98,245,238,.18)' } },
      y: { afterFit(axis){ if (mobile) axis.width = Math.max(axis.width, 44); }, ticks: { color: '#8ab5bd', autoSkip: true, maxTicksLimit: mobile ? 4 : undefined, font: { size: mobile ? 7 : 8 }, padding: mobile ? 4 : 3, callback: (v) => yUnit ? `${v}${yUnit}` : v }, grid: { color: 'rgba(98,245,238,0.15)' }, border: { color: 'rgba(98,245,238,.18)' } }
    }
  };
}


export function initNetworkTooltip() {
  const card = document.querySelector('.network-throughput-card');
  const svg = card?.querySelector('svg.network-dual-chart');
  if (!card || !svg) return;
  card.querySelector('.network-tooltip')?.remove();
  let labels = [], up = [], down = [];
  try { labels = JSON.parse(card.dataset.labels || '[]'); } catch {}
  try { up = JSON.parse(card.dataset.up || '[]'); } catch {}
  try { down = JSON.parse(card.dataset.down || '[]'); } catch {}
  const n = Math.max(labels.length, up.length, down.length);
  if (n < 2) return;
  const tooltip = document.createElement('div');
  tooltip.className = 'network-tooltip';
  tooltip.style.display = 'none';
  card.appendChild(tooltip);
  const now = Date.now();
  const fullStartMs = now - 12 * 60 * 60 * 1000;
  const rows = Array.from({ length: n }).map((_, i) => {
    const fallback = n > 1 ? fullStartMs + (i / (n - 1)) * (now - fullStartMs) : now;
    const t = rowTimeMs({ ts: labels[i] }, fallback);
    return { t, up: Number(up[i] || 0), down: Number(down[i] || 0) };
  }).filter(r => Number.isFinite(r.t)).sort((a,b)=>a.t-b.t);
  const axis = accumulatingAxisBoundsFromTimes(rows.map(r => r.t), 12);
  const startMs = axis.min;
  const endMs = axis.max;
  const rectOf = () => svg.getBoundingClientRect();
  const move = (ev) => {
    const r = rectOf();
    const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
    const ratio = r.width ? x / r.width : 0;
    const target = startMs + ratio * (endMs - startMs);
    let best = rows[0], bestD = Math.abs(rows[0].t - target);
    for (const row of rows) {
      const d = Math.abs(row.t - target);
      if (d < bestD) { best = row; bestD = d; }
    }
    replaceChildrenSafe(tooltip, [spanText('strong', formatTooltipClock(best.t)), spanText('span', `↑ ${fmtRate(best.up)}`), spanText('span', `↓ ${fmtRate(best.down)}`)]);
    tooltip.style.display = 'block';
    tooltip.style.left = `${Math.max(12, Math.min(r.width - 140, x + 10))}px`;
    tooltip.style.top = `56px`;
  };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('mouseenter', move);
  svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

function attachPingPointTooltip(canvas, datasets = [], axisBounds = null) {
  if (!canvas || !Array.isArray(datasets)) return;
  const card = canvas.closest('.ping-multi-card') || canvas.parentElement;
  if (!card) return;
  card.querySelector('.ping-point-tooltip')?.remove();
  const tip = document.createElement('div');
  tip.className = 'ping-point-tooltip';
  tip.style.display = 'none';
  tip.style.position = 'absolute';
  tip.style.zIndex = '20';
  tip.style.pointerEvents = 'none';
  tip.style.minWidth = '190px';
  tip.style.padding = '8px 10px';
  tip.style.border = '1px solid rgba(98,245,238,.42)';
  tip.style.borderRadius = '10px';
  tip.style.background = 'rgba(3,18,28,.95)';
  tip.style.color = '#dffcff';
  tip.style.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  tip.style.boxShadow = '0 10px 28px rgba(0,0,0,.32)';
  card.style.position = card.style.position || 'relative';
  card.appendChild(tip);
  const findNearest = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const xRatio = rect.width ? (ev.clientX - rect.left) / rect.width : 0;
    const yRatio = rect.height ? (ev.clientY - rect.top) / rect.height : 0;
    const xMin = axisBounds?.min ?? (Date.now() - 12 * 60 * 60 * 1000);
    const xMax = axisBounds?.max ?? Date.now();
    const t = xMin + Math.max(0, Math.min(1, xRatio)) * (xMax - xMin);
    let best = null;
    for (const ds of datasets) {
      for (const p of (ds.data || [])) {
        const dx = Math.abs((Number(p.x) - t) / Math.max(1, xMax - xMin));
        const yValue = Math.max(0, Math.min(PING_AXIS_STEPS_MS.length - 1, (1 - yRatio) * (PING_AXIS_STEPS_MS.length - 1)));
        const dy = Math.abs((Number(p.y) - yValue) / Math.max(1, PING_AXIS_STEPS_MS.length - 1));
        const score = dx * 2.2 + dy;
        if (!best || score < best.score) best = { ...p, dsLabel: ds.label, score };
      }
    }
    return best;
  };
  const show = (ev) => {
    const p = findNearest(ev);
    if (!p || p.score > 0.18) { tip.style.display = 'none'; return; }
    const lines = [
      spanText('b', p.dsLabel || p.label || 'PING'),
      spanText('span', `时间：${formatTooltipClock(p.x)}`),
      spanText('span', `延迟：${Number(p.rawMs || 0).toFixed(1)} ms`),
      spanText('span', `丢包：${Number(p.lossPct || 0).toFixed(0)}%`),
      spanText('span', `协议：${p.protocol || 'icmp'}`),
    ];
    replaceChildrenSafe(tip, lines);
    const cardRect = card.getBoundingClientRect();
    tip.style.display = 'block';
    tip.style.left = `${Math.max(10, Math.min(cardRect.width - 210, ev.clientX - cardRect.left + 12))}px`;
    tip.style.top = `${Math.max(42, Math.min(cardRect.height - 120, ev.clientY - cardRect.top + 12))}px`;
  };
  canvas.addEventListener('mousemove', show);
  canvas.addEventListener('mouseenter', show);
  canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  window.__DBG__.DETAIL_PING_TOOLTIP_ATTACHED = true;
}

function aggregatePointSeriesForDisplay(points = [], bucketMs = 30 * 1000) {
  const buckets = new Map();
  for (const point of (Array.isArray(points) ? points : [])) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const bucket = Math.floor(x / bucketMs) * bucketMs;
    const entry = buckets.get(bucket) || { x: bucket, sum: 0, min: y, max: y, count: 0, rawX: x };
    entry.sum += y;
    entry.min = Math.min(entry.min, y);
    entry.max = Math.max(entry.max, y);
    entry.count += 1;
    entry.rawX = x;
    buckets.set(bucket, entry);
  }
  return Array.from(buckets.values()).sort((a, b) => a.x - b.x).map(entry => ({
    x: entry.x,
    rawX: entry.rawX,
    y: entry.count ? entry.sum / entry.count : 0,
    minY: entry.min,
    maxY: entry.max,
    samples: entry.count,
  }));
}

function aggregateRateRowsForDisplay(rows = [], bucketMs = 60 * 1000) {
  const buckets = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const x = Number(row?.x);
    if (!Number.isFinite(x)) continue;
    const bucket = Math.floor(x / bucketMs) * bucketMs;
    const entry = buckets.get(bucket) || { x: bucket, lastX: -Infinity, upLast: 0, downLast: 0, upMax: 0, downMax: 0, count: 0 };
    const up = Math.max(0, Number(row.up) || 0);
    const down = Math.max(0, Number(row.down) || 0);
    if (x >= entry.lastX) {
      entry.lastX = x;
      entry.upLast = up;
      entry.downLast = down;
    }
    entry.upMax = Math.max(entry.upMax, up);
    entry.downMax = Math.max(entry.downMax, down);
    entry.count += 1;
    buckets.set(bucket, entry);
  }
  return Array.from(buckets.values()).sort((a, b) => a.x - b.x).map(entry => ({
    x: entry.x,
    rawX: Number.isFinite(entry.lastX) ? entry.lastX : entry.x,
    up: entry.upLast,
    down: entry.downLast,
    upMax: entry.upMax,
    downMax: entry.downMax,
    samples: entry.count,
  }));
}

export async function renderDetailMonitorCharts({ chartLabels = [], upSeries = [], downSeries = [], pingData = null, probeLabels = [], cpuSeries = [], ramSeries = [], probeRows = [], pingTargetsData = null, pingTargetHistoryData = null, latestServer = null, detailDays = 0 }, deps) {
  const { detailCharts, rowTimeMs, formatHourTickWithDate, formatTooltipClock, telemetryTooltipTime, seriesWindowFromRows, freshnessWindowFromRows, adaptiveRollingBounds, fitSeriesToRollingAxis, buildPingDatasets, accumulatingAxisBoundsFromTimes, fmtRate, pingStepLabel, PING_AXIS_STEPS_MS, latestTimelineMs, getDetailPingSampleCache } = deps;
  const networkCanvas = document.getElementById('detailNetworkChart');
  const cpuCanvas = document.getElementById('detailCpuChart');
  const memoryCanvas = document.getElementById('detailMemoryChart');
  const freshnessCanvas = document.getElementById('detailFreshnessChart');
  const pingCanvas = document.getElementById('detailPingChart');
  if (!networkCanvas && !cpuCanvas && !memoryCanvas && !freshnessCanvas && !pingCanvas) return;

  const Chart = await detailCharts.ready();

  detailCharts.destroy('detailBandwidthChart');
  detailCharts.destroy('detailNetworkChart');
  detailCharts.destroy('detailCpuChart');
  detailCharts.destroy('detailMemoryChart');
  detailCharts.destroy('detailFreshnessChart');
  detailCharts.destroy('detailPingChart');

  const networkCtx = networkCanvas?.getContext('2d');
  const cpuCtx = cpuCanvas?.getContext('2d');
  const memoryCtx = memoryCanvas?.getContext('2d');
  cpuSeries = ensureDenseSeries(cpuSeries).map((v) => Math.min(100, v));
  ramSeries = ensureDenseSeries(ramSeries).map((v) => Math.min(100, v));
  upSeries = ensureDenseSeries(upSeries);
  downSeries = ensureDenseSeries(downSeries);
  chartLabels = chartLabels.length ? chartLabels : upSeries.map((_, i) => `T${String(i + 1).padStart(2, '0')}`);
  probeLabels = probeLabels.length ? probeLabels : cpuSeries.map((_, i) => `P${String(i + 1).padStart(2, '0')}`);
  const xTickFmt = (v) => formatHourTickWithDate(v);
  detailDays = Math.max(0, Math.min(7, Number(detailDays ?? window.__DBG__.DETAIL_HISTORY_DAYS ?? 0) || 0));
  const detailBucketMinutes = detailDays === 0 ? 0 : ({ 1: 5, 2: 10, 3: 15, 4: 20, 5: 30, 6: 30, 7: 60 })[detailDays] || 5;
  const detailBucketMs = detailDays === 0 ? 1000 : detailBucketMinutes * 60 * 1000;
  const telemetryHours = detailDays === 0 ? 2 : detailDays * 24;
  window.__DBG__.DETAIL_CHART_BUCKET = { days: detailDays, bucketMinutes: detailBucketMinutes, bucketMs: detailBucketMs };
  const cpu12hSeries = seriesWindowFromRows(probeRows, 'cpu_use', telemetryHours, latestServer);
  const ram12hSeries = seriesWindowFromRows(probeRows, 'ram_use', telemetryHours, latestServer);
  const fresh12hSeries = freshnessWindowFromRows(probeRows, telemetryHours, latestServer);
  const freshnessMax = Math.max(6, Math.ceil(Math.max(...fresh12hSeries.map(point => Number(point.y) || 0), 0) + 1));
  const pingHours = detailDays === 0 ? 12 : detailDays * 24;
  const ping24hDatasets = buildPingDatasets(probeRows, pingHours, pingTargetsData, pingTargetHistoryData);
  const pingAxisBounds = accumulatingAxisBoundsFromTimes(ping24hDatasets.flatMap(ds => (ds.data || []).map(p => p.x)), pingHours, 2 * 60 * 1000);
  const axis24h = Array.from({ length: 5 }, (_, i) => pingAxisBounds.min + (i / 4) * (pingAxisBounds.max - pingAxisBounds.min));
  const axis12hBounds = adaptiveRollingBounds([cpu12hSeries, ram12hSeries, fresh12hSeries], telemetryHours);
  const cpuBuckets = aggregatePointSeriesForDisplay(cpu12hSeries, detailBucketMs);
  const ramBuckets = aggregatePointSeriesForDisplay(ram12hSeries, detailBucketMs);
  const freshBuckets = aggregatePointSeriesForDisplay(fresh12hSeries, detailBucketMs);
  const cpuDisplaySeries = fitSeriesToRollingAxis(cpuBuckets, axis12hBounds, 300);
  const ramDisplaySeries = fitSeriesToRollingAxis(ramBuckets, axis12hBounds, 300);
  const freshDisplaySeries = fitSeriesToRollingAxis(freshBuckets, axis12hBounds, 300);
  const label12h = cpuDisplaySeries.map(r => r.x);
  const smallChartXScale = () => ({
    type: 'linear',
    min: axis12hBounds.min,
    max: axis12hBounds.max,
    afterFit: (scale) => { scale.paddingLeft = 0; scale.paddingRight = 0; },
    ticks: { color: '#8ab5bd', stepSize: axis12hBounds.step, callback: (v) => xTickFmt(v), maxRotation: 0, autoSkip: false, font: { size: 8 }, padding: 10 },
    offset: false,
    bounds: 'ticks',
    grid: { color: 'rgba(98,245,238,0.13)' },
    border: { color: 'rgba(98,245,238,.18)' }
  });
  const fixedSmallY = (scale) => { scale.width = 28; };
  const networkHours = detailDays === 0 ? 12 : detailDays * 24;
  const networkNow = Date.now();
  const networkStart = networkNow - networkHours * 60 * 60 * 1000;
  const probeNetworkRows = (Array.isArray(probeRows) ? probeRows : []).map((row) => {
    const x = Number(row?.__timeMs) || rowTimeMs(row, NaN);
    const hasUp = row?.net_up != null && row?.net_up !== '';
    const hasDown = row?.net_down != null && row?.net_down !== '';
    return { x, up: hasUp ? Number(row.net_up) : NaN, down: hasDown ? Number(row.net_down) : NaN, source: 'agent-probe' };
  }).filter(r => Number.isFinite(r.x) && r.x >= networkStart && r.x <= networkNow + 60 * 1000 && (Number.isFinite(r.up) || Number.isFinite(r.down)))
    .sort((a, b) => a.x - b.x);
  const networkN = Math.max(upSeries.length, downSeries.length, chartLabels.length);
  const networkLabels = Array.isArray(chartLabels) ? chartLabels : [];
  const historyNetworkRows = Array.from({ length: networkN }).map((_, i) => {
    const label = networkLabels[i];
    const parsed = rowTimeMs({ ts: label, time: label, timestamp: label, created_at: label }, NaN);
    return { x: parsed, up: Number(upSeries[i] || 0), down: Number(downSeries[i] || 0), source: 'traffic-history' };
  }).filter(r => Number.isFinite(r.x) && r.x >= networkStart && r.x <= networkNow + 60 * 1000).sort((a, b) => a.x - b.x);
  const networkRows = probeNetworkRows.length ? probeNetworkRows : historyNetworkRows;
  const networkBuckets = aggregateRateRowsForDisplay(networkRows, detailBucketMs);
  const networkAxisBounds = accumulatingAxisBoundsFromTimes(networkBuckets.map(r => r.x), networkHours);
  const networkUpDisplay = fitSeriesToRollingAxis(networkBuckets.map(r => ({ x: r.rawX || r.x, rawX: r.rawX || r.x, y: r.up, maxY: r.upMax, samples: r.samples })), networkAxisBounds, 288);
  const networkDownDisplay = fitSeriesToRollingAxis(networkBuckets.map(r => ({ x: r.rawX || r.x, rawX: r.rawX || r.x, y: r.down, maxY: r.downMax, samples: r.samples })), networkAxisBounds, 288);
  const networkUpEqualDisplay = expandSinglePointSeries(networkEqualStepSeries(networkUpDisplay));
  const networkDownEqualDisplay = expandSinglePointSeries(networkEqualStepSeries(networkDownDisplay));
  const networkStepTicks = NETWORK_EQUAL_STEP_AXIS.map((_, index) => index);
  if (networkCtx) {
    const baseOptions = makeHudChartOptions(5, '');
    detailCharts._register('detailNetworkChart', new Chart(networkCtx, {
      type: 'line',
      data: {
        datasets: [
          { label: '上行', parsing: false, data: networkUpEqualDisplay, borderColor: '#68f6ff', backgroundColor: 'transparent', fill: false, tension: 0.18, pointRadius: visiblePointRadius(networkUpEqualDisplay, 4), pointHoverRadius: 6, borderWidth: 3.2 },
          { label: '下行', parsing: false, data: networkDownEqualDisplay, borderColor: '#ffd66b', backgroundColor: 'transparent', fill: false, tension: 0.18, pointRadius: visiblePointRadius(networkDownEqualDisplay, 4), pointHoverRadius: 6, borderWidth: 3.2 },
        ]
      },
      options: { ...baseOptions, plugins: { ...baseOptions.plugins, legend: { display: false, labels: { color: '#bfefff', boxWidth: 10, boxHeight: 2 } }, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => items[0] ? telemetryTooltipTime(items[0]) : '', label: (item) => `${item.dataset.label}: ${fmtRate(Number(item.raw.rawY ?? item.raw.y ?? 0))}${Number.isFinite(Number(item.raw.rawMaxY)) ? ` · 峰值 ${fmtRate(Number(item.raw.rawMaxY))}` : ''}${Number(item.raw.samples) > 1 ? ` · ${Number(item.raw.samples)}个采样点聚合` : ''}` } } }, scales: { x: { type: 'linear', min: networkAxisBounds.min, max: networkAxisBounds.max, ticks: { color: '#45676c', stepSize: Math.max(60 * 1000, Math.round((networkAxisBounds.max - networkAxisBounds.min) / (isDetailMobileChart() ? 3 : 4))), callback: (v) => xTickFmt(v), maxRotation: 0, autoSkip: isDetailMobileChart(), maxTicksLimit: isDetailMobileChart() ? 4 : undefined, font: { size: isDetailMobileChart() ? 7 : 9, weight: '700' } }, grid: { color: 'rgba(55,95,101,0.20)' }, border: { color: 'rgba(55,95,101,.30)' } }, y: { ...baseOptions.scales.y, min: 0, max: NETWORK_EQUAL_STEP_AXIS.length - 1, afterBuildTicks: (axis) => { axis.ticks = networkStepTicks.map(value => ({ value })); }, ticks: { color: '#6fa4ad', callback: (v) => networkEqualStepLabel(v), font: { size: isDetailMobileChart() ? 8 : 11, weight: '800' }, padding: isDetailMobileChart() ? 4 : 8, maxTicksLimit: isDetailMobileChart() ? 5 : NETWORK_EQUAL_STEP_AXIS.length }, afterFit(axis){ if (isDetailMobileChart()) axis.width = Math.max(axis.width, 48); } } } }
    }));
  }
  if (cpuCtx) {
    detailCharts._register('detailCpuChart', new Chart(cpuCtx, {
      type: 'line',
      data: {
        labels: label12h,
        datasets: [{
          label: 'CPU %',
          parsing: false,
          data: cpuDisplaySeries,
          borderColor: '#9bd3ff',
          backgroundColor: 'rgba(127,196,255,0.20)',
          fill: true,
          tension: 0.24,
          pointRadius: visiblePointRadius(cpuDisplaySeries, 3.5),
          pointHoverRadius: 6,
          borderWidth: 3,
        }]
      },
      options: { ...makeHudChartOptions(5, '%'), plugins: { ...makeHudChartOptions(5, '%').plugins, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => items[0] ? telemetryTooltipTime(items[0]) : '', label: (item) => `CPU ${Number(item.raw.y || 0).toFixed(1)}%` } } }, scales: { x: smallChartXScale(), y: { ...makeHudChartOptions(5, '%').scales.y, afterFit: fixedSmallY, min: 0, max: 100 } } }
    }));
  }

  if (memoryCtx) {
    detailCharts._register('detailMemoryChart', new Chart(memoryCtx, {
      type: 'line',
      data: {
        labels: label12h,
        datasets: [{
          label: 'Memory %',
          parsing: false,
          data: ramDisplaySeries,
          borderColor: '#ffd979',
          backgroundColor: 'rgba(246,201,111,0.22)',
          fill: true,
          tension: 0.24,
          pointRadius: visiblePointRadius(ramDisplaySeries, 3.5),
          pointHoverRadius: 6,
          borderWidth: 3,
        }]
      },
      options: { ...makeHudChartOptions(5, '%'), plugins: { ...makeHudChartOptions(5, '%').plugins, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => items[0] ? telemetryTooltipTime(items[0]) : '', label: (item) => `内存 ${Number(item.raw.y || 0).toFixed(1)}%` } } }, scales: { x: smallChartXScale(), y: { ...makeHudChartOptions(5, '%').scales.y, afterFit: fixedSmallY, min: 0, max: 100 } } }
    }));
  }


  if (freshnessCanvas) {
    const ctx = freshnessCanvas.getContext('2d');
    detailCharts._register('detailFreshnessChart', new Chart(ctx, {
      type: 'line',
      data: { datasets: [{ label: 'Freshness s', parsing: false, data: freshDisplaySeries, borderColor: '#8dffd0', backgroundColor: 'rgba(125,255,193,0.20)', fill: true, tension: 0.18, pointRadius: visiblePointRadius(freshDisplaySeries, 3.5), pointHoverRadius: 6, borderWidth: 3 }] },
      options: { ...makeHudChartOptions(5, 's'), plugins: { ...makeHudChartOptions(5, 's').plugins, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => telemetryTooltipTime(items[0]), label: (item) => `采样间隔 ${Number(item.raw.y || 0).toFixed(1)}s` } } }, scales: { x: smallChartXScale(), y: { ...makeHudChartOptions(5, 's').scales.y, afterFit: fixedSmallY, min: 0, max: freshnessMax } } }
    }));
  }

  if (pingCanvas) {
    const ctx = pingCanvas.getContext('2d');
    const hasPingPoints = ping24hDatasets.some(ds => Array.isArray(ds.data) && ds.data.length);
    const pingEmptyPlugin = {
      id: 'pingEmptyState',
      afterDraw(chart) {
        if (hasPingPoints) return;
        const area = chart.chartArea;
        if (!area) return;
        const targets = (pingTargetsData?.targets || []);
        const loss = targets.length ? Number(targets[0]?.stats?.loss_pct ?? NaN) : NaN;
        chart.ctx.save();
        chart.ctx.fillStyle = 'rgba(235,252,255,.92)';
        chart.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        chart.ctx.textAlign = 'center';
        chart.ctx.textBaseline = 'middle';
        chart.ctx.fillText(pingTargetsData?.unavailable ? '暂无真实节点侧互探采样' : (targets.length ? '正在累计真实 ICMP 采样点' : '暂无有效 PING 延迟数据'), (area.left + area.right) / 2, (area.top + area.bottom) / 2 - 8);
        chart.ctx.fillStyle = 'rgba(102,141,154,.92)';
        chart.ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        chart.ctx.fillText(pingTargetsData?.unavailable ? '已停止主控代测，等待 agent 上报' : (Number.isFinite(loss) ? `当前探测失败 / 丢包 ${loss.toFixed(0)}%` : '等待探测样本'), (area.left + area.right) / 2, (area.top + area.bottom) / 2 + 12);
        chart.ctx.restore();
      }
    };
    detailCharts._register('detailPingChart', new Chart(ctx, {
      type: 'line',
      data: { datasets: ping24hDatasets.map(ds => ({ ...ds, parsing: false })) },
      plugins: [pingEmptyPlugin],
      options: { ...makeHudChartOptions(5, 'ms'), plugins: { ...makeHudChartOptions(5, 'ms').plugins, legend: { display: false, labels: { color: '#bfefff', boxWidth: 10, boxHeight: 2 } }, tooltip: { enabled: hasPingPoints, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => items[0] ? `采样时间 ${formatTooltipClock(items[0].raw.x)}` : '', label: (item) => `${item.dataset.label}: ${Number(item.raw.rawMs ?? 0).toFixed(1)} ms`, afterLabel: (item) => `协议 ${item.raw.protocol || 'icmp'} · 丢包 ${Number(item.raw.lossPct ?? 0).toFixed(0)}%` } } }, scales: { x: { type: 'linear', min: axis24h[0], max: axis24h[4], ticks: { color: '#8ab5bd', stepSize: 3 * 60 * 60 * 1000, callback: (v) => xTickFmt(v), maxRotation: 0, autoSkip: isDetailMobileChart(), maxTicksLimit: isDetailMobileChart() ? 4 : undefined, font: { size: isDetailMobileChart() ? 7 : 8 } }, grid: { color: 'rgba(98,245,238,0.13)' }, border: { color: 'rgba(98,245,238,.18)' } }, y: { ...makeHudChartOptions(5, 'ms').scales.y, min: 0, max: PING_AXIS_STEPS_MS.length - 1, ticks: { color: '#8ab5bd', stepSize: 1, callback: (v) => pingStepLabel(v), font: { size: isDetailMobileChart() ? 8 : 9 }, maxTicksLimit: isDetailMobileChart() ? 5 : undefined }, afterFit(axis){ if (isDetailMobileChart()) axis.width = Math.max(axis.width, 44); } } } }
    }));
    attachPingPointTooltip(pingCanvas, ping24hDatasets, { min: pingAxisBounds.min, max: pingAxisBounds.max });
  }
  try {
    window.__DBG__.DETAIL_CHART_DEBUG = {
      cpuPoints: cpu12hSeries.length,
      ramPoints: ram12hSeries.length,
      freshPoints: fresh12hSeries.length,
      networkSeries: { raw: networkRows.length, source: networkRows[0]?.source || null, latestRaw: networkRows[networkRows.length - 1] || null, buckets: networkBuckets.length, up: networkUpEqualDisplay.length, down: networkDownEqualDisplay.length, upFirst: networkUpEqualDisplay[0] || null, upLast: networkUpEqualDisplay[networkUpEqualDisplay.length - 1] || null, downFirst: networkDownEqualDisplay[0] || null, downLast: networkDownEqualDisplay[networkDownEqualDisplay.length - 1] || null, axis: networkAxisBounds, yAxis: NETWORK_EQUAL_STEP_AXIS },
      pingSeries: ping24hDatasets.map(ds => ({ label: ds.label, points: ds.data.length, first: ds.data[0] || null, last: ds.data[ds.data.length - 1] || null, fill: ds.fill, pointRadius: ds.pointRadius, borderWidth: ds.borderWidth })),
      pingSampleCache: Object.fromEntries(Object.entries(getDetailPingSampleCache ? getDetailPingSampleCache() : {}).map(([k,v]) => [k, v.length])),
      probeRows: probeRows.length,
      cpuFirst: cpu12hSeries[0] || null,
      cpuLast: cpu12hSeries[cpu12hSeries.length - 1] || null,
      cpuDisplayFirst: cpuDisplaySeries[0] || null,
      cpuDisplayLast: cpuDisplaySeries[cpuDisplaySeries.length - 1] || null,
      ramFirst: ram12hSeries[0] || null,
      ramLast: ram12hSeries[ram12hSeries.length - 1] || null,
      ramDisplayFirst: ramDisplaySeries[0] || null,
      ramDisplayLast: ramDisplaySeries[ramDisplaySeries.length - 1] || null,
      displayPoints: { cpu: cpuDisplaySeries.length, ram: ramDisplaySeries.length, fresh: freshDisplaySeries.length, cpuBuckets: cpuBuckets.length, ramBuckets: ramBuckets.length, freshBuckets: freshBuckets.length },
      axis12hBounds,
      telemetryHours,
      freshnessMax,
      latestSampleMs: latestTimelineMs(probeRows, latestServer),
      pingHours,
      pingAxisBounds,
      pingTargetCount: (pingTargetsData?.targets || []).length,
      pingTargets: (pingTargetsData?.targets || []).map(t => ({ label: t.label || t.key, avg: t.stats?.avg_ms ?? null, loss: t.stats?.loss_pct ?? null, results: Array.isArray(t.results) ? t.results.length : 0 })),
      pingAxis: PING_AXIS_STEPS_MS,
      chartInstances: detailCharts?._instances ? Array.from(detailCharts._instances.keys()) : [],
    };
  } catch {}
}
