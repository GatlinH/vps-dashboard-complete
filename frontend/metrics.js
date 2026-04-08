// frontend/metrics.js - 完整性能监控系统

class MetricsCollector {
    constructor(options = {}) {
        this.metrics = new Map();
        this.marks = new Map();
        this.measures = new Map();
        this.timings = new Map();
        
        this.thresholds = {
            'API_RESPONSE_TIME': options.apiThreshold || 1000, // 1s
            'PAGE_LOAD_TIME': options.pageLoadThreshold || 3000, // 3s
            'CHART_RENDER_TIME': options.chartThreshold || 500, // 500ms
            'DOM_READY_TIME': options.domReadyThreshold || 2000, // 2s
            'MEMORY_USAGE': options.memoryThreshold || 100 * 1024 * 1024, // 100MB
            'LONG_TASK': options.longTaskThreshold || 50, // 50ms
        };
        
        this.listeners = [];
        this.init();
    }

    /**
     * 初始化
     */
    init() {
        // 记录基础时间
        if (window.performance && window.performance.timing) {
            const timing = window.performance.timing;
            this.recordMetric('DOM_READY_TIME', timing.domContentLoadedEventEnd - timing.navigationStart);
            this.recordMetric('PAGE_LOAD_TIME', timing.loadEventEnd - timing.navigationStart);
        }

        // 监听 PerformanceObserver
        if ('PerformanceObserver' in window) {
            this._observePerformance();
        }

        // 监听内存使用（如果支持）
        if (performance.memory) {
            setInterval(() => this._checkMemory(), 5000);
        }
    }

    /**
     * 测量异步函数
     */
    async measureAsync(name, fn, metadata = {}) {
        const start = performance.now();
        const markName = `${name}-start`;
        const endMarkName = `${name}-end`;
        const measureName = `${name}`;

        try {
            performance.mark(markName);
            const result = await fn();
            performance.mark(endMarkName);
            performance.measure(measureName, markName, endMarkName);

            const duration = performance.now() - start;
            this.recordMetric(name, duration, 'success', metadata);

            return result;
        } catch (error) {
            const duration = performance.now() - start;
            this.recordMetric(name, duration, 'error', { ...metadata, error: error.message });
            throw error;
        }
    }

    /**
     * 测量同步函数
     */
    measureSync(name, fn, metadata = {}) {
        const start = performance.now();
        const markName = `${name}-start`;
        const endMarkName = `${name}-end`;
        const measureName = `${name}`;

        try {
            performance.mark(markName);
            const result = fn();
            performance.mark(endMarkName);
            performance.measure(measureName, markName, endMarkName);

            const duration = performance.now() - start;
            this.recordMetric(name, duration, 'success', metadata);

            return result;
        } catch (error) {
            const duration = performance.now() - start;
            this.recordMetric(name, duration, 'error', { ...metadata, error: error.message });
            throw error;
        }
    }

    /**
     * 记录指标
     */
    recordMetric(name, value, status = 'success', metadata = {}) {
        if (!this.metrics.has(name)) {
            this.metrics.set(name, []);
        }

        const threshold = this.thresholds[name];
        const record = {
            value,
            status,
            timestamp: Date.now(),
            exceeded: threshold && value > threshold,
            metadata,
        };

        this.metrics.get(name).push(record);

        // 只保留最近 200 条记录
        const records = this.metrics.get(name);
        if (records.length > 200) {
            records.shift();
        }

        // 触发事件
        if (record.exceeded) {
            this.emit('metricExceeded', {
                name,
                value,
                threshold,
                metadata,
            });
        }

        if (status === 'error') {
            this.emit('metricError', {
                name,
                error: metadata.error,
                metadata,
            });
        }

        return record;
    }

    /**
     * 开始计时
     */
    startTimer(name) {
        this.marks.set(name, performance.now());
    }

    /**
     * 停止计时
     */
    stopTimer(name, metadata = {}) {
        const start = this.marks.get(name);
        if (!start) {
            console.warn(`计时器 '${name}' 未启动`);
            return null;
        }

        const duration = performance.now() - start;
        this.marks.delete(name);

        this.recordMetric(name, duration, 'success', metadata);
        return duration;
    }

    /**
     * 标记事件
     */
    mark(name) {
        performance.mark(name);
    }

    /**
     * 测量两个标记之间的时间
     */
    measure(name, startMark, endMark) {
        try {
            performance.measure(name, startMark, endMark);
            const measure = performance.getEntriesByName(name, 'measure')[0];
            return measure?.duration || 0;
        } catch (e) {
            console.error(`测量失败: ${name}`, e);
            return 0;
        }
    }

    /**
     * 获取指标统计
     */
    getStats(name) {
        const records = this.metrics.get(name) || [];
        if (records.length === 0) return null;

        const values = records.map(r => r.value);
        const sorted = values.slice().sort((a, b) => a - b);

        return {
            count: records.length,
            min: Math.min(...values),
            max: Math.max(...values),
            avg: values.reduce((a, b) => a + b, 0) / values.length,
            median: this._getMedian(sorted),
            p50: this._getPercentile(sorted, 50),
            p75: this._getPercentile(sorted, 75),
            p90: this._getPercentile(sorted, 90),
            p95: this._getPercentile(sorted, 95),
            p99: this._getPercentile(sorted, 99),
            errors: records.filter(r => r.status === 'error').length,
            threshold: this.thresholds[name] || null,
            exceeded: records.filter(r => r.exceeded).length,
            successRate: ((records.filter(r => r.status === 'success').length / records.length) * 100).toFixed(2) + '%',
        };
    }

