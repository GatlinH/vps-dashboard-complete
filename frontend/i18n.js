// frontend/i18n.js - 完整的国际化系统

class I18nManager {
    constructor(defaultLang = 'zh-CN') {
        this.currentLang = localStorage.getItem('lang') || defaultLang;
        this.listeners = [];
        
        this.messages = {
            'zh-CN': {
                // 通用
                'common.error': '错误',
                'common.success': '成功',
                'common.warning': '警告',
                'common.info': '信息',
                'common.loading': '加载中...',
                'common.delete': '删除',
                'common.edit': '编辑',
                'common.save': '保存',
                'common.cancel': '取消',
                'common.confirm': '确认',
                'common.close': '关闭',
                'common.back': '返回',
                'common.submit': '提交',
                'common.refresh': '刷新',
                'common.export': '导出',
                'common.import': '导入',
                'common.search': '搜索',
                'common.filter': '筛选',
                'common.sort': '排序',
                'common.noData': '暂无数据',
                'common.loading': '加载中...',
                'common.error': '错误',
                'common.retry': '重试',
                'common.skip': '跳过',
                
                // 认证
                'auth.login': '登录',
                'auth.logout': '登出',
                'auth.register': '注册',
                'auth.username': '用户名',
                'auth.password': '密码',
                'auth.confirmPassword': '确认密码',
                'auth.email': '邮箱',
                'auth.phone': '手机',
                'auth.loginFailed': '登录失败',
                'auth.loginSuccess': '登录成功',
                'auth.logoutSuccess': '登出成功',
                'auth.unauthorized': '未授权',
                'auth.tokenExpired': '令牌已过期，请重新登录',
                'auth.accountLocked': '账户已锁定',
                'auth.invalidCredentials': '用户名或密码错误',
                'auth.usernameRequired': '请输入用户名',
                'auth.passwordRequired': '请输入密码',
                'auth.passwordTooShort': '密码至少需要 6 个字符',
                'auth.passwordsNotMatch': '两次输入的密码不一致',
                
                // 服务器
                'server.name': '服务器名称',
                'server.ip': '服务器 IP',
                'server.location': '位置',
                'server.cpu': 'CPU',
                'server.ram': '内存',
                'server.disk': '磁盘',
                'server.bandwidth': '带宽',
                'server.status': '状态',
                'server.online': '在线',
                'server.offline': '离线',
                'server.warning': '预警',
                'server.unknown': '未知',
                'server.addServer': '添加服务器',
                'server.deleteServer': '删除服务器',
                'server.updateServer': '更新服务器',
                'server.listEmpty': '没有服务器',
                'server.confirmDelete': '确定要删除此服务器吗？',
                'server.deleteSuccess': '服务器已删除',
                'server.createSuccess': '服务器创建成功',
                'server.updateSuccess': '服务器更新成功',
                'server.createFailed': '创建服务器失败',
                'server.updateFailed': '更新服务器失败',
                'server.deleteFailed': '删除服务器失败',
                'server.group': '分组',
                'server.price': '价格',
                'server.expiry': '过期日期',
                'server.uptime': '运行时间',
                'server.latency': '延迟',
                
                // 图表
                'chart.cpu': 'CPU 使用率',
                'chart.memory': '内存使用率',
                'chart.disk': '磁盘使用率',
                'chart.traffic': '流量统计',
                'chart.cost': '成本趋势',
                'chart.trend': '趋势',
                'chart.noData': '暂无数据',
                'chart.loadingData': '加载数据��...',
                'chart.errorLoading': '加载数据失败',
                
                // 错误
                'error.networkFailed': '网络请求失败',
                'error.serverError': '服务器错误',
                'error.invalidInput': '输入无效',
                'error.timeout': '请求超时',
                'error.notFound': '资源不存在',
                'error.permissionDenied': '权限不足',
                'error.tooManyRequests': '请求过于频繁，请稍后再试',
                'error.badGateway': '网关错误，请稍后重试',
                'error.unknown': '发生未知错误',
                
                // 操作
                'operation.creating': '创建中...',
                'operation.updating': '更新中...',
                'operation.deleting': '删除中...',
                'operation.saving': '保存中...',
                'operation.loading': '加载中...',
                'operation.processing': '处理中...',
            },
            
            'en-US': {
                // Common
                'common.error': 'Error',
                'common.success': 'Success',
                'common.warning': 'Warning',
                'common.info': 'Info',
                'common.loading': 'Loading...',
                'common.delete': 'Delete',
                'common.edit': 'Edit',
                'common.save': 'Save',
                'common.cancel': 'Cancel',
                'common.confirm': 'Confirm',
                'common.close': 'Close',
                'common.back': 'Back',
                'common.submit': 'Submit',
                'common.refresh': 'Refresh',
                'common.export': 'Export',
                'common.import': 'Import',
                'common.search': 'Search',
                'common.filter': 'Filter',
                'common.sort': 'Sort',
                'common.noData': 'No data',
                'common.retry': 'Retry',
                'common.skip': 'Skip',
                
                // Auth
                'auth.login': 'Login',
                'auth.logout': 'Logout',
                'auth.register': 'Register',
                'auth.username': 'Username',
                'auth.password': 'Password',
                'auth.confirmPassword': 'Confirm Password',
                'auth.email': 'Email',
                'auth.phone': 'Phone',
                'auth.loginFailed': 'Login failed',
                'auth.loginSuccess': 'Login success',
                'auth.logoutSuccess': 'Logout success',
                'auth.unauthorized': 'Unauthorized',
                'auth.tokenExpired': 'Token expired, please login again',
                'auth.accountLocked': 'Account locked',
                'auth.invalidCredentials': 'Invalid username or password',
                'auth.usernameRequired': 'Please enter username',
                'auth.passwordRequired': 'Please enter password',
                'auth.passwordTooShort': 'Password must be at least 6 characters',
                'auth.passwordsNotMatch': 'Passwords do not match',
                
                // Server
                'server.name': 'Server Name',
                'server.ip': 'Server IP',
                'server.location': 'Location',
                'server.cpu': 'CPU',
                'server.ram': 'RAM',
                'server.disk': 'Disk',
                'server.bandwidth': 'Bandwidth',
                'server.status': 'Status',
                'server.online': 'Online',
                'server.offline': 'Offline',
                'server.warning': 'Warning',
                'server.unknown': 'Unknown',
                'server.addServer': 'Add Server',
                'server.deleteServer': 'Delete Server',
                'server.updateServer': 'Update Server',
                'server.listEmpty': 'No servers',
                'server.confirmDelete': 'Are you sure to delete this server?',
                'server.deleteSuccess': 'Server deleted',
                'server.createSuccess': 'Server created successfully',
                'server.updateSuccess': 'Server updated successfully',
                'server.createFailed': 'Failed to create server',
                'server.updateFailed': 'Failed to update server',
                'server.deleteFailed': 'Failed to delete server',
                'server.group': 'Group',
                'server.price': 'Price',
                'server.expiry': 'Expiry',
                'server.uptime': 'Uptime',
                'server.latency': 'Latency',
                
                // Chart
                'chart.cpu': 'CPU Usage',
                'chart.memory': 'Memory Usage',
                'chart.disk': 'Disk Usage',
                'chart.traffic': 'Traffic',
                'chart.cost': 'Cost Trend',
                'chart.trend': 'Trend',
                'chart.noData': 'No data',
                'chart.loadingData': 'Loading data...',
                'chart.errorLoading': 'Failed to load data',
                
                // Error
                'error.networkFailed': 'Network request failed',
                'error.serverError': 'Server error',
                'error.invalidInput': 'Invalid input',
                'error.timeout': 'Request timeout',
                'error.notFound': 'Resource not found',
                'error.permissionDenied': 'Permission denied',
                'error.tooManyRequests': 'Too many requests, please try again later',
                'error.badGateway': 'Gateway error, please try again later',
                'error.unknown': 'An unknown error occurred',
                
                // Operation
                'operation.creating': 'Creating...',
                'operation.updating': 'Updating...',
                'operation.deleting': 'Deleting...',
                'operation.saving': 'Saving...',
                'operation.loading': 'Loading...',
                'operation.processing': 'Processing...',
            },
        };
    }

