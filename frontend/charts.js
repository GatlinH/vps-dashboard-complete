/**
 * frontend/charts.js - 图表和可视化模块
 * 使用轻量级 Chart.js 库
 */

class ChartManager {
    constructor(app) {
        this.app = app;
        this.charts = new Map();
        this.loadChartLibrary();
    }

    loadChartLibrary() {
        // 如果页面中还没加载 Chart.js，动态加载
        if (!window.Chart) {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/chart.js@3.9.1/dist/chart.min.js';
            script.onload = () => console.log('Chart.js 已加载');
            document.head.appendChild(script);
        }
    }

    // 创建 CPU 使用率历史图表
    createCPUChart(containerId, server) {
        if (!window.Chart) {
            setTimeout(() => this.createCPUChart(containerId, server), 500);
            return;
        }

        const ctx = document.getElementById(containerId)?.getContext('2d');
        if (!ctx) return;

        // 生成模拟历史数据（实际应从后端获取）
        const now = Date.now();
        const labels = Array.from({ length: 24 }, (_, i) => {
            const date = new Date(now - (23 - i) * 3600000);
            return date.getHours() + ':00';
        });

        const data = Array.from({ length: 24 }, () => Math.random() * 100);

        const chart = new Chart(ctx, {
            type: 'line',
            data: {
                labels,
                datasets: [
                    {
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
                    },
                ];
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        display: false,
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
    }

    // 创建流量使用统计
    createTrafficChart(containerId, servers) {
        if (!window.Chart) return;

        const ctx = document.getElementById(containerId)?.getContext('2d');
        if (!ctx) return;

        const chart = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: servers.map(s => s.name),
                datasets: [
                    {
                        data: servers.map(s => (s.traffic_used_gb / s.traffic_limit_gb) * 100 || 0),
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
                    },
                ];
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                    },
                },
            },
        });

        this.charts.set(containerId, chart);
        return chart;
    }

    // 创建成本趋势图
    createCostTrendChart(containerId, servers) {
        if (!window.Chart) return;

        const ctx = document.getElementById(containerId)?.getContext('2d');
        if (!ctx) return;

        // 按到期日期分组统计
        const costByMonth = new Map();
        servers.forEach(server => {
            if (!server.expiry) return;
            const month = server.expiry.substring(0, 7); // YYYY-MM
            costByMonth.set(month, (costByMonth.get(month) || 0) + server.price);
        });

        const labels = Array.from(costByMonth.keys()).sort();
        const data = labels.map(month => costByMonth.get(month));

        const chart = new Chart(ctx, {
            type: 'bar',
            data: {
                labels,
                datasets: [
                    {
                        label: '月度成本 (¥)',
                        data,
                        backgroundColor: '#63b3ed',
                        borderColor: '#4fc3f7',
                        borderWidth: 1,
                    },
                ];
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        ticks: {
                            callback: (v) => '¥' + v,
                        },
                    },
                },
            },
        });

        this.charts.set(containerId, chart);
        return chart;
    }

    // 销毁图表
    destroyChart(containerId) {
        const chart = this.charts.get(containerId);
        if (chart) {
            chart.destroy();
            this.charts.delete(containerId);
        }
    }

    destroyAll() {
        this.charts.forEach(chart => chart.destroy());
        this.charts.clear();
    }
}

// 导出
window.ChartManager = ChartManager;
export { ChartManager };
