// frontend/audit.js - 完整前端审计日志系统

class AuditLogger {
    constructor(app) {
        this.app = app;
        this.logs = [];
        this.maxLogs = 500;
        this.batchSize = 10;
        this.batchInterval = 30000; // 30 秒
        this.pendingLogs = [];
        this.syncTimer = null;
    }

    /**
     * 记录用户操作
     * @param {string} action - 操作类型 (LOGIN, CREATE, UPDATE, DELETE, VIEW, EXPORT, etc.)
     * @param {string} resourceType - 资源类型 (SERVER, USER, CONFIG, etc.)
     * @param {any} resourceId - 资源 ID
     * @param {string} status - 操作状态 (success/failure)
     * @param {any} details - 详细信息
     */
    log(action, resourceType, resourceId, status = 'success', details = null) {
        const entry = {
            id: Date.now() + Math.random(),
            timestamp: new Date().toISOString(),
            userId: this.app.store.state.currentUser?.id,
            username: this.app.store.state.currentUser?.username || 'anonymous',
            
            // 操作信息
            action,
            resourceType,
            resourceId: String(resourceId),
            status,
            details: details || {},
            
            // 环境信息
            userAgent: navigator.userAgent,
            ipAddress: null, // 后端会填充
            url: window.location.href,
            
            // 时间戳
            createdAt: new Date(),
        };

        // 添加到本地日志
        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // 添加到待发送队列
        this.pendingLogs.push(entry);

        // 控制台输出
        this._logToConsole(entry);

        // 启动批量同步
        this._startBatchSync();

        // 触发事件
        this.app.eventBus.emit('auditLog', entry);

        return entry.id;
    }

    /**
     * 记录登录操作
     */
    logLogin(username, success = true) {
        return this.log(
            'LOGIN',
            'User',
            username,
            success ? 'success' : 'failure',
            { username }
        );
    }

    /**
     * 记录登出操作
     */
    logLogout() {
        return this.log(
            'LOGOUT',
            'User',
            this.app.store.state.currentUser?.id,
            'success'
        );
    }

    /**
     * 记录服务器操作
     */
    logServerAction(action, serverId, details = {}) {
        return this.log(action, 'SERVER', serverId, 'success', details);
    }

    /**
     * 记录导出操作
     */
    logExport(dataType, count) {
        return this.log(
            'EXPORT',
            'Data',
            dataType,
            'success',
            { type: dataType, count }
        );
    }

    /**
     * 记录错误
     */
    logError(action, resourceType, resourceId, error) {
        return this.log(
            action,
            resourceType,
            resourceId,
            'failure',
            { error: String(error), stack: error?.stack }
        );
    }

    /**
     * 批量同步日志到后端
     */
    _startBatchSync() {
        if (this.syncTimer) {
            return; // 已经有同步任务在进行
        }

        this.syncTimer = setInterval(() => {
            this._syncLogs();
        }, this.batchInterval);
    }

    /**
     * 同步日志
     */
    async _syncLogs() {
        if (this.pendingLogs.length === 0) {
            return;
        }

        const batch = this.pendingLogs.splice(0, this.batchSize);

        try {
            await this.app.api.request('/audit/logs/batch', {
                method: 'POST',
                body: { logs: batch },
            });

            this.app.logger?.info(`✓ 已同步 ${batch.length} 条审计日志`);
        } catch (error) {
            // 重新加入队列
            this.pendingLogs.unshift(...batch);
            this.app.logger?.warn('审计日志同步失败:', error);
        }

        // 如果没有待发送日志，停止定时器
        if (this.pendingLogs.length === 0) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }

    /**
     * 控制台输出
     */
    _logToConsole(entry) {
        const colors = {
            LOGIN: '#4CAF50',
            LOGOUT: '#FF9800',
            CREATE: '#2196F3',
            UPDATE: '#FF9800',
            DELETE: '#F44336',
            VIEW: '#9C27B0',
            EXPORT: '#00BCD4',
            success: '#4CAF50',
            failure: '#F44336',
        };

        const color = colors[entry.action] || '#666';
        const statusColor = colors[entry.status] || '#666';

        console.log(
            `%c[AUDIT] %c${entry.action} %c${entry.resourceType}#${entry.resourceId} %c${entry.status}`,
            `color: ${color}; font-weight: bold;`,
            `color: ${color};`,
            `color: #666;`,
            `color: ${statusColor}; font-weight: bold;`,
            entry.details
        );
    }

    /**
     * 导出日志为 CSV
     */
    exportCSV(filename = `audit-logs-${Date.now()}.csv`) {
        const headers = [
            '时间',
            '用户',
            '操作',
            '资源类型',
            '资源ID',
            '状态',
            '详情',
        ];

        const rows = this.logs.map(log => [
            log.timestamp,
            log.username,
            log.action,
            log.resourceType,
            log.resourceId,
            log.status,
            JSON.stringify(log.details),
        ]);

        const csv = [
            headers.join(','),
            ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')),
        ].join('\n');

        this._downloadFile(csv, filename, 'text/csv; charset=utf-8');
    }

    /**
     * 导出日志为 JSON
     */
    exportJSON(filename = `audit-logs-${Date.now()}.json`) {
        const json = JSON.stringify(this.logs, null, 2);
        this._downloadFile(json, filename, 'application/json; charset=utf-8');
    }

    /**
     * 下载文件
     */
    _downloadFile(content, filename, mimeType) {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    /**
     * 获取日志
     */
    getLogs(filters = {}) {
        let logs = [...this.logs];

        if (filters.action) {
            logs = logs.filter(l => l.action === filters.action);
        }

        if (filters.resourceType) {
            logs = logs.filter(l => l.resourceType === filters.resourceType);
        }

        if (filters.status) {
            logs = logs.filter(l => l.status === filters.status);
        }

        if (filters.username) {
            logs = logs.filter(l => l.username === filters.username);
        }

        if (filters.startTime) {
            const start = new Date(filters.startTime);
            logs = logs.filter(l => new Date(l.timestamp) >= start);
        }

        if (filters.endTime) {
            const end = new Date(filters.endTime);
            logs = logs.filter(l => new Date(l.timestamp) <= end);
        }

        return logs;
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            total: this.logs.length,
            pending: this.pendingLogs.length,
            byAction: this._groupBy(this.logs, 'action'),
            byStatus: this._groupBy(this.logs, 'status'),
            byUser: this._groupBy(this.logs, 'username'),
        };
    }

    /**
     * 分组统计
     */
    _groupBy(array, key) {
        return array.reduce((result, item) => {
            const group = item[key];
            result[group] = (result[group] || 0) + 1;
            return result;
        }, {});
    }

    /**
     * 清除待发送队列并强制同步
     */
    async forceSyncAll() {
        while (this.pendingLogs.length > 0) {
            await this._syncLogs();
        }
    }

    /**
     * 清理资源
     */
    destroy() {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = null;
        }
    }
}

export { AuditLogger };
