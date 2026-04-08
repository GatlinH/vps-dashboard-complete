/**
 * frontend/performance.js - 性能优化模块
 */

class PerformanceOptimizer {
    constructor(app) {
        this.app = app;
        this.observerCache = new Map();
    }

    // 惰性加载图表
    enableLazyChartLoading() {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const canvas = entry.target;
                    if (canvas.dataset.lazy && !canvas.dataset.loaded) {
                        this.renderChart(canvas);
                        canvas.dataset.loaded = 'true';
                        observer.unobserve(canvas);
                    }
                }
            });
        });

        document.querySelectorAll('canvas[data-lazy]').forEach(canvas => {
            observer.observe(canvas);
        });
    }

    // 防抖请求
    debounce(func, delay) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func(...args), delay);
        };
    }

    // 节流更新
    throttle(func, limit) {
        let lastRun = 0;
        return (...args) => {
            const now = Date.now();
            if (now - lastRun >= limit) {
                func(...args);
                lastRun = now;
            }
        };
    }

    // 请求去重
    enableRequestDeduplication(api) {
        const pendingRequests = new Map();

        const originalRequest = api.request.bind(api);
        api.request = async (endpoint, options = {}) => {
            const key = `${options.method || 'GET'}:${endpoint}`;
            
            if (pendingRequests.has(key)) {
                return pendingRequests.get(key);
            }

            const promise = originalRequest(endpoint, options);
            pendingRequests.set(key, promise);

            try {
                return await promise;
            } finally {
                pendingRequests.delete(key);
            }
        };
    }

    // 记录性能指标
    recordMetrics() {
        if (window.performance && window.performance.timing) {
            const timing = window.performance.timing;
            const metrics = {
                'DNS查询': timing.domainLookupEnd - timing.domainLookupStart,
                '建立连接': timing.connectEnd - timing.connectStart,
                '服务器响应': timing.responseStart - timing.requestStart,
                '页面下载': timing.responseEnd - timing.responseStart,
                'DOM解析': timing.domInteractive - timing.domLoading,
                '资源加载': timing.loadEventStart - timing.domContentLoadedEventEnd,
                '页面加载总耗时': timing.loadEventEnd - timing.navigationStart,
            };

            console.table(metrics);
            return metrics;
        }
    }
}

export { PerformanceOptimizer };
