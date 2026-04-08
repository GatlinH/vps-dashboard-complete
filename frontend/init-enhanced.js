// frontend/init-enhanced.js - 完整的模块初始化脚本

import app from './app.js';
import { ChartManager } from './charts.js';
import { PerformanceOptimizer } from './performance.js';
import { Logger } from './logger.js';
import { I18nManager } from './i18n.js';
import { AuditLogger } from './audit.js';
import { ErrorBoundary } from './error-boundary.js';
import { NotificationManager } from './notifications.js';
import { MetricsCollector } from './metrics.js';
import { DataExporter } from './export.js';
import { SecureStorage } from './secure-storage.js';

/**
 * 初始化所有增强模块
 */
async function initializeEnhancedModules() {
    console.log('🚀 初始化增强模块...');

    // ===== 核心模块 =====
    const chartManager = new ChartManager(app);
    const perfOptimizer = new PerformanceOptimizer(app);
    const logger = new Logger('info');
    
    // ===== 国际化 =====
    const i18n = new I18nManager(navigator.language || 'zh-CN');
    
    // ===== 审计与监控 =====
    const audit = new AuditLogger(app);
    const metrics = new MetricsCollector();
    
    // ===== 用户界面 =====
    const errorBoundary = new ErrorBoundary(app, logger);
    const notifications = new NotificationManager();
    
    // ===== 存储 =====
    const secureStorage = new SecureStorage();
    
    // ===== 暴露到全局 =====
    window.logger = logger;
    window.app = app;
    window.chartManager = chartManager;
    window.perfOptimizer = perfOptimizer;
    window.i18n = i18n;
    window.audit = audit;
    window.notifications = notifications;
    window.metrics = metrics;
    window.DataExporter = DataExporter;
    window.secureStorage = secureStorage;

    logger.info('✓ 所有增强模块初始化完成');

    return {
        app,
        chartManager,
        perfOptimizer,
        logger,
        i18n,
        audit,
        errorBoundary,
        notifications,
        metrics,
        secureStorage,
    };
}

/**
 * 注册所有事件监听器
 */
