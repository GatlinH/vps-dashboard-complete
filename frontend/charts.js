/**
 * frontend/charts.js - 图表和可视化模块
 * 使用轻量级 Chart.js 库，完整的 ChartManager 类
 */

class ChartManager {
    /**
     * 初始化图表管理器
     * @param {Object} app - 应用实例，用于 API 调用
     */
    constructor(app) {
        this.app = app;
        this.charts = new Map();
        this.loadChartLibrary();
    }

    /**
     * 动态加载 Chart.js 库
     */
    loadChartLibrary() {
        if (!window.Chart) {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';
            script.onload = () => {
                console.log('✓ Chart.js 已加载');
            };
            script.onerror = () => {
                console.error('✗ Chart.js 加载失败');
            };
            document.head.appendChild(script);
        }
    }

    /**
     * 创建 CPU 使用率历史图表
     * @async
     * @param {string} containerId - 容器 ID
     * @param {Object} server - 服务器对象
     * @returns {Object|void}
     */
    async createCPUChart(containerId, server) {
        if (!window.Chart) {
            setTimeout(() => this.createCPUChart(containerId, server), 500);
            return;
        }

        const ctx = document.getElementById(containerId)?.getContext('2d');
        if (!ctx) {
            console.error(`容器 ${containerId} 不存在`);
            return;
        }

        let labels = [];
        let data = [];
        
        try {
            // 获取真实历史数据
            if (this.app && this.app.api) {
                const history = await this.app.api.request(`/servers/${server.id}/history?days=1`);
                if (history && history.data && history.data.length > 0) {
                    labels = history.data.map(h => {
                        const date = new Date(h.timestamp);
                        return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
                    });
                    data = history.data.map(h => Math.min(Math.max(parseFloat(h.cpu_use) || 0, 0), 100));
                }
            }
        } catch (error) {
            console.warn('获取历史数据失败，使用默认数据:', error);
        }

        // 降级方案：如果没有数据，显示空白图表
        if (labels.length === 0) {
            const now = Date.now();
            labels = Array.from({ length: 24 }, (_, i) => {
                const date = new Date(now - (23 - i) * 3600000);
                return `${String(date.getHours()).padStart(2, '0')}:00`;
            });
            data = Array(24).fill(0);
        }

        try {
            const chart = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [{
                        label: 'CPU 使用率 %',
                        data,
                        borderColor: '#63b3ed',
                        backgroundColor: 'rgba(99, 179, 237, 0.1)',
                        borderWidth: 2,
                        fill: true,
                        tension: 0.4,
                        pointRadius: 0,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#63b3ed',
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: true,
                            labels: { font: { size: 12 } },
                        },
                    },
                    scales: {
                        y: {
                            min: 0,
                            max: 100,
                            ticks: {
                                callback: (v) => v + '%',
                            },
                        },
                    },
                },
            });

            this.charts.set(containerId, chart);
            return chart;
        } catch (error) {
            console.error(`创建 CPU 图表失败: ${error.message}`);
        }
    }

    /**
     * 创建流量使用统计（甜甜圈图）
     * @param {string} containerId - 容器 ID
     * @param {Array} servers - 服务器数组
     * @returns {Object|void}
     */
    createTrafficChart(containerId, servers) {
        if (!window.Chart) {
            console.warn('Chart.js 未加载');
            return;
        }

        const ctx = document.getElementById(containerId)?.getContext('2d');
        if (!ctx) {
            console.error(`容器 ${containerId} 不存在`);
            return;
        }

        try {
            const chart = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: servers.map(s => s.name || '未命名'),
                    datasets: [{
                        data: servers.map(s => {
                            // 安全检查：避免除以 0
                            if (!s.traffic_limit_gb || s.traffic_limit_gb <= 0) {
                                return 0;
                            }
                            const usage = parseFloat(s.traffic_used_gb) || 0;
                            const limit = parseFloat(s.traffic_limit_gb) || 1;
                            const percentage = (usage / limit) * 100;
                            return Math.min(Math.max(percentage, 0), 100);
                        }),
                        backgroundColor: [
                            '#38ef7d',
                            '#63b3ed',
                            '#f6c90e',
                            '#ff9f43',
                            '#a78bfa',
                            '#ff6b6b',
                        ],
                        borderColor: '#070b14',
                        borderWidth: 2,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            position: 'bottom',
                            labels: { font: { size: 12 } },
                        },
                    },
                },
            });

            this.charts.set(containerId, chart);
            return chart;
        } catch (error) {
            console.error(`创建流量图表失败: ${error.message}`);
        }
    }

    /**
     * 创建成本趋势图（柱状图）
     * @param {string} containerId - 容器 ID
     * @param {Array} servers - 服务器数组
     * @returns {Object|void}
     */
    createCostTrendChart(containerId, servers) {
        if (!window.Chart) {
            console.warn('Chart.js 未加载');
            return;
        }

        const ctx = document.getElementById(containerId)?.getContext('2d');
        if (!ctx) {
            console.error(`容器 ${containerId} 不存在`);
            return;
        }

        try {
            const costByMonth = new Map();
            servers.forEach(server => {
                if (!server.expiry) return;
                const month = server.expiry.substring(0, 7); // YYYY-MM
                const price = parseFloat(server.price) || 0;
                costByMonth.set(month, (costByMonth.get(month) || 0) + price);
            });

            const labels = Array.from(costByMonth.keys()).sort();
            const data = labels.map(month => costByMonth.get(month) || 0);

            const chart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: '月度成本 (¥)',
                        data,
                        backgroundColor: '#63b3ed',
                        borderColor: '#4fc3f7',
                        borderWidth: 1,
                    }],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            ticks: {
                                callback: (v) => '¥' + v.toFixed(0),
                            },
                        },
                    },
                },
            });

            this.charts.set(containerId, chart);
            return chart;
        } catch (error) {
            console.error(`创建成本趋势图失败: ${error.message}`);
        }
    }

    /**
     * 销毁指定容器的图表
     * @param {string} containerId - 容器 ID
     */
    destroyChart(containerId) {
        const chart = this.charts.get(containerId);
        if (chart) {
            chart.destroy();
            this.charts.delete(containerId);
        }
    }

    /**
     * 销毁所有图表
     */
    destroyAll() {
        this.charts.forEach(chart => {
            try {
                chart.destroy();
            } catch (error) {
                console.warn('销毁图表时出错:', error);
            }
        });
        this.charts.clear();
    }
}

// 导出
window.ChartManager = ChartManager;
export { ChartManager };
