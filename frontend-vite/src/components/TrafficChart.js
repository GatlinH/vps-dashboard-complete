/**
 * components/TrafficChart.js
 * 全站图表组件，合并自 charts.js + 原 TrafficChart.js。
 * Chart.js 按需懒加载（动态 import），首屏零开销。
 *
 * 方法一览：
 *   renderCPU(canvasId, server, api?)   CPU 使用率折线图（支持真实历史 API）
 *   renderTrafficDoughnut(canvasId, servers)  流量使用率甜甜圈图
 *   renderCostTrend(canvasId, servers)  月度成本柱状图
 *   renderBar(canvasId, servers)        出入站流量对比柱状图
 *   renderTrend(canvasId, server)       近30天流量趋势折线图
 *   destroy(canvasId)                   销毁单个图表
 *   destroyAll()                        销毁全部图表
 */

// ─── 暗色主题基础配置 ────────────────────────────────────────────────────────
const DARK_OPTS = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: true, labels: { color: '#94a3b8', font: { size: 11 } } },
  },
  scales: {
    x: {
      ticks: { color: '#64748b', font: { size: 10 }, maxRotation: 30 },
      grid:  { color: 'rgba(255,255,255,.04)' },
    },
    y: {
      ticks: { color: '#64748b', font: { size: 11 } },
      grid:  { color: 'rgba(255,255,255,.06)' },
    },
  },
};

export class TrafficChart {
  constructor() {
    /** @type {Map<string, import('chart.js').Chart>} canvasId → Chart 实例 */
    this._instances = new Map();
    this._chartjs   = null;  // Chart 构造函数，懒加载后填入
    this._loading   = null;  // Promise 单例，防止并发重复加载
  }

  // ─── Chart.js 懒加载 ─────────────────────────────────────────────────────

  /**
   * 确保 Chart.js 已加载并返回构造函数，多次调用安全。
   * 优先复用已由 CDN 注入的全局 window.Chart，
   * 否则走 Vite 的动态 import（触发 chunk 按需下载）。
   */
  async ready() {
    if (this._chartjs) return this._chartjs;
    if (this._loading) return this._loading;
    this._loading = (async () => {
      if (typeof window.Chart !== 'undefined') {
        this._chartjs = window.Chart;
      } else {
        const mod = await import('chart.js/auto');
        this._chartjs = mod.Chart ?? mod.default;
      }
      return this._chartjs;
    })();
    return this._loading;
  }

  // ─── 内部工具 ────────────────────────────────────────────────────────────

  /** 安全获取 canvas 2d 上下文，元素不存在时打印警告并返回 null */
  _ctx(canvasId) {
    const el = document.getElementById(canvasId);
    if (!el) { console.warn(`[TrafficChart] canvas #${canvasId} 不存在`); return null; }
    return el.getContext('2d');
  }

  /** 销毁旧实例后注册新实例 */
  _register(canvasId, chart) {
    this._instances.get(canvasId)?.destroy();
    this._instances.set(canvasId, chart);
    return chart;
  }

  // ─── CPU 使用率折线图（来自 charts.js） ──────────────────────────────────