function registerEventListeners(modules) {
    const { app, chartManager, audit, notifications, metrics, secureStorage } = modules;

    // ===== 应用就绪 =====
    app.eventBus.on('appReady', async () => {
        modules.logger.info('🚀 应用初始化开始');
        
        try {
            // 加载服务器列表
            await modules.metrics.measureAsync('LOAD_SERVERS', () => app.loadServers());
            modules.logger.info('✓ 服务器列表已加载');
            audit.log('APP_INIT', 'Application', 'system', 'success');
            
            // 初始化图表
            setTimeout(async () => {
                const servers = app.store.state.servers;
                if (servers.length > 0) {
                    modules.logger.info('📊 初始化图表...');
                    
                    try {
                        await modules.metrics.measureAsync('CREATE_CPU_CHART', () =>
                            chartManager.createCPUChart('cpuChart', servers[0])
                        );
                        audit.logServerAction('VIEW_CHART', servers[0].id, { chart: 'cpu' });
                    } catch (e) {
                        modules.logger.warn('CPU 图表初始化失败', e);
                        audit.logError('CREATE_CHART', 'Chart', 'cpu', e);
                    }
                    
                    try {
                        await modules.metrics.measureAsync('CREATE_TRAFFIC_CHART', () =>
                            chartManager.createTrafficChart('trafficChart', servers)
                        );
                        audit.logServerAction('VIEW_CHART', 'all', { chart: 'traffic' });
                    } catch (e) {
                        modules.logger.warn('流量图表初始化失败', e);
                        audit.logError('CREATE_CHART', 'Chart', 'traffic', e);
                    }
                }
            }, 300);
            
            // 启用性能优化
            perfOptimizer.enableRequestDeduplication(app.api);
            modules.logger.info('✓ 性能优化已启用');
            
        } catch (error) {
            modules.logger.error('❌ 应用初始化失败', error);
            audit.log('APP_INIT', 'Application', 'system', 'failure', { error: error.message });
        }
    });

    // ===== 登录事件 =====
    app.eventBus.on('loginSuccess', (user) => {
        modules.logger.info('👤 用户已登录', { username: user.username });
        notifications.success(`欢迎，${user.username}！`);
        audit.logLogin(user.username, true);
        
        // 保存加密的 Token
        secureStorage.setEncrypted('authToken', app.api.token).catch(e => {
            modules.logger.warn('Token 保存失败:', e);
        });
        
        app.startMetricsPolling(15000);
    });

    // ===== 登出事件 =====
    app.eventBus.on('logoutSuccess', () => {
        modules.logger.info('👋 用户已登出');
        audit.logLogout();
        notifications.info('已安全登出');
        
        // 清除安全存储
        secureStorage.removeEncrypted('authToken');
        chartManager.destroyAll();
    });

    // ===== 服务器操作 =====
    app.eventBus.on('serverCreated', (server) => {
        notifications.success(`服务器 '${server.name}' 创建成功`);
        audit.logServerAction('CREATE', server.id, { name: server.name });
        modules.logger.info(`✓ 服务器已创建: ${server.name}`);
    });

    app.eventBus.on('serverUpdated', (server) => {
        notifications.success(`服务器 '${server.name}' 更新成功`);
        audit.logServerAction('UPDATE', server.id, { name: server.name });
        modules.logger.info(`✓ 服务器已更新: ${server.name}`);
    });

    app.eventBus.on('serverDeleted', (id) => {
        notifications.success('服务器已删除');
        audit.logServerAction('DELETE', id);
        modules.logger.info(`✓ 服务器已删除: ${id}`);
    });

    // ===== 指标更新 =====
    app.eventBus.on('metricsUpdated', () => {
        modules.logger.debug('🔄 指标已更新');
    });

    // ===== 错误事件 =====
    app.eventBus.on('error', (errorObj) => {
        modules.logger.error('⚠️ 应用错误', errorObj);
        notifications.error(errorObj.message || '应用发生错误');
        audit.logError('ERROR', 'Application', 'system', errorObj);
    });

    // ===== 性能监控告警 =====
    metrics.on('metricExceeded', ({ name, value, threshold }) => {
        modules.logger.warn(`⚠️ 性能告警: ${name} 超过阈值`, {
            value: `${value.toFixed(2)}ms`,
            threshold: `${threshold}ms`,
        });
        notifications.warning(
            `性能告警: ${name} 为 ${value.toFixed(0)}ms（阈值: ${threshold}ms）`,
            5000
        );
    });

    // ===== 网络状态 =====
    app.eventBus.on('networkOffline', ({ reason }) => {
        modules.logger.warn('📡 网络已离线', { reason });
        notifications.warning('网络已离线，某些功能可能受限');
    });

    app.eventBus.on('networkOnline', () => {
        modules.logger.info('📡 网络已恢复');
        notifications.success('网络已恢复');
        
        // 尝试同步离线操作
        audit.forceSyncAll().catch(e => {
            modules.logger.warn('同步失败:', e);
        });
    });

    // ===== 定期上报性能指标 =====
    setInterval(() => {
        const stats = metrics.getAllStats();
        const exceeded = Object.entries(stats)
            .filter(([_, s]) => s && s.exceeded > 0)
            .map(([name]) => name);
        
        if (exceeded.length > 0) {
            modules.logger.warn('⚠️ 性能指标超过阈值', { exceeded });
        }

        // 可以发送到后端进行分析
        if (app.store.state.isAuthenticated) {
            // 可选：上报性能数据到后端
        }
    }, 60000); // 每分钟检查一次

    // ===== 页面卸载时清理 =====
    window.addEventListener('beforeunload', async () => {
        modules.logger.info('🧹 清理资源...');
        
        // 强制同步审计日志
        await audit.forceSyncAll();
        
        // 清理资源
        perfOptimizer.destroy();
        chartManager.destroyAll();
        errorBoundary.cleanup();
        metrics.clear();
    });
}

/**
 * 启动应用
 */
async function bootstrap() {
    try {
        // 初始化模块
        const modules = await initializeEnhancedModules();
        
        // 注册事件监听器
        registerEventListeners(modules);
        
        // 注册 Service Worker（离线支持）
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('/frontend/service-worker.js');
                modules.logger.info('✓ Service Worker 已注册');
                
                // 监听更新
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            modules.notifications.info('应用已更新，页面刷新后生效', 0, {
                                action: {
                                    text: '刷新',
                                    callback: () => location.reload(),
                                },
                            });
                        }
                    });
                });
            } catch (e) {
                modules.logger.warn('Service Worker 注册失败:', e);
            }
        }
        
        // 最终初始化完成
        modules.logger.info('✅ 应用启动完成');
        
    } catch (error) {
        console.error('❌ 应用启动失败:', error);
    }
}

// 等待 DOM 准备就绪后启动
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
} else {
    bootstrap();
}