    /**
     * 翻译字符串
     */
    t(key, params = {}) {
        let message = this.messages[this.currentLang]?.[key] ?? this.messages['zh-CN'][key] ?? key;
        
        // 参数替换
        Object.entries(params).forEach(([param, value]) => {
            message = message.replace(new RegExp(`\\$\\{${param}\\}`, 'g'), value);
            message = message.replace(new RegExp(`:${param}`, 'g'), value);
        });
        
        return message;
    }

    /**
     * 复数形式
     */
    plural(count, key) {
        if (count === 1) {
            return this.t(`${key}.singular`);
        }
        return this.t(`${key}.plural`, { count });
    }

    /**
     * 设置语言
     */
    setLanguage(lang) {
        if (!this.messages[lang]) {
            console.warn(`Language ${lang} not supported`);
            return false;
        }
        
        this.currentLang = lang;
        localStorage.setItem('lang', lang);
        
        // 通知监听器
        this.notifyListeners({
            type: 'languageChanged',
            lang,
        });
        
        return true;
    }

    /**
     * 获取当前语言
     */
    getLanguage() {
        return this.currentLang;
    }

    /**
     * 获取支持的语言
     */
    getSupportedLanguages() {
        return Object.keys(this.messages).map(lang => ({
            code: lang,
            name: this._getLanguageName(lang),
        }));
    }

    /**
     * 获取语言名称
     */
    _getLanguageName(lang) {
        const names = {
            'zh-CN': '中文(简体)',
            'zh-TW': '中文(繁体)',
            'en-US': 'English',
            'ja-JP': '日本語',
            'ko-KR': '한국어',
        };
        return names[lang] || lang;
    }

    /**
     * 订阅变化
     */
    subscribe(callback) {
        this.listeners.push(callback);
        return () => {
            this.listeners = this.listeners.filter(cb => cb !== callback);
        };
    }

    /**
     * 通知监听器
     */
    notifyListeners(event) {
        this.listeners.forEach(callback => {
            try {
                callback(event);
            } catch (e) {
                console.error('I18n listener error:', e);
            }
        });
    }

    /**
     * 添加自定义消息
     */
    addMessages(lang, messages) {
        if (!this.messages[lang]) {
            this.messages[lang] = {};
        }
        Object.assign(this.messages[lang], messages);
    }
}

export { I18nManager };
