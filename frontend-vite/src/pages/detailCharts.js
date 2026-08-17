import '../globals/dashboardGlobals.js';
// Chart text is drawn into the canvas, so it is invisible to the DOM i18n pass
// and must be resolved through t() at draw time.
import { t } from '../core/preferences.js';
function ensureDenseSeries(series) {
  return (Array.isArray(series) ? series : []).map(Number).filter((v) => Number.isFinite(v));
}

function expandSinglePointSeries(points = [], deltaMs = 90 * 1000) {
  // Do not fake a short line for a single sample. Charts start drawing only after the next real agent interval.
  return Array.isArray(points) ? points : [];
}


// Shared rate-axis steps (kbps). Keep dense mid-range so a ~10Mbps peak does
// not jump straight to a 50Mbps ceiling (previous gap was 10240 -> 51200).
const DETAIL_RATE_STEPS_KBPS = [
  10, 25, 50, 100, 200, 500,
  1024, 2048, 5120, 10240, 15360, 20480, 30720, 40960,
  51200, 102400, 256000, 512000, 1024000,
];

function detailRateStepCeiling(valueKbps = 0) {
  const v = Math.max(0, Number(valueKbps) || 0);
  return DETAIL_RATE_STEPS_KBPS.find(step => v <= step) || Math.ceil(v / 102400) * 102400;
}


function detailRateStepTicks(maxKbps = 0) {
  const max = detailRateStepCeiling(maxKbps);
  const candidates = DETAIL_RATE_STEPS_KBPS.filter(v => v > 0 && v <= max);
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


// Horizontal room reserved on the right of the small telemetry charts so the
// centre-anchored terminal X tick label ("09/05, 03:42 AM") is not clipped by
// the card edge. Sized for the widest xTickFmt output at font-size 8.
// Measured: the widest xTickFmt output ("08/05, 05:19 AM") is ~59px at font-size 8,
// and Chart.js centre-anchors tick labels, so the terminal tick overhangs the plot
// area by ~30px. Reserve that half-width (plus 2px breathing room) or the tail of
// the timestamp is clipped by the card edge.
// With ticks.align='inner' the terminal label is right-aligned instead of centred,
// so only a small gutter is needed to keep it off the canvas edge.
const SMALL_X_TICK_EDGE_PAD = 6;

const NETWORK_EQUAL_STEP_AXIS = [
  { value: 0, label: '0' },
  { value: 50, label: '50K' },
  { value: 100, label: '100K' },
  { value: 200, label: '200K' },
  { value: 500, label: '500K' },
  { value: 1024, label: '1M' },
  { value: 5120, label: '5M' },
  { value: 10240, label: '10M' },
  { value: 20480, label: '20M' },
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

function percentile(values = [], p = 0.95) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const index = Math.min(clean.length - 1, Math.max(0, Math.floor((clean.length - 1) * p)));
  return clean[index];
}

function smoothMobileNetworkSeries(points = []) {
  const clean = (Array.isArray(points) ? points : []).filter(p => Number.isFinite(Number(p?.x)) && Number.isFinite(Number(p?.y))).sort((a, b) => Number(a.x) - Number(b.x));
  const rawValues = clean.map(p => Math.max(0, Number(p.y) || 0));
  const p95 = percentile(rawValues, 0.95);
  const cap = Math.max(25, p95 * 1.35, percentile(rawValues, 0.80) * 1.8);
  return clean.map((p, i) => {
    const lo = Math.max(0, i - 2);
    const hi = Math.min(clean.length - 1, i + 2);
    const slice = clean.slice(lo, hi + 1).map(v => Math.max(0, Number(v.y) || 0));
    const avg = slice.reduce((a, b) => a + b, 0) / Math.max(1, slice.length);
    const rawY = Math.max(0, Number(p.y) || 0);
    return { ...p, rawY, rawMaxY: Number.isFinite(Number(p.maxY)) ? Number(p.maxY) : null, y: Math.min(cap, avg) };
  });
}

function isDetailMobileChart() {
  return typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
}

function telemetryEmptyStatePlugin(hasPoints, message = null) {
  // Resolved lazily via t(): a default literal here would leak the source
  // language at every call site that omits the argument.
  message = message || t('chartNoPersistedSamples');
  return {
    id: 'detailTelemetryEmptyState',
    afterDraw(chart) {
      // Emptiness must be judged from what the chart currently holds, not from a
      // boolean captured when the plugin was built. Persisted history is empty on
      // first paint, so the captured flag said "empty" forever while the 5s live
      // append drew a real line underneath — the overlay and the data contradicted
      // each other on screen. Live-appended points count as data.
      const live = (chart.data?.datasets || []).some((ds) => Array.isArray(ds?.data) && ds.data.length > 0);
      if (hasPoints || live || !chart.chartArea) return;
      const { ctx, chartArea: area } = chart;
      ctx.save();
      ctx.fillStyle = 'rgba(235,252,255,.92)';
      ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(message, (area.left + area.right) / 2, (area.top + area.bottom) / 2);
      ctx.restore();
    },
  };
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
      x: { reverse: false, ticks: { color: '#8ab5bd', maxRotation: 0, autoSkip: true, maxTicksLimit: tickLimit, font: { size: mobile ? 7 : 8 } }, grid: { color: 'rgba(98,245,238,0.13)' }, border: { color: 'rgba(98,245,238,.18)' } },
      y: {
        afterFit(axis){ if (mobile) axis.width = Math.max(axis.width, 44); },
        ticks: {
          color: '#8ab5bd',
          autoSkip: true,
          maxTicksLimit: mobile ? 4 : undefined,
          font: { size: mobile ? 7 : 8 },
          padding: mobile ? 4 : 3,
          callback: (v) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return '';
            // Keep percent/ms labels short but never clip 100% into "00".
            if (yUnit === '%') return `${Math.round(n)}%`;
            if (yUnit === 'ms') return n >= 100 ? `${Math.round(n)}` : `${Number(n.toFixed(n >= 10 ? 0 : 1))}`;
            if (yUnit === 's') return `${Number(n.toFixed(n >= 10 ? 0 : 1))}${yUnit}`;
            return yUnit ? `${n}${yUnit}` : n;
          },
        },
        grid: { color: 'rgba(98,245,238,0.15)' },
        border: { color: 'rgba(98,245,238,.18)' },
      }
    }
  };
}