  /**
   * CPU 使用率历史折线图。
   * 优先通过 api 拉取真实历史数据；无数据时降级为24小时空白占位图。
   * @param {string}      canvasId
   * @param {object}      server   服务器对象（需含 server.id）
   * @param {object|null} api      可选，含 .request(path) 的 API 实例
   */
  async renderCPU(canvasId, server, api = null) {
    const Chart = await this.ready();
    const ctx   = this._ctx(canvasId);
    if (!ctx) return;

    let labels = [], data = [];

    // 尝试拉取真实历史数据
    if (api?.request) {
      try {
        const history = await api.request(`/servers/${server.id}/history?days=1`);
        if (history?.data?.length) {
          labels = history.data.map(h => {
            const d = new Date(h.timestamp);
            return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          });
          data = history.data.map(h => Math.min(Math.max(parseFloat(h.cpu_use) || 0, 0), 100));
        }
      } catch (e) {
        console.warn('[TrafficChart] 获取 CPU 历史数据失败，使用降级数据:', e);
      }
    }

    // 降级：24小时空白占位
    if (!labels.length) {
      const now = Date.now();
      labels = Array.from({ length: 24 }, (_, i) => {
        const d = new Date(now - (23 - i) * 3_600_000);
        return `${String(d.getHours()).padStart(2, '0')}:00`;
      });
      data = Array(24).fill(0);
    }

    try {
      return this._register(canvasId, new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'CPU 使用率 %',
            data,
            borderColor: '#63b3ed',
            backgroundColor: 'rgba(99,179,237,0.1)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointBackgroundColor: '#63b3ed',
          }],
        },
        options: {
          ...DARK_OPTS,
          scales: {
            ...DARK_OPTS.scales,
            y: {
              ...DARK_OPTS.scales.y,
              min: 0, max: 100,
              ticks: { ...DARK_OPTS.scales.y.ticks, callback: v => v + '%' },
            },
          },
        },
      }));
    } catch (e) {
      console.error('[TrafficChart] 创建 CPU 图表失败:', e);
    }
  }

  // ─── 流量使用率甜甜圈图（来自 charts.js） ────────────────────────────────

  /**
   * 各服务器流量使用率甜甜圈图。
   * 无限量服务器（traffic_limit_gb ≤ 0）显示为 0%。
   * @param {string}   canvasId
   * @param {object[]} servers
   */
  async renderTrafficDoughnut(canvasId, servers) {
    const Chart = await this.ready();
    const ctx   = this._ctx(canvasId);
    if (!ctx) return;

    try {
      return this._register(canvasId, new Chart(ctx, {
        type: 'doughnut',
        data: {
          labels: servers.map(s => s.name || '未命名'),
          datasets: [{
            data: servers.map(s => {
              if (!s.traffic_limit_gb || s.traffic_limit_gb <= 0) return 0;
              const pct = (parseFloat(s.traffic_used_gb) || 0) / parseFloat(s.traffic_limit_gb) * 100;
              return Math.min(Math.max(pct, 0), 100);
            }),
            backgroundColor: ['#38ef7d', '#63b3ed', '#f6c90e', '#ff9f43', '#a78bfa', '#ff6b6b'],
            borderColor: '#070b14',
            borderWidth: 2,
          }],
        },
        options: {
          ...DARK_OPTS,
          scales: {},   // 甜甜圈图不需要坐标轴
          plugins: {
            ...DARK_OPTS.plugins,
            legend: { ...DARK_OPTS.plugins.legend, position: 'bottom' },
          },
        },
      }));
    } catch (e) {
      console.error('[TrafficChart] 创建甜甜圈图失败:', e);
    }
  }

  // ─── 月度成本柱状图（来自 charts.js） ────────────────────────────────────

  /**
   * 按到期月份统计服务器成本的柱状图。
   * @param {string}   canvasId
   * @param {object[]} servers
   */
  async renderCostTrend(canvasId, servers) {
    const Chart = await this.ready();
    const ctx   = this._ctx(canvasId);
    if (!ctx) return;

    const byMonth = new Map();
    servers.forEach(s => {
      if (!s.expiry) return;
      const month = s.expiry.slice(0, 7); // YYYY-MM
      byMonth.set(month, (byMonth.get(month) || 0) + (parseFloat(s.price) || 0));
    });
    const labels = [...byMonth.keys()].sort();
    const data   = labels.map(m => byMonth.get(m));

    try {
      return this._register(canvasId, new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: '月度成本 (¥)',
            data,
            backgroundColor: '#63b3ed',
            borderColor: '#4fc3f7',
            borderWidth: 1,
            borderRadius: 4,
          }],
        },
        options: {
          ...DARK_OPTS,
          scales: {
            ...DARK_OPTS.scales,
            y: {
              ...DARK_OPTS.scales.y,
              ticks: { ...DARK_OPTS.scales.y.ticks, callback: v => '¥' + v.toFixed(0) },
            },
          },
        },
      }));
    } catch (e) {
      console.error('[TrafficChart] 创建成本趋势图失败:', e);
    }
  }

  // ─── 出入站流量对比柱状图（原有） ────────────────────────────────────────

  /**
   * 各服务器本月出站/入站流量对比柱状图。
   * @param {string}   canvasId
   * @param {object[]} servers
   */
  async renderBar(canvasId, servers) {
    const Chart = await this.ready();
    const ctx   = this._ctx(canvasId);
    if (!ctx) return;

    try {
      return this._register(canvasId, new Chart(ctx, {
        type: 'bar',
        data: {
          labels: servers.map(s => s.name),
          datasets: [
            {
              label: '↑ 出站 (GB)',
              data:  servers.map(s => parseFloat((s.traffic_up_gb   || 0).toFixed(1))),
              backgroundColor: 'rgba(99,179,237,0.75)',
              borderRadius: 4,
            },
            {
              label: '↓ 入站 (GB)',
              data:  servers.map(s => parseFloat((s.traffic_down_gb || 0).toFixed(1))),
              backgroundColor: 'rgba(167,139,250,0.75)',
              borderRadius: 4,
            },
          ],
        },
        options: {
          ...DARK_OPTS,
          scales: {
            ...DARK_OPTS.scales,
            y: { ...DARK_OPTS.scales.y, ticks: { ...DARK_OPTS.scales.y.ticks, callback: v => v + ' GB' } },
          },
        },
      }));
    } catch (e) {
      console.error('[TrafficChart] 创建出入站柱状图失败:', e);
    }
  }

  // ─── 近30天趋势折线图（原有） ────────────────────────────────────────────

  /**
   * 单台服务器近30天流量趋势折线图。
   * 当前使用模拟数据；对接真实 API 时替换数据生成段即可。
   * @param {string}  canvasId
   * @param {object}  server
   */
  async renderTrend(canvasId, server) {
    const Chart = await this.ready();
    const ctx   = this._ctx(canvasId);
    if (!ctx || !server) return;

    const days   = 30;
    const labels = [], upArr = [], dnArr = [];
    const baseUp = (server.traffic_up_gb   || 10) / 30;
    const baseDn = (server.traffic_down_gb || 50) / 30;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
      upArr.push(+(baseUp * (0.6 + Math.random() * 0.8)).toFixed(2));
      dnArr.push(+(baseDn * (0.6 + Math.random() * 0.8)).toFixed(2));
    }

    try {
      return this._register(canvasId, new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: '出站 (GB)', data: upArr,
              borderColor: '#63b3ed', backgroundColor: 'rgba(99,179,237,.1)',
              borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true,
            },
            {
              label: '入站 (GB)', data: dnArr,
              borderColor: '#a78bfa', backgroundColor: 'rgba(167,139,250,.1)',
              borderWidth: 1.5, pointRadius: 0, tension: 0.4, fill: true,
            },
          ],
        },
        options: {
          ...DARK_OPTS,
          scales: {
            ...DARK_OPTS.scales,
            x: { ...DARK_OPTS.scales.x, ticks: { ...DARK_OPTS.scales.x.ticks, maxTicksLimit: 10 } },
            y: { ...DARK_OPTS.scales.y, ticks: { ...DARK_OPTS.scales.y.ticks, callback: v => v + ' GB' } },
          },
        },
      }));
    } catch (e) {
      console.error('[TrafficChart] 创建趋势图失败:', e);
    }
  }

  // ─── 销毁 ────────────────────────────────────────────────────────────────

  destroy(canvasId) {
    this._instances.get(canvasId)?.destroy();
    this._instances.delete(canvasId);
  }

  destroyAll() {
    this._instances.forEach(chart => {
      try { chart.destroy(); } catch (e) { console.warn('[TrafficChart] 销毁图表时出错:', e); }
    });
    this._instances.clear();
  }
}
