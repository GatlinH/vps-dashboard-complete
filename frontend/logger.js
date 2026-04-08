/**
 * frontend/logger.js - 日志和错误处理
 */

class Logger {
    constructor(level = 'info') {
        this.level = level;
        this.logs = [];
        this.maxLogs = 100;
    }

    log(message, data = null, level = 'info') {
        const entry = {
            timestamp: new Date().toISOString(),
            level,
            message,
            data,
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        this._output(entry);
    }

    info(message, data) {
        this.log(message, data, 'info');
    }

    warn(message, data) {
        this.log(message, data, 'warn');
    }

    error(message, data) {
        this.log(message, data, 'error');
    }

    debug(message, data) {
        this.log(message, data, 'debug');
    }

    _output(entry) {
        const { level, message, data } = entry;
        const style = this._getStyle(level);
        
        if (data) {
            console.log(`%c[${level.toUpperCase()}] ${message}`, style, data);
        } else {
            console.log(`%c[${level.toUpperCase()}] ${message}`, style);
        }
    }

    _getStyle(level) {
        const styles = {
            info: 'color: #63b3ed; font-weight: bold;',
            warn: 'color: #ff9f43; font-weight: bold;',
            error: 'color: #ff6b6b; font-weight: bold;',
            debug: 'color: #a78bfa; font-weight: bold;',
        };
        return styles[level] || styles.info;
    }

    getLogs() {
        return [...this.logs];
    }

    exportLogs() {
        const csv = this.logs.map(log => 
            `"${log.timestamp}","${log.level}","${log.message}","${JSON.stringify(log.data)}"`
        ).join('\n');
        
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `logs-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }
}

export { Logger };
