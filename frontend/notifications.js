// frontend/notifications.js - 完整通知系统

class NotificationManager {
    constructor(options = {}) {
        this.notifications = [];
        this.maxNotifications = options.maxNotifications || 50;
        this.container = null;
        this.position = options.position || 'top-right';
        this.init();
    }

    /**
     * 初始化容器
     */
    init() {
        this.container = document.createElement('div');
        this.container.id = 'notification-container';
        this.container.style.cssText = `
            position: fixed;
            ${this._getPositionStyles()}
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 10px;
            max-width: 400px;
            pointer-events: none;
        `;
        document.body.appendChild(this.container);
        
        // 添加样式
        this._addStyles();
    }

    /**
     * 获取位置样式
     */
    _getPositionStyles() {
        const positions = {
            'top-right': 'top: 20px; right: 20px;',
            'top-left': 'top: 20px; left: 20px;',
            'bottom-right': 'bottom: 20px; right: 20px;',
            'bottom-left': 'bottom: 20px; left: 20px;',
            'top-center': 'top: 20px; left: 50%; transform: translateX(-50%);',
        };
        return positions[this.position] || positions['top-right'];
    }

    /**
     * 显示通知
     */
    notify(message, type = 'info', duration = 3000, options = {}) {
        const id = Date.now() + Math.random();
        const notification = {
            id,
            message,
            type,
            duration,
            timestamp: new Date(),
            dismissed: false,
            action: options.action,
            ...options,
        };

        this.notifications.push(notification);
        if (this.notifications.length > this.maxNotifications) {
            const oldest = this.notifications.shift();
            this._removeElement(oldest.id);
        }

        this._render(notification);

        if (duration > 0) {
            setTimeout(() => this.dismiss(id), duration);
        }

        return id;
    }

    /**
     * 成功通知
     */
    success(message, duration = 3000, options = {}) {
        return this.notify(message, 'success', duration, options);
    }

    /**
     * 错误通知
     */
    error(message, duration = 5000, options = {}) {
        return this.notify(message, 'error', duration, options);
    }

    /**
     * 警告通知
     */
    warning(message, duration = 4000, options = {}) {
        return this.notify(message, 'warning', duration, options);
    }

    /**
     * 信息通知
     */
    info(message, duration = 3000, options = {}) {
        return this.notify(message, 'info', duration, options);
    }

    /**
     * 关闭通知
     */
    dismiss(id) {
        const notification = this.notifications.find(n => n.id === id);
        if (notification) {
            notification.dismissed = true;
            this._removeElement(id);
        }
    }

    /**
     * 渲染通知
     */
    _render(notification) {
        const el = document.createElement('div');
        el.id = `notification-${notification.id}`;
        el.className = `notification notification-${notification.type}`;
        el.style.cssText = `
            padding: 12px 16px;
            border-radius: 8px;
            font-size: 14px;
            animation: slideIn 0.3s ease-out;
            cursor: pointer;
            user-select: none;
            pointer-events: auto;
            box-shadow: 0 2px 8px rgba(0,0,0,0.15);
            display: flex;
            align-items: center;
            gap: 8px;
            ${this._getTypeStyle(notification.type)}
        `;

        // 添加图标
        const icon = document.createElement('span');
        icon.innerHTML = this._getTypeIcon(notification.type);
        icon.style.cssText = 'flex-shrink: 0; font-size: 16px;';

        // 添加消息
        const message = document.createElement('span');
        message.textContent = notification.message;
        message.style.cssText = 'flex: 1;';

        // 添加操作按钮（可选）
        if (notification.action) {
            const button = document.createElement('button');
            button.textContent = notification.action.text || '操作';
            button.style.cssText = `
                background: transparent;
                border: none;
                color: inherit;
                cursor: pointer;
                font-weight: bold;
                margin-left: 8px;
                padding: 0;
                text-decoration: underline;
            `;
            button.onclick = (e) => {
                e.stopPropagation();
                notification.action.callback?.();
                this.dismiss(notification.id);
            };
            el.appendChild(button);
        }

        el.appendChild(icon);
        el.appendChild(message);

        el.onclick = () => this.dismiss(notification.id);

        this.container.appendChild(el);
    }

    /**
     * 删除元素
     */
    _removeElement(id) {
        const el = document.getElementById(`notification-${id}`);
        if (el) {
            el.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => {
                el.remove();
            }, 300);
        }
    }

    /**
     * 获取类型样式
     */
    _getTypeStyle(type) {
        const styles = {
            success: `
                background-color: #d4edda;
                border: 1px solid #c3e6cb;
                color: #155724;
            `,
            error: `
                background-color: #f8d7da;
                border: 1px solid #f5c6cb;
                color: #721c24;
            `,
            warning: `
                background-color: #fff3cd;
                border: 1px solid #ffeeba;
                color: #856404;
            `,
            info: `
                background-color: #d1ecf1;
                border: 1px solid #bee5eb;
                color: #0c5460;
            `,
        };
        return styles[type] || styles.info;
    }

    /**
     * 获取类型图标
     */
    _getTypeIcon(type) {
        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ⓘ',
        };
        return icons[type] || 'ⓘ';
    }

    /**
     * 添加样式
     */
    _addStyles() {
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideIn {
                from {
                    opacity: 0;
                    transform: translateX(100%);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }
            
            @keyframes slideOut {
                from {
                    opacity: 1;
                    transform: translateX(0);
                }
                to {
                    opacity: 0;
                    transform: translateX(100%);
                }
            }
            
            .notification {
                min-width: 300px;
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            total: this.notifications.length,
            dismissed: this.notifications.filter(n => n.dismissed).length,
            active: this.notifications.filter(n => !n.dismissed).length,
            byType: {
                success: this.notifications.filter(n => n.type === 'success').length,
                error: this.notifications.filter(n => n.type === 'error').length,
                warning: this.notifications.filter(n => n.type === 'warning').length,
                info: this.notifications.filter(n => n.type === 'info').length,
            },
        };
    }

    /**
     * 清空所有通知
     */
    clearAll() {
        this.notifications.forEach(n => this.dismiss(n.id));
    }
}

export { NotificationManager };
