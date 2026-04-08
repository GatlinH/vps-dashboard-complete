// frontend/error-boundary.js - 完整错误处理

class ErrorBoundary {
    constructor(app, logger) {
        this.app = app;
        this.logger = logger;
        this.errorHandlers = new Map();
        this.setupGlobalHandlers();
    }

    /**
     * 设置全局错误处理器
     */
    setupGlobalHandlers() {
        // 1. 未捕获的同步错误
        window.addEventListener('error', (event) => {
            this.handleError({
                type: 'UncaughtError',
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno,
                stack: event.error?.stack,
                timestamp: new Date(),
            });
        });

        // 2. 未捕获的 Promise 拒绝
        window.addEventListener('unhandledrejection', (event) => {
            this.handleError({
                type: 'UnhandledPromiseRejection',
                reason: event.reason,
                promise: event.promise,
                timestamp: new Date(),
            });
            
            // 阻止浏览器的默认处理
            event.preventDefault();
        });

        // 3. 网络离线
        window.addEventListener('offline', () => {
            this.handleNetworkError('offline');
        });

        // 4. 网络在线
        window.addEventListener('online', () => {
            this.logger.info('✓ 网络已恢复');
            this.app.eventBus.emit('networkOnline');
        });

        // 5. 页面卸载时清理
        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });

        // 6. 安全策略违反
        window.addEventListener('securitypolicyviolation', (event) => {
            this.handleError({
                type: 'SecurityPolicyViolation',
                message: `CSP违反: ${event.violatedDirective}`,
                blockedURI: event.blockedURI,
                timestamp: new Date(),
            });
        });

        // 7. 资源加载错误
        window.addEventListener('error', (event) => {
            if (event.target !== window) {
                this.handleResourceError({
                    type: 'ResourceLoadError',
                    tag: event.target.tagName,
                    src: event.target.src || event.target.href,
                    timestamp: new Date(),
                });
            }
        }, true);
    }

    /**
     * 处理错误
     */
    handleError(error) {
        this.logger.error('🚨 捕获到错误', error);

        // 调用相应的错误处理器
        const handler = this.errorHandlers.get(error.type);
        if (handler) {
            try {
                handler(error);
            } catch (e) {
                this.logger.error('错误处理器执行失败:', e);
            }
        }

        // 上报到后端
        this.reportError(error).catch((e) => {
            this.logger.warn('❌ 错误上报失败:', e);
        });

        // 显示用户友好的错误提示
        const userMessage = this.getUserFriendlyMessage(error);
        this.app.store.addError(userMessage, 5000);

        // 触发全局错误事件
        this.app.eventBus.emit('errorCaught', error);
    }

    /**
     * 处理网络错误
     */
    handleNetworkError(reason) {
        this.logger.warn('⚠️ 网络错误', { reason });
        
        this.app.store.addError(`网络连接中断${reason === 'offline' ? '' : ': ' + reason}`, 5000);
        this.app.eventBus.emit('networkOffline', { reason });
    }

    /**
     * 处理资源加载错误
     */
    handleResourceError(error) {
        this.logger.warn('⚠️ 资源加载失败', error);
        
        // 某些资源加载失败不需要弹出错误提示
        const nonCriticalResources = ['/assets/', '/images/', '.png', '.jpg', '.gif'];
        const isCritical = !nonCriticalResources.some(r => error.src?.includes(r));
        
        if (isCritical) {
            this.app.store.addError(`加载资源失败: ${error.src}`, 4000);
        }
    }

    /**
     * 注册自定义错误处理器
     */
    registerErrorHandler(errorType, handler) {
        this.errorHandlers.set(errorType, handler);
    }

    /**
     * 获取用户友好的错误消息
     */
    getUserFriendlyMessage(error) {
        const messageMap = {
            'UncaughtError': '应用发生了一个错误',
            'UnhandledPromiseRejection': '操作未能完成',
            'ResourceLoadError': '资源加载失败，请刷新页面',
            'SecurityPolicyViolation': '安全策略限制了此操作',
            'NetworkError': '网络连接失败',
            'TypeError': '数据类型错误',
            'ReferenceError': '引用错误',
            'RangeError': '范围超出',
            'SyntaxError': '语法错误',
        };
        
        return messageMap[error.type] || `发生错误: ${error.message || '未知'}`;
    }

    /**
     * 上报错误到后端
     */
    async reportError(error) {
        try {
            // 收集错误信息
            const errorReport = {
                type: error.type,
                message: error.message,
                stack: error.stack,
                url: window.location.href,
                userAgent: navigator.userAgent,
                timestamp: (error.timestamp || new Date()).toISOString(),
                
                // 浏览器信息
                browser: this.getBrowserInfo(),
                
                // 内存信息
                memory: this.getMemoryInfo(),
                
                // 应用状态
                appState: {
                    currentUser: this.app.store.state.currentUser?.username,
                    currentPage: this.app.store.state.currentPage,
                    isOnline: navigator.onLine,
                },
                
                // 额外信息
                extra: {
                    lineno: error.lineno,
                    colno: error.colno,
                    filename: error.filename,
                },
            };

            // 发送到后端
            await this.app.api.request('/errors/report', {
                method: 'POST',
                body: errorReport,
            });

            this.logger.info('✓ 错误已上报');
        } catch (e) {
            this.logger.error('上报错误失败:', e);
        }
    }

    /**
     * 获取浏览器信息
     */
    getBrowserInfo() {
        const ua = navigator.userAgent;
        return {
            name: this.getBrowserName(ua),
            version: this.getBrowserVersion(ua),
            platform: navigator.platform,
            language: navigator.language,
            cookiesEnabled: navigator.cookieEnabled,
            onLine: navigator.onLine,
        };
    }

    /**
     * 获取浏览器名称
     */
    getBrowserName(ua) {
        if (ua.indexOf('Firefox') > -1) return 'Firefox';
        if (ua.indexOf('Chrome') > -1) return 'Chrome';
        if (ua.indexOf('Safari') > -1) return 'Safari';
        if (ua.indexOf('Edge') > -1) return 'Edge';
        if (ua.indexOf('Opera') > -1 || ua.indexOf('OPR') > -1) return 'Opera';
        if (ua.indexOf('Trident') > -1) return 'IE';
        return 'Unknown';
    }

    /**
     * 获取浏览器版本
     */
    getBrowserVersion(ua) {
        const match = ua.match(/(?:Firefox|Chrome|Safari|Edge|OPR|Trident)[\s/](\d+)/);
        return match ? match[1] : 'Unknown';
    }

    /**
     * 获取内存信息
     */
    getMemoryInfo() {
        if (!performance.memory) {
            return null;
        }

        return {
            usedJSHeapSize: Math.round(performance.memory.usedJSHeapSize / 1048576) + ' MB',
            totalJSHeapSize: Math.round(performance.memory.totalJSHeapSize / 1048576) + ' MB',
            jsHeapSizeLimit: Math.round(performance.memory.jsHeapSizeLimit / 1048576) + ' MB',
        };
    }

    /**
     * 清理资源
     */
    cleanup() {
        this.errorHandlers.clear();
        this.logger.info('✓ 错误边界已清理');
    }
}

export { ErrorBoundary };