    /**
     * 获取所有指标
     */
    getAllStats() {
        const stats = {};
        for (const [name] of this.metrics) {
            stats[name] = this.getStats(name);
        }
        return stats;
    }

    /**
     * 获取浏览器性能指标
     */
    getBrowserMetrics() {
        if (!window.performance || !window.performance.timing) {
            return null;
        }

        const timing = window.performance.timing;
        return {
            // 网络阶段
            dns: timing.domainLookupEnd - timing.domainLookupStart,
            tcp: timing.connectEnd - timing.connectStart,
            ttfb: timing.responseStart - timing.requestStart, // Time To First Byte
            download: timing.responseEnd - timing.responseStart,

            // 渲染阶段
            domParsing: timing.domInteractive - timing.domLoading,
            domContent: timing.domContentLoadedEventEnd - timing.domContentLoadedEventStart,
            resourceLoading: timing.loadEventStart - timing.domContentLoadedEventEnd,
            pageComplete: timing.loadEventEnd - timing.navigationStart,

            // 总计
            total: timing.loadEventEnd - timing.navigationStart,
        };
    }

    /**
     * 获取内存使用
     */
    getMemoryUsage() {
        if (!performance.memory) {
            return null;
        }

        const memory = performance.memory;
        return {
            usedJSHeapSize: (memory.usedJSHeapSize / 1048576).toFixed(2) + ' MB',
            totalJSHeapSize: (memory.totalJSHeapSize / 1048576).toFixed(2) + ' MB',
            jsHeapSizeLimit: (memory.jsHeapSizeLimit / 1048576).toFixed(2) + ' MB',
            percentUsed: ((memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100).toFixed(2) + '%',
        };
    }

    /**
     * 生成完整报告
     */
    generateReport() {
        return {
            timestamp: new Date().toISOString(),
            url: window.location.href,
            userAgent: navigator.userAgent,
            
            // 应用指标
            metrics: this.getAllStats(),
            
            // 浏览器性能
            browserMetrics: this.getBrowserMetrics(),
            
            // 内存使用
            memory: this.getMemoryUsage(),
            
            // 网络状态
            network: {
                online: navigator.onLine,
                effectiveType: navigator.connection?.effectiveType,
                downlink: navigator.connection?.downlink,
                rtt: navigator.connection?.rtt,
            },
        };
    }

    /**
     * 生成性能概览
     */
    generateSummary() {
        const report = this.generateReport();
        const browserMetrics = report.browserMetrics;

        if (!browserMetrics) {
            return null;
        }

        return {
            // 关键指标
            'DOM 解析': `${browserMetrics.domParsing.toFixed(0)}ms`,
            'DOM 内容加载': `${browserMetrics.domContent.toFixed(0)}ms`,
            '页面完全加载': `${browserMetrics.pageComplete.toFixed(0)}ms`,
            'TTFB': `${browserMetrics.ttfb.toFixed(0)}ms`,

            // 性能等级
            'DNS 查询': browserMetrics.dns > 50 ? '⚠️ 较慢' : '✓ 正常',
            'TCP 连接': browserMetrics.tcp > 100 ? '⚠️ 较慢' : '✓ 正常',
            '页面下载': browserMetrics.download > 500 ? '⚠️ 较慢' : '✓ 正常',

            // 内存
            '内存使用': report.memory?.percentUsed || 'N/A',

            // 网络
            '网络状态': report.network.online ? '✓ 在线' : '✕ 离线',
        };
    }

    /**
     * 观察性能数据
     */
    _observePerformance() {
        try {
            // 观察长任务
            if ('PerformanceObserver' in window) {
                const observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        if (entry.duration > this.thresholds['LONG_TASK']) {
                            this.recordMetric('LONG_TASK', entry.duration, 'warning');
                        }
                    }
                });

                observer.observe({ entryTypes: ['longtask'] });
            }
        } catch (e) {
            console.debug('Performance Observer 不支持:', e);
        }
    }

    /**
     * 检查内存使用
     */
    _checkMemory() {
        if (!performance.memory) return;

        const memory = performance.memory;
        const percentUsed = (memory.usedJSHeapSize / memory.jsHeapSizeLimit) * 100;

        if (percentUsed > 85) {
            this.recordMetric('MEMORY_WARNING', percentUsed, 'warning');
        }
    }

    /**
     * 计算中位数
     */
    _getMedian(sorted) {
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0
            ? sorted[mid]
            : (sorted[mid - 1] + sorted[mid]) / 2;
    }

    /**
     * 计算百分位
     */
    _getPercentile(sorted, p) {
        const index = Math.ceil((sorted.length * p) / 100) - 1;
        return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
    }

    /**
     * 订阅指标事件
     */
    on(event, callback) {
        if (!this.listeners) {
            this.listeners = [];
        }
        this.listeners.push({ event, callback });
        return () => {
            this.listeners = this.listeners.filter(l => !(l.event === event && l.callback === callback));
        };
    }

    /**
     * 触发事件
     */
    emit(event, data) {
        this.listeners?.forEach(listener => {
            if (listener.event === event) {
                try {
                    listener.callback(data);
                } catch (e) {
                    console.error(`Metrics listener error: ${e}`);
                }
            }
        });
    }

    /**
     * 清除指标
     */
    clear() {
        this.metrics.clear();
        this.marks.clear();
        this.measures.clear();
        this.timings.clear();
    }

    /**
     * 导出数据
     */
    exportJSON(filename = `metrics-${Date.now()}.json`) {
        const data = this.generateReport();
        const json = JSON.stringify(data, null, 2);
        
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
}

export { MetricsCollector };
