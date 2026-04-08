/**
 * frontend/charts.js - 图表和可视化模块
 * 使用轻量级 Chart.js 库
 */

async createCPUChart(containerId, server) {
    if (!window.Chart) {
        setTimeout(() => this.createCPUChart(containerId, server), 500);
        return;
    }

    const ctx = document.getElementById(containerId)?.getContext('2d');
    if (!ctx) return;

    // 获取真实历史数据（需要后端支持）
    let labels = [];
    let data = [];
    
    try {
        // 假设后端提供历史数据接口
        const history = await this.app.api.request(`/servers/${server.id}/history?days=1`);
        if (history && history.data) {
            labels = history.data.map(h => h.timestamp);
            data = history.data.map(h => h.cpu_use);
        } else {
            // 降级方案：显示消息提示缺少数据
            console.warn('缺少历史数据，请确保后端实现了 /api/servers/<id>/history 接口');
        }
    } catch (error) {
        console.error('获取历史数据失败:', error);
    }

    // 如果没有数据，使用默认显示
    if (labels.length === 0) {
        const now = Date.now();
        labels = Array.from({ length: 24 }, (_, i) => {
            const date = new Date(now - (23 - i) * 3600000);
            return date.getHours() + ':00';
        });
        data = Array(24).fill(0);
    }

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
            }],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
            },
            scales: {
                y: {
                    min: 0,
                    max: 100,
                },
            },
        },
    });

    this.charts.set(containerId, chart);
    return chart;
}

// 修复流量图表中的 0 值问题
createTrafficChart(containerId, servers) {
    if (!window.Chart) return;

    const ctx = document.getElementById(containerId)?.getContext('2d');
    if (!ctx) return;

    const chart = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: servers.map(s => s.name),
            datasets: [{
                data: servers.map(s => {
                    // 修复：检查 traffic_limit_gb 是否为 0
                    if (!s.traffic_limit_gb || s.traffic_limit_gb <= 0) {
                        return 0;
                    }
                    const usage = (s.traffic_used_gb / s.traffic_limit_gb) * 100;
                    return Math.min(usage, 100); // 限制最大 100%
                }),
                backgroundColor: [...],
            }],
        },
        options: {...},
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