function niceAxisMax(value = 0, { minMax = 1, pad = 1.2, steps = null } = {}) {
  const v = Math.max(0, Number(value) || 0);
  const target = Math.max(minMax, v * pad);
  if (Array.isArray(steps) && steps.length) {
    const hit = steps.find((step) => target <= step);
    if (hit != null) return hit;
  }
  if (target <= 1) return 1;
  const exp = Math.floor(Math.log10(target));
  const base = 10 ** exp;
  const mult = target / base;
  const niceMult = mult <= 1 ? 1 : mult <= 2 ? 2 : mult <= 5 ? 5 : 10;
  return niceMult * base;
}

function adaptivePercentYScale(fixedSmallY) {
  return {
    ...makeHudChartOptions(5, '%').scales.y,
    afterFit: (scale) => {
      fixedSmallY(scale);
      // 28px clips "100%" into "00"; keep room for 3-digit percent labels.
      scale.width = Math.max(scale.width || 0, 40);
    },
    min: 0,
    max: 100,
    ticks: {
      ...makeHudChartOptions(5, '%').scales.y.ticks,
      stepSize: 25,
      maxTicksLimit: 5,
      autoSkip: false,
      callback: (v) => `${Math.round(Number(v) || 0)}%`,
    },
  };
}

// Rate axis for the network chart.
//
// Two failure modes to avoid, and a linear axis cannot dodge both at once:
//   * Scale to the absolute peak and a single burst (2.0 MB/s against a 25 KB/s
//     baseline) flattens real traffic onto the bottom 1-2% of the plot — reads as
//     "no data".
//   * Scale to p95 and the burst is drawn ABOVE the axis maximum, so Chart.js
//     clips it flat against the top edge — data visibly leaving the chart, which
//     is what "y 轴自适应怎么还会超出图表" is about.
//
// So when the tail really is an outlier (>3x p95) switch to a square-root value
// axis: the axis still covers the true peak (nothing is clipped) while the
// baseline band gets a usable share of the height. Returns the scale plus the
// transform the caller must apply to plotted `y` values; `rawY`/`rawMaxY` stay
// untouched so tooltips keep reporting real rates.
function adaptiveRateYScale(values = [], baseY = {}, fmtRateFn) {
  const clean = (Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const sorted = clean.slice().sort((a, b) => a - b);
  const pick = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : 0);
  const p95 = pick(0.95);
  const absolutePeak = sorted.length ? sorted[sorted.length - 1] : 0;
  const compress = p95 > 0 && absolutePeak > p95 * 3;
  const label = (kbps) => (typeof fmtRateFn === 'function' ? fmtRateFn(Math.max(0, Number(kbps) || 0)) : String(kbps));
  const common = {
    color: '#6fa4ad',
    autoSkip: false,
    maxTicksLimit: 5,
    padding: 6,
    font: { size: isDetailMobileChart() ? 8 : 10, weight: '800' },
  };
  const afterFit = (axis) => { axis.width = Math.max(axis.width || 0, isDetailMobileChart() ? 48 : 56); };

  // The ceiling always covers the real peak in both modes -> nothing is clipped.
  const rawMax = niceAxisMax(absolutePeak, { minMax: 10, pad: 1.15, steps: DETAIL_RATE_STEPS_KBPS });

  if (!compress) {
    const max = Math.ceil(rawMax / 4) * 4;
    return {
      toPlot: (kbps) => Math.max(0, Number(kbps) || 0),
      mode: 'linear-kbps',
      rawMax: max,
      scale: {
        ...baseY,
        min: 0,
        max,
        suggestedMax: max,
        // stepSize + the matching max pins the count at 5 (0 .. max inclusive).
        ticks: { ...common, stepSize: max / 4, callback: (v) => label(v) },
        afterFit,
      },
    };
  }

  // sqrt space: 4 equal gaps land on raw values rawMax*(k/4)^2, so the low band
  // (where the baseline lives) gets the first gridline at 1/16 of the peak.
  const axisMax = Math.sqrt(rawMax);
  return {
    toPlot: (kbps) => Math.sqrt(Math.max(0, Number(kbps) || 0)),
    mode: 'sqrt-kbps',
    rawMax,
    scale: {
      ...baseY,
      min: 0,
      max: axisMax,
      suggestedMax: axisMax,
      ticks: {
        ...common,
        stepSize: axisMax / 4,
        // Ticks are evenly spaced in sqrt space; label them with the real rate.
        callback: (v) => label(Math.pow(Number(v) || 0, 2)),
      },
      afterFit,
    },
  };
}

