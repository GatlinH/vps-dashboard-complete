/**
 * frontend/performance.js - 性能优化模块
 * 完整实现：防抖、节流、请求去重、惰性加载、性能记录
 */

class PerformanceOptimizer {
    constructor(app) {
        this.app = app;
        this.observerCache = new Map();
        this.pendingRequests = new Map();
    }

    /**
     * 启用惰性加载图表
     * @param {ChartManager} chartManager - 图表管理器实例
     * @returns {IntersectionObserver} 观察器实例
     */
    enableLazyChartLoading(chartManager) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const canvas = entry.target;
                    if (canvas.dataset.lazy && !canvas.dataset.loaded) {
                        const id = canvas.id;
                        
                        try {
                            if (id === 'cpuChart' && this.app.store.state.servers.length > 0) {
                                chartManager.createCPUChart(id, this.app.store.state.servers[0]);
                            } else if (id === 'trafficChart') {
                                chartManager.createTrafficChart(id, this.app.store.state.servers);
                            } else if (id === 'costTrendChart') {
                                chartManager.createCostTrendChart(id, this.app.store.state.servers);
                            }
                        } catch (error) {
                            console.error(`图表初始化失败 [${id}]:`, error);
                        }
                        
                        canvas.dataset.loaded = 'true';
                        observer.unobserve(canvas);
                    }
                }
            });
        }, { rootMargin: '50px' });

        // 观察所有具有 data-lazy 属性的 canvas 元素
        document.querySelectorAll('canvas[data-lazy]').forEach(canvas => {
            observer.observe(canvas);
        });
        
        // 缓存观察器实例，便于后续清理
        this.observerCache.set('chartObserver', observer);
        
        return observer;
    }

    /**
     * 清理资源
     * @param {IntersectionObserver} observer - 要清理的观察器
     */
    destroy(observer) {
        if (observer) {
            observer.disconnect();
        }
        this.observerCache.forEach(obs => {
            if (obs && obs.disconnect) {
                obs.disconnect();
            }
        });
        this.observerCache.clear();
        this.pendingRequests.clear();
    }

    /**
     * 防抖函数
     * @param {Function} func - 要执行的函数
     * @param {number} delay - 延迟时间（毫秒）
     * @returns {Function} 防抖后的函数
     */
    debounce(func, delay) {
        let timeoutId;
        return (...args) => {
            clearTimeout(timeoutId);
            timeoutId = setTimeout(() => func(...args), delay);
        };
    }

    /**
     * 节流函数
     * @param {Function} func - 要执行的函数
     * @param {number} limit - 限制时间间隔（毫秒）
     * @returns {Function} 节流后的函数
     */
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

    /**
     * 启用请求去重
     * @param {APIService} api - API 服务实例
     */
    enableRequestDeduplication(api) {
        const originalRequest = api.request.bind(api);
        
        api.request = async (endpoint, options = {}) => {
            const key = `${options.method || 'GET'}:${endpoint}`;
            
            // 如果相同请求正在进行中，返回已有的 Promise
            if (this.pendingRequests.has(key)) {
                return this.pendingRequests.get(key);
            }

            // 创建新请求
            const promise = originalRequest(endpoint, options);
            this.pendingRequests.set(key, promise);

            try {
                const result = await promise;
                return result;
            } finally {
                // 请求完成后删除缓存
                this.pendingRequests.delete(key);
            }
        };
    }

    /**
     * 记录性能指标
     * @returns {Object} 性能指标对象
     */
    recordMetrics() {
        if (!window.performance || !window.performance.timing) {
            console.warn('浏览器不支持 Performance API');
            return null;
        }

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

export { PerformanceOptimizer };