function adaptiveMsYScale(values = [], baseY = {}) {
  const clean = (Array.isArray(values) ? values : []).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  const peak = clean.length ? Math.max(...clean) : 0;
  const max = niceAxisMax(peak, {
    minMax: 50,
    pad: 1.3,
    steps: [20, 50, 100, 150, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000],
  });
  return {
    ...baseY,
    min: 0,
    max,
    suggestedMax: max,
    ticks: {
      color: '#8ab5bd',
      maxTicksLimit: isDetailMobileChart() ? 4 : 5,
      padding: 4,
      font: { size: isDetailMobileChart() ? 8 : 9 },
      callback: (v) => {
        const n = Number(v) || 0;
        return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}s` : `${Math.round(n)}ms`;
      },
    },
    afterFit(axis) {
      axis.width = Math.max(axis.width || 0, isDetailMobileChart() ? 44 : 52);
    },
  };
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
    const yMin = Number(axisBounds?.yMin);
    const yMax = Number(axisBounds?.yMax);
    const useLinearY = Number.isFinite(yMin) && Number.isFinite(yMax) && yMax > yMin;
    const t = xMin + Math.max(0, Math.min(1, xRatio)) * (xMax - xMin);
    const yAtCursor = useLinearY
      ? yMin + (1 - Math.max(0, Math.min(1, yRatio))) * (yMax - yMin)
      : Math.max(0, Math.min(PING_AXIS_STEPS_MS.length - 1, (1 - yRatio) * (PING_AXIS_STEPS_MS.length - 1)));
    let best = null;
    for (const ds of datasets) {
      for (const p of (ds.data || [])) {
        const dx = Math.abs((Number(p.x) - t) / Math.max(1, xMax - xMin));
        const py = Number(p.rawMs ?? p.y) || 0;
        const dy = useLinearY
          ? Math.abs((py - yAtCursor) / Math.max(1, yMax - yMin))
          : Math.abs((Number(p.y) - yAtCursor) / Math.max(1, PING_AXIS_STEPS_MS.length - 1));
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
      spanText('span', `${t('chartTime')}: ${formatTooltipClock(p.x)}`),
      spanText('span', `${t('chartLatency')}: ${Number(p.rawMs || 0).toFixed(1)} ms`),
      spanText('span', `${t('chartLoss')}: ${Number(p.lossPct || 0).toFixed(0)}%`),
      spanText('span', `${t('chartProtocol')}: ${p.protocol || 'icmp'}`),
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
    // Draw at the latest real observation in each bucket, not bucket start.
    // Otherwise a 5-minute bucket always leaves an artificial blank tail.
    x: entry.rawX,
    rawX: entry.rawX,
    y: entry.count ? entry.sum / entry.count : 0,
    minY: entry.min,
    maxY: entry.max,
    samples: entry.count,
  }));
}

// Bucket means alone hide what happened *inside* each bucket. A 30s bucket over
// a 5s source cadence averages six samples into one point, so real CPU jitter
// renders as a smooth ribbon and a flat-looking process count reads as "no
// data". The network chart kept its spikes only because it plots a
// representative value rather than a mean.
//
// Draw the per-bucket min/max as a translucent envelope *behind* the mean line:
// the trend stays readable and the peaks/valleys that the mean swallowed become
// visible again. Returns [] when every bucket holds a single sample (nothing to
// show), so single-sample cold starts keep the plain filled-line look.
function envelopeDatasets(points = [], bandColour = 'rgba(255,255,255,0.16)') {
  const list = Array.isArray(points) ? points : [];
  const hasSpread = list.some((p) => {
    const lo = Number(p?.minY);
    const hi = Number(p?.maxY);
    return Number.isFinite(lo) && Number.isFinite(hi) && hi - lo > 0;
  });
  if (!hasSpread) return [];
  const band = (key) => list.map((p) => ({
    ...p,
    // Keep the mean on the point so the tooltip can still report it.
    envMean: Number(p?.y),
    y: Number.isFinite(Number(p?.[key])) ? Number(p[key]) : Number(p?.y) || 0,
  }));
  const common = {
    parsing: false,
    borderColor: 'transparent',
    borderWidth: 0,
    pointRadius: 0,
    pointHoverRadius: 0,
    tension: 0.24,
    // Envelope must never win the z-order fight against the mean line.
    order: 3,
  };
  return [
    // 'fill: +1' fills toward the next dataset (the min band), producing the
    // shaded region between per-bucket min and max.
    { ...common, label: ENVELOPE_LABEL, data: band('maxY'), backgroundColor: bandColour, fill: '+1' },
    { ...common, label: ENVELOPE_LABEL, data: band('minY'), backgroundColor: 'transparent', fill: false },
  ];
}

// Envelope datasets are decoration, not series: keep them out of tooltips.
const ENVELOPE_LABEL = '__envelope';
const tooltipSkipsEnvelope = (item) => String(item?.dataset?.label || '') !== ENVELOPE_LABEL;

// "8.4% (6.9–11.3%)" — the parenthesised span needs no translation, so the
// per-bucket range can be surfaced without adding a key to all 8 locales.
const spreadSuffix = (raw, fmt) => {
  const lo = Number(raw?.minY);
  const hi = Number(raw?.maxY);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi - lo <= 0) return '';
  return ` (${fmt(lo)}–${fmt(hi)})`;
};

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

export function appendDetailLiveMetrics(live, deps) {
  const { detailCharts } = deps || {};
  let timestampText = String(live?.updated_at || '').trim();
  // API timestamps are UTC; Date.parse would interpret a timezone-less ISO value
  // as browser-local time and make live freshness appear stale in some zones.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(timestampText)) timestampText += 'Z';
  const timestamp = Date.parse(timestampText);
  if (!detailCharts?._instances || !Number.isFinite(timestamp)) return false;
  // Initial history owns chart creation. If that render has not completed yet,
  // leave the live point for the next history response instead of constructing
  // a one-point chart that appears to grow backwards.
  const initialChartIds = ['detailCpuChart', 'detailMemoryChart', 'detailProcessCountChart'];
  if (initialChartIds.some((id) => !detailCharts._instances.get(id))) return false;

  const append = (id, value, formatter) => {
    const chart = detailCharts._instances.get(id);
    const numeric = Number(value);
    if (!chart || !Number.isFinite(numeric)) return false;
    const dataset = chart.data?.datasets?.[0];
    if (!dataset) return false;
    const points = Array.isArray(dataset.data) ? dataset.data : (dataset.data = []);
    const last = points[points.length - 1];
    if (Number(last?.x) >= timestamp) return false;
    points.push({ x: timestamp, rawX: timestamp, y: formatter(numeric), samples: 1 });
    const x = chart.options?.scales?.x;
    if (x) {
      // This runs every 5s and OVERWRITES whatever bounds the render pass chose,
      // so the collapse guard has to live here too. Pinning min to points[0].x
      // meant a chart that started with few/no persisted rows drew an axis whose
      // span equalled "how long the tab has been open": both edge ticks printed
      // the same clock label and one minute of live samples was stretched across
      // a card headed "1 hour". Anchor to the newest sample, floor the drawn span,
      // and re-derive stepSize so the 5 ticks stay distinct.
      const span = 60 * 60 * 1000;
      const now = Date.now();
      x.max = now;
      x.min = now - span;
      if (x.ticks) x.ticks.stepSize = span / 4;
      // The render pass writes DETAIL_CHART_DEBUG.smallXBounds, but this 5s path
      // overwrites the axis afterwards, so that snapshot cannot prove what is on
      // screen. Record the post-append bounds per chart instead.
      try {
        window.__DBG__ = window.__DBG__ || {};
        window.__DBG__.DETAIL_LIVE_AXIS = window.__DBG__.DETAIL_LIVE_AXIS || {};
        const first = Number(points[0]?.x);
        const dataSpanMs = Number.isFinite(first) ? Math.max(0, timestamp - first) : 0;
        window.__DBG__.DETAIL_LIVE_AXIS[id] = {
          at: new Date(timestamp).toISOString(),
          spanMs: span,
          spanMin: Math.round((span / 60000) * 100) / 100,
          stepMs: x.ticks?.stepSize || null,
          dataSpanMs,
          points: points.length,
          fixedWindow: true,
        };
      } catch {}
    }
    chart.update('none');
    return true;
  };

  const cpu = append('detailCpuChart', live.cpu_use, (v) => Math.max(0, Math.min(100, v)));
  const memory = append('detailMemoryChart', live.ram_use, (v) => Math.max(0, Math.min(100, v)));
  const process = append('detailProcessCountChart', live.process_count, (v) => Math.max(0, Math.round(v)));
  return cpu || memory || process;
}

export async function renderDetailMonitorCharts({ chartLabels = [], upSeries = [], downSeries = [], pingData = null, probeLabels = [], cpuSeries = [], ramSeries = [], probeRows = [], networkProbeRows = null, processRows = [], pingTargetsData = null, pingTargetHistoryData = null, vpsProbeTargetsData = null, vpsProbeHistoryData = null, latestServer = null, detailDays = 0 }, deps) {
  const { detailCharts, rowTimeMs, formatHourTick, formatHourTickWithDate, formatTooltipClock, telemetryTooltipTime, seriesWindowFromRows, adaptiveRollingBounds, fitSeriesToRollingAxis, buildPingDatasets, accumulatingAxisBoundsFromTimes, fmtRate, pingStepLabel, PING_AXIS_STEPS_MS, latestTimelineMs, getDetailPingSampleCache } = deps;
  const networkCanvas = document.getElementById('detailNetworkChart');
  const cpuCanvas = document.getElementById('detailCpuChart');
  const memoryCanvas = document.getElementById('detailMemoryChart');
  const processCountCanvas = document.getElementById('detailProcessCountChart');
  const pingCanvas = document.getElementById('detailPingChart');
  const globalVpsProbeCanvas = document.getElementById('detailGlobalVpsProbeChart');
  if (!networkCanvas && !cpuCanvas && !memoryCanvas && !processCountCanvas && !pingCanvas && !globalVpsProbeCanvas) return;

  const Chart = await detailCharts.ready();

  detailCharts.destroy('detailBandwidthChart');
  detailCharts.destroy('detailNetworkChart');
  detailCharts.destroy('detailCpuChart');
  detailCharts.destroy('detailMemoryChart');
  detailCharts.destroy('detailProcessCountChart');
  detailCharts.destroy('detailPingChart');
  detailCharts.destroy('detailGlobalVpsProbeChart');

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
  // The 1h telemetry charts never span a date boundary in a way the user needs
  // spelled out, and they are only ~368px wide. A full "08/05, 09:53 PM" tick is
  // ~59px in zh but far wider once en switches to a 12-hour clock, which pushed
  // the terminal label past the card edge. Time-only ticks keep them inside.
  const smallXTickFmt = (v) => formatHourTick(v);
  const requestedDetailDays = Number(detailDays ?? window.__DBG__.DETAIL_HISTORY_DAYS ?? 1);
  detailDays = [0, 1, 4, 7, 30, 90].includes(requestedDetailDays) ? requestedDetailDays : 1;
  const detailBucketMinutes = ({ 0: 0, 1: 5, 4: 20, 7: 60, 30: 60, 90: 180 })[detailDays] ?? 60;
  const detailBucketMs = detailBucketMinutes * 60 * 1000;
  const telemetryHours = 1;
  const pingHours = detailDays === 0 ? 6 : detailDays * 24;
  const networkHours = detailDays === 0 ? 6 : detailDays * 24;
  // The bucket width must come from the window a chart actually draws, not from
  // the history range picker. detailBucketMs is sized for the 1-90 day history
  // (1 day -> 5 min), so feeding it to the 1h telemetry charts collapsed ~520
  // real samples into 13 points (22 samples averaged per point) and to the 6h
  // network chart into 13 buckets. The PING chart never bucketed, which is why
  // it alone looked correct. Target a fixed point budget per chart instead and
  // never coarsen below the source sample interval.
  const sourceSampleMs = Math.max(1000, Number(window.__DBG__.DETAIL_SOURCE_SAMPLE_MS) || 5000);
  const bucketMsForWindow = (hours, targetPoints = 120) => {
    const span = hours * 60 * 60 * 1000;
    return Math.max(sourceSampleMs, Math.floor(span / Math.max(1, targetPoints)));
  };
  const telemetryBucketMs = bucketMsForWindow(telemetryHours);
  const networkBucketMs = bucketMsForWindow(networkHours);
  window.__DBG__.DETAIL_CHART_BUCKET = { days: detailDays, bucketMinutes: detailBucketMinutes, bucketMs: detailBucketMs, telemetryBucketMs, networkBucketMs, sourceSampleMs, telemetryHours, pingHours, networkHours };
  const cpu12hSeries = seriesWindowFromRows(probeRows, 'cpu_use', telemetryHours);
  const ram12hSeries = seriesWindowFromRows(probeRows, 'ram_use', telemetryHours);
  // The dedicated `metric=process_count` request is a *second* round trip, so on
  // first paint processRows is still empty and this chart rendered blank while
  // CPU/memory already had data — it looked like the process monitor never
  // loaded. The default history response already carries process_count on every
  // row, so fall back to it and let the dedicated response refine later.
  const processSeriesPrimary = seriesWindowFromRows(processRows, 'process_count', telemetryHours);
  const processSeries = processSeriesPrimary.length
    ? processSeriesPrimary
    : seriesWindowFromRows(probeRows, 'process_count', telemetryHours);
  const ping24hDatasets = buildPingDatasets(probeRows, pingHours, pingTargetsData, pingTargetHistoryData)
    .map((dataset) => ({
      ...dataset,
      data: [...(dataset.data || [])].sort((a, b) => Number(a?.x) - Number(b?.x)),
    }));
  // Anchor the PING axis to its own samples (min = max(first, last-window),
  // max = last) so the line fills edge-to-edge instead of leaving a blank tail
  // from a cold-start (dataFirst + full window) upper bound.
  const pingTimes = ping24hDatasets.flatMap(ds => (ds.data || []).map(p => Number(p.x))).filter(Number.isFinite).sort((a, b) => a - b);
  const pingAxisBounds = (() => {
    const fullSpan = pingHours * 60 * 60 * 1000;
    if (!pingTimes.length) return accumulatingAxisBoundsFromTimes([], pingHours, 2 * 60 * 1000);
    const dataFirst = pingTimes[0];
    const dataLast = pingTimes[pingTimes.length - 1];
    const min = Math.max(dataFirst, dataLast - fullSpan);
    const max = dataLast > min ? dataLast : min + fullSpan;
    return { min, max, mode: 'anchored-to-data', dataFirst, dataLast, fullSpanMs: fullSpan };
  })();
  const axis24h = Array.from({ length: 5 }, (_, i) => pingAxisBounds.min + (i / 4) * (pingAxisBounds.max - pingAxisBounds.min));
  const axis12hBounds = adaptiveRollingBounds([cpu12hSeries, ram12hSeries, processSeries], telemetryHours);
  const cpuBuckets = aggregatePointSeriesForDisplay(cpu12hSeries, telemetryBucketMs);
  const ramBuckets = aggregatePointSeriesForDisplay(ram12hSeries, telemetryBucketMs);
  const processBuckets = aggregatePointSeriesForDisplay(processSeries, telemetryBucketMs);
  const cpuDisplaySeries = fitSeriesToRollingAxis(cpuBuckets, axis12hBounds, 300);
  const ramDisplaySeries = fitSeriesToRollingAxis(ramBuckets, axis12hBounds, 300);
  const processDisplaySeries = fitSeriesToRollingAxis(processBuckets, axis12hBounds, 300);
  // Each small chart gets its OWN axis anchored to its own samples so the line
  // fills edge-to-edge and starts at the left. A single shared axis made a chart
  // whose latest/earliest sample differed from the others look truncated.
  const seriesOwnBounds = () => {
    const fullSpan = telemetryHours * 60 * 60 * 1000;
    const max = Date.now();
    const min = max - fullSpan;
    return { min, max, step: fullSpan / 4, mode: 'fixed-window-ending-now', spanMs: fullSpan };
  };
  const cpuAxisBounds = seriesOwnBounds(cpuDisplaySeries);
  const ramAxisBounds = seriesOwnBounds(ramDisplaySeries);
  const processAxisBounds = seriesOwnBounds(processDisplaySeries);
  const cpuEmptyPlugin = telemetryEmptyStatePlugin(cpuDisplaySeries.length > 0);
  const ramEmptyPlugin = telemetryEmptyStatePlugin(ramDisplaySeries.length > 0);
  const processEmptyPlugin = telemetryEmptyStatePlugin(processDisplaySeries.length > 0, t('chartWaitingAgentProcessCount'));
  const processValues = processDisplaySeries.map((point) => Number(point?.y)).filter(Number.isFinite);
  const processMinValue = processValues.length ? Math.min(...processValues) : 0;
  const processMaxValue = processValues.length ? Math.max(...processValues) : 1;
  const processPadding = processValues.length > 1 ? Math.max(1, Math.ceil((processMaxValue - processMinValue) * 0.15)) : 1;
  const processYMinRaw = Math.max(0, Math.floor(processMinValue - processPadding));
  const processYMaxRaw = Math.max(processYMinRaw + 1, Math.ceil(processMaxValue + processPadding));
  // Exactly 5 ticks like every other axis, while staying on whole processes: grow the
  // span to a multiple of 4 so `span / 4` is an integer step. `stepSize: 1` alone let the
  // tick count drift with the data range (95..100 rendered 6 labels).
  const processSpan = Math.max(4, Math.ceil((processYMaxRaw - processYMinRaw) / 4) * 4);
  const processYMin = Math.max(0, processYMaxRaw - processSpan);
  const processYMax = processYMin + processSpan;
  const processYScale = {
    ...makeHudChartOptions(5, '').scales.y,
    min: processYMin,
    max: processYMax,
    grace: 0,
    afterFit: (scale) => { fixedSmallY(scale); scale.width = Math.max(scale.width || 0, 36); },
    ticks: {
      ...makeHudChartOptions(5, '').scales.y.ticks,
      stepSize: processSpan / 4,
      autoSkip: false,
      precision: 0,
      // Plain integers: the unit belongs in the card title, not on every gridline.
      // A unit here is also unlocalizable (canvas text) and just costs axis width.
      callback: (value) => Number.isInteger(Number(value)) ? `${Math.round(Number(value))}` : '',
    },
  };
  const label12h = cpuDisplaySeries.map(r => r.x);
  const smallChartXScale = (bounds = axis12hBounds) => ({
    type: 'linear',
    reverse: false,
    min: bounds.min,
    max: bounds.max,
    // Tick labels are centre-anchored, so the terminal tick needs horizontal room
    // or its right half is clipped by the card edge ("09/05, 0…" instead of the
    // full timestamp). Zeroing both paddings removed exactly that room.
    afterFit: (scale) => { scale.paddingLeft = 0; scale.paddingRight = SMALL_X_TICK_EDGE_PAD; },
    ticks: {
      color: '#8ab5bd', stepSize: bounds.step, callback: (v) => smallXTickFmt(v), maxRotation: 0, autoSkip: false, font: { size: 8 }, padding: 10,
      // Reserving right-hand padding alone is not enough: the terminal tick is
      // centre-anchored on the last gridline, so half the ~59px timestamp still
      // overhangs the canvas and gets clipped. 'inner' pulls the first/last tick
      // labels inward (right-aligning the final one) so they stay fully readable.
      align: 'inner',
    },
    offset: false,
    bounds: 'ticks',
    grid: { color: 'rgba(98,245,238,0.13)' },
    border: { color: 'rgba(98,245,238,.18)' }
  });
  const fixedSmallY = (scale) => { scale.width = 28; };
  // CPU/RAM use a fixed raw 1h slice, while network follows the selected range.
  const networkRowsSource = Array.isArray(networkProbeRows) ? networkProbeRows : probeRows;
  const networkNow = latestTimelineMs(networkRowsSource);
  const networkStart = networkNow - networkHours * 60 * 60 * 1000;
  const probeNetworkRows = networkRowsSource.map((row) => {
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
  const networkBuckets = aggregateRateRowsForDisplay(networkRows, networkBucketMs);
  const networkMobile = isDetailMobileChart();
  // Anchor to the chart's own samples (min = max(dataFirst, dataLast-window),
  // max = dataLast) so the line fills edge-to-edge instead of leaving a blank
  // tail from a cold-start (dataFirst + full window) upper bound — same contract
  // as the CPU/memory/process/PING charts.
  const networkAxisBounds = (() => {
    const fullSpan = networkHours * 60 * 60 * 1000;
    const xs = networkBuckets.map((r) => Number(r.rawX || r.x)).filter(Number.isFinite).sort((a, b) => a - b);
    if (!xs.length) return adaptiveRollingBounds([[], []], networkHours);
    const dataFirst = xs[0];
    const dataLast = xs[xs.length - 1];
    const min = Math.max(dataFirst, dataLast - fullSpan);
    const max = dataLast > min ? dataLast : min + fullSpan;
    return { min, max, step: Math.max(60 * 1000, Math.round((max - min) / 4)), mode: 'anchored-to-data', dataFirst, dataLast, fullSpanMs: fullSpan };
  })();
  const networkUpDisplay = fitSeriesToRollingAxis(networkBuckets.map(r => ({ x: r.rawX || r.x, rawX: r.rawX || r.x, y: r.up, maxY: r.upMax, samples: r.samples })), networkAxisBounds, networkMobile ? 160 : 288);
  const networkDownDisplay = fitSeriesToRollingAxis(networkBuckets.map(r => ({ x: r.rawX || r.x, rawX: r.rawX || r.x, y: r.down, maxY: r.downMax, samples: r.samples })), networkAxisBounds, networkMobile ? 160 : 288);
  // Adaptive linear Y: use real rates (kbps), not fixed equal-step synthetic axis.
  const networkUpChartDisplay = expandSinglePointSeries(
    networkMobile ? smoothMobileNetworkSeries(networkUpDisplay) : networkUpDisplay.map((p) => ({ ...p, rawY: Number(p.y) || 0, rawMaxY: Number.isFinite(Number(p.maxY)) ? Number(p.maxY) : null }))
  );
  const networkDownChartDisplay = expandSinglePointSeries(
    networkMobile ? smoothMobileNetworkSeries(networkDownDisplay) : networkDownDisplay.map((p) => ({ ...p, rawY: Number(p.y) || 0, rawMaxY: Number.isFinite(Number(p.maxY)) ? Number(p.maxY) : null }))
  );
  // Scale the axis to the values that are actually PLOTTED (bucket means, `y`).
  // Including per-bucket peaks (`maxY`) here lets a single burst (e.g. 6.3 MB/s)
  // set the ceiling while the drawn line sits at ~20 KB/s, flattening both series
  // onto the 0 gridline — visually indistinguishable from "no data". Peaks are
  // still surfaced in the tooltip via rawMaxY.
  const networkRateValues = [
    ...networkUpDisplay.map((p) => Number(p?.y) || 0),
    ...networkDownDisplay.map((p) => Number(p?.y) || 0),
  ];

  // Hoisted so the debug block below can report the axis mode that was actually
  // chosen instead of a hardcoded string.
  let networkYDebug = { mode: 'not-rendered', rawMax: 0 };
  if (networkCtx) {
    const baseOptions = makeHudChartOptions(5, '');
    const networkY = adaptiveRateYScale(networkRateValues, baseOptions.scales.y, fmtRate);
    networkYDebug = { mode: networkY.mode, rawMax: networkY.rawMax };
    const networkYScale = networkY.scale;
    // Map plotted values into axis space (identity unless the axis compressed an
    // outlier tail). rawY/rawMaxY are preserved by toPlotted so the tooltip and
    // the empty-state check keep seeing real kbps.
    const toPlotted = (points) => points.map((p) => {
      const rawY = Number(p?.rawY ?? p?.y) || 0;
      const rawMaxY = Number.isFinite(Number(p?.rawMaxY)) ? Number(p.rawMaxY) : null;
      return { ...p, rawY, rawMaxY, y: networkY.toPlot(rawY) };
    });
    const networkUpPlot = toPlotted(networkUpChartDisplay);
    const networkDownPlot = toPlotted(networkDownChartDisplay);
    detailCharts._register('detailNetworkChart', new Chart(networkCtx, {
      type: 'line',
      data: {
        datasets: [
          { label: t('chartUp'), parsing: false, data: networkUpPlot, borderColor: '#68f6ff', backgroundColor: 'transparent', fill: false, tension: networkMobile ? 0.28 : 0.18, pointRadius: 0, pointHoverRadius: 5, borderWidth: networkMobile ? 2.2 : 3.2, showLine: true, stepped: false },
          { label: t('chartDown'), parsing: false, data: networkDownPlot, borderColor: '#ffd66b', backgroundColor: 'transparent', fill: false, tension: networkMobile ? 0.28 : 0.18, pointRadius: 0, pointHoverRadius: 5, borderWidth: networkMobile ? 2.2 : 3.2, showLine: true, stepped: false },
        ]
      },
      options: { ...baseOptions, elements: { line: { borderCapStyle: 'round', borderJoinStyle: 'round' }, point: { radius: networkMobile ? 0 : undefined } }, plugins: { ...baseOptions.plugins, legend: { display: false, labels: { color: '#bfefff', boxWidth: 10, boxHeight: 2 } }, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => items[0] ? telemetryTooltipTime(items[0]) : '', label: (item) => `${item.dataset.label}: ${fmtRate(Number(item.raw.rawY ?? item.raw.y ?? 0))}${Number.isFinite(Number(item.raw.rawMaxY)) ? ` · ${t('chartPeak')} ${fmtRate(Number(item.raw.rawMaxY))}` : ''}${Number(item.raw.samples) > 1 ? ` · ${Number(item.raw.samples)} ${t('chartSamplesAggregated')}` : ''}` } } }, scales: { x: { type: 'linear', reverse: false, min: networkAxisBounds.min, max: networkAxisBounds.max, ticks: { color: '#45676c', stepSize: Math.max(60 * 1000, Math.round((networkAxisBounds.max - networkAxisBounds.min) / (networkMobile ? 3 : 4))), callback: (v) => xTickFmt(v), maxRotation: 0, autoSkip: networkMobile, maxTicksLimit: networkMobile ? 4 : undefined, font: { size: networkMobile ? 7 : 9, weight: '700' } }, grid: { color: networkMobile ? 'rgba(55,95,101,0.12)' : 'rgba(55,95,101,0.20)' }, border: { color: 'rgba(55,95,101,.30)' } }, y: networkYScale } }
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
          pointRadius: 0,
          pointHoverRadius: 6,
          borderWidth: 3,
        },
        // Per-bucket min/max band: the mean line alone smoothed 6 samples per
        // 30s bucket into a featureless ribbon.
        ...envelopeDatasets(cpuDisplaySeries, 'rgba(155,211,255,0.20)')]
      },
      plugins: [cpuEmptyPlugin],
      options: { ...makeHudChartOptions(5, '%'), plugins: { ...makeHudChartOptions(5, '%').plugins, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, filter: tooltipSkipsEnvelope, callbacks: { title: (items) => items[0] ? telemetryTooltipTime(items[0]) : '', label: (item) => `CPU ${Number(item.raw.y || 0).toFixed(1)}%${spreadSuffix(item.raw, (v) => `${v.toFixed(1)}%`)}` } } }, scales: { x: smallChartXScale(cpuAxisBounds), y: adaptivePercentYScale(fixedSmallY) } }
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
          pointRadius: 0,
          pointHoverRadius: 6,
          borderWidth: 3,
        },
        ...envelopeDatasets(ramDisplaySeries, 'rgba(255,217,121,0.20)')]
      },
      plugins: [ramEmptyPlugin],
      options: { ...makeHudChartOptions(5, '%'), plugins: { ...makeHudChartOptions(5, '%').plugins, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, filter: tooltipSkipsEnvelope, callbacks: { title: (items) => items[0] ? telemetryTooltipTime(items[0]) : '', label: (item) => `${t('memory')} ${Number(item.raw.y || 0).toFixed(1)}%${spreadSuffix(item.raw, (v) => `${v.toFixed(1)}%`)}` } } }, scales: { x: smallChartXScale(ramAxisBounds), y: adaptivePercentYScale(fixedSmallY) } }
    }));
  }


  if (processCountCanvas) {
    const ctx = processCountCanvas.getContext('2d');
    detailCharts._register('detailProcessCountChart', new Chart(ctx, {
      type: 'line',
      data: { datasets: [{ label: 'Processes', parsing: false, data: processDisplaySeries, borderColor: '#8dffd0', backgroundColor: 'rgba(125,255,193,0.20)', fill: true, tension: 0.18, pointRadius: 0, pointHoverRadius: 6, borderWidth: 3 },
        ...envelopeDatasets(processDisplaySeries, 'rgba(141,255,208,0.20)')] },
      plugins: [processEmptyPlugin],
      options: { ...makeHudChartOptions(5, ''), plugins: { ...makeHudChartOptions(5, '').plugins, tooltip: { enabled: true, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, filter: tooltipSkipsEnvelope, callbacks: { title: (items) => telemetryTooltipTime(items[0]), label: (item) => `${t('chartRunningProcesses')} ${Math.round(Number(item.raw.y || 0))}${spreadSuffix(item.raw, (v) => `${Math.round(v)}`)}` } } }, scales: { x: smallChartXScale(processAxisBounds), y: processYScale } }
    }));
  }

  if (pingCanvas) {
    const ctx = pingCanvas.getContext('2d');
    const hasPingPoints = ping24hDatasets.some(ds => Array.isArray(ds.data) && ds.data.length);
    const pingMsValues = ping24hDatasets.flatMap((ds) => (ds.data || []).map((p) => Number(p.rawMs ?? p.y)).filter(Number.isFinite));
    const pingYScale = adaptiveMsYScale(pingMsValues, makeHudChartOptions(5, 'ms').scales.y);
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
        chart.ctx.fillText(targets.length ? t('chartAccumulatingIcmp') : t('chartNoLatencyTargets'), (area.left + area.right) / 2, (area.top + area.bottom) / 2 - 8);
        chart.ctx.fillStyle = 'rgba(102,141,154,.92)';
        chart.ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        chart.ctx.fillText(Number.isFinite(loss) ? `${t('chartProbeFailLoss')} ${loss.toFixed(0)}%` : (targets.length ? t('chartWaitingProbeSample') : t('chartConfigurePingTargets')), (area.left + area.right) / 2, (area.top + area.bottom) / 2 + 12);
        chart.ctx.restore();
      }
    };
    detailCharts._register('detailPingChart', new Chart(ctx, {
      type: 'line',
      data: {
        datasets: ping24hDatasets.map((ds) => ({
          ...ds,
          parsing: false,
          // Use real milliseconds for adaptive Y axis (not fixed step-index mapping).
          data: (ds.data || []).map((p) => ({
            ...p,
            y: Number.isFinite(Number(p.rawMs)) ? Number(p.rawMs) : Number(p.y) || 0,
          })),
        })),
      },
      plugins: [pingEmptyPlugin],
      options: { ...makeHudChartOptions(5, 'ms'), plugins: { ...makeHudChartOptions(5, 'ms').plugins, legend: { display: false, labels: { color: '#bfefff', boxWidth: 10, boxHeight: 2 } }, tooltip: { enabled: hasPingPoints, backgroundColor: 'rgba(3,18,28,.92)', borderColor: 'rgba(98,245,238,.35)', borderWidth: 1, callbacks: { title: (items) => items[0] ? `${t('chartSampleTime')} ${formatTooltipClock(items[0].raw.x)}` : '', label: (item) => `${item.dataset.label}: ${Number(item.raw.rawMs ?? item.raw.y ?? 0).toFixed(1)} ms`, afterLabel: (item) => `${t('chartProtocol')} ${item.raw.protocol || 'icmp'} · ${t('chartLoss')} ${Number(item.raw.lossPct ?? 0).toFixed(0)}%` } } }, scales: { x: { type: 'linear', reverse: false, min: axis24h[0], max: axis24h[4], ticks: { color: '#8ab5bd', stepSize: Math.max(60 * 1000, Math.round((axis24h[4] - axis24h[0]) / 4)), callback: (v) => xTickFmt(v), maxRotation: 0, autoSkip: isDetailMobileChart(), maxTicksLimit: isDetailMobileChart() ? 4 : undefined, font: { size: isDetailMobileChart() ? 7 : 8 } }, grid: { color: 'rgba(98,245,238,0.13)' }, border: { color: 'rgba(98,245,238,.18)' } }, y: pingYScale } }
    }));
    attachPingPointTooltip(pingCanvas, ping24hDatasets, {
      min: pingAxisBounds.min,
      max: pingAxisBounds.max,
      yMin: pingYScale.min,
      yMax: pingYScale.max,
    });
  }
  if (globalVpsProbeCanvas) {
    const ctx = globalVpsProbeCanvas.getContext('2d');
    const vpsProbeDatasets = buildPingDatasets([], pingHours, vpsProbeTargetsData, vpsProbeHistoryData)
      .filter((dataset) => String(dataset?.key || '').startsWith('vps-'));
    const vpsProbeTargets = (vpsProbeTargetsData?.targets || []).filter((target) => String(target?.key || '').startsWith('vps-'));
    const hasVpsProbePoints = vpsProbeDatasets.some((dataset) => Array.isArray(dataset.data) && dataset.data.length);
    const vpsProbeEmptyPlugin = {
      id: 'globalVpsProbeEmptyState',
      afterDraw(chart) {
        if (hasVpsProbePoints) return;
        const area = chart.chartArea;
        if (!area) return;
        chart.ctx.save();
        chart.ctx.fillStyle = 'rgba(235,252,255,.92)';
        chart.ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        chart.ctx.textAlign = 'center';
        chart.ctx.textBaseline = 'middle';
        chart.ctx.fillText(t('chartNoVpsProbeSamples'), (area.left + area.right) / 2, (area.top + area.bottom) / 2 - 8);
        chart.ctx.fillStyle = 'rgba(102,141,154,.92)';
        chart.ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
        chart.ctx.fillText(t('chartWaitingVpsProbe'), (area.left + area.right) / 2, (area.top + area.bottom) / 2 + 12);
        chart.ctx.restore();
      }
    };
    detailCharts._register('detailGlobalVpsProbeChart', new Chart(ctx, {
      type: 'line',
      data: { datasets: vpsProbeDatasets.map((dataset) => ({ ...dataset, parsing: false, data: [...(dataset.data || [])].sort((a, b) => Number(a?.x) - Number(b?.x)) })) },
      plugins: [vpsProbeEmptyPlugin],
      options: { ...makeHudChartOptions(5, 'ms'), scales: { x: { type: 'linear', reverse: false, ticks: { callback: (value) => xTickFmt(value), color: '#8ab5bd' }, grid: { color: 'rgba(98,245,238,0.13)' } }, y: makeHudChartOptions(5, 'ms').scales.y } }
    }));
    window.__DBG__.DETAIL_GLOBAL_VPS_PROBE_CHART = { targets: vpsProbeTargets.map((target) => target.key), datasets: vpsProbeDatasets.map((dataset) => dataset.label) };
  }

  try {
    window.__DBG__.DETAIL_CHART_DEBUG = {
      cpuPoints: cpu12hSeries.length,
      ramPoints: ram12hSeries.length,
      processPoints: processSeries.length,
      networkSeries: { raw: networkRows.length, source: networkRows[0]?.source || null, latestRaw: networkRows[networkRows.length - 1] || null, buckets: networkBuckets.length, up: networkUpChartDisplay.length, down: networkDownChartDisplay.length, upFirst: networkUpChartDisplay[0] || null, upSecond: networkUpChartDisplay[1] || null, upLast: networkUpChartDisplay[networkUpChartDisplay.length - 1] || null, downFirst: networkDownChartDisplay[0] || null, downSecond: networkDownChartDisplay[1] || null, downLast: networkDownChartDisplay[networkDownChartDisplay.length - 1] || null, axis: networkAxisBounds, yAxisMode: networkYDebug.mode, yAxisRawMax: networkYDebug.rawMax, yPeakDrawn: Math.max(0, ...networkRateValues), yPeakBucket: Math.max(0, ...networkBuckets.flatMap((b) => [Number(b.upMax) || 0, Number(b.downMax) || 0])) },
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
      processDisplayLast: processDisplaySeries[processDisplaySeries.length - 1] || null,
      displayPoints: { cpu: cpuDisplaySeries.length, ram: ramDisplaySeries.length, process: processDisplaySeries.length, cpuBuckets: cpuBuckets.length, ramBuckets: ramBuckets.length, processBuckets: processBuckets.length },
      axis12hBounds,
      telemetryHours,
      // Per-chart X bounds: a collapsed span here (spanMs far under an hour, or
      // every tick sharing one clock label) is the cold-start regression, not
      // an idle host. Keep these visible so it can be caught without pixels.
      smallXBounds: { cpu: cpuAxisBounds, ram: ramAxisBounds, process: processAxisBounds },
      processAxis: { min: processYMin, max: processYMax, integerTicks: true },
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
