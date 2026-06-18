# backend/middleware/security.py - 修改

"""
安全配置管理 - 完善版本
添加更多安全头和优化 CSP 策略
"""
from datetime import timedelta

from flask import Flask, request
from flask_cors import CORS
from flask_talisman import Talisman


class SecurityConfig:
    """安全配置管理"""

    @staticmethod
    def init_app(app: Flask):
        """初始化安全中间件"""
        csp = dict(app.config.get('SECURITY_CSP', {}))
        connect_src = csp.get('connect-src', [])
        if isinstance(connect_src, list):
            # 将 CORS 白名单同步到 CSP connect-src，避免合法前端被 CSP 阻断
            for origin in app.config.get('CORS_ORIGINS', []):
                if origin not in connect_src:
                    connect_src.append(origin)
            csp['connect-src'] = connect_src

        # 1. 安全头配置（完善版本）
        Talisman(
            app,
            force_https=app.config.get('FORCE_HTTPS', False),
            strict_transport_security=app.config.get('HSTS_ENABLED', True),
            strict_transport_security_max_age=app.config.get('HSTS_MAX_AGE', 31536000),
            strict_transport_security_include_subdomains=app.config.get('HSTS_INCLUDE_SUBDOMAINS', True),
            strict_transport_security_preload=app.config.get('HSTS_PRELOAD', True),
            content_security_policy=csp,
            content_security_policy_nonce_in=app.config.get('SECURITY_CSP_NONCE_IN', ['script-src', 'style-src']),
        )

        # 2. CORS 配置（使用白名单）
        CORS(
            app,
            origins=app.config.get('CORS_ORIGINS', []),
            methods=app.config.get('CORS_METHODS', ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']),
            allow_headers=app.config.get('CORS_ALLOW_HEADERS', ['Content-Type', 'Authorization']),
            expose_headers=app.config.get('CORS_EXPOSE_HEADERS', ['X-Total-Count', 'X-Page-Number']),
            supports_credentials=app.config.get('CORS_SUPPORTS_CREDENTIALS', True),
            max_age=app.config.get('CORS_MAX_AGE', 3600),
        )

        # 3. 响应安全头（完善版本）
        @app.after_request
        def add_security_headers(response):
            # 防点击劫持
            response.headers['X-Frame-Options'] = 'DENY'

            # 防 MIME 嗅探
            response.headers['X-Content-Type-Options'] = 'nosniff'

            # XSS 保护
            response.headers['X-XSS-Protection'] = '1; mode=block'

            # Referrer 政策
            if 'Referrer-Policy' not in response.headers:
                response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'

            # 功能政策
            response.headers['Permissions-Policy'] = (
                'geolocation=(), '
                'microphone=(), '
                'camera=(), '
                'payment=(), '
                'usb=(), '
                'magnetometer=()'
            )

            # ✅ 新增安全头
            response.headers['X-Permitted-Cross-Domain-Policies'] = 'none'
            response.headers['X-DNS-Prefetch-Control'] = 'off'

            # 只对写操作或含 Authorization 的请求禁缓存，保留公开只读接口的浏览器缓存
            if request.method in ('POST', 'PUT', 'DELETE', 'PATCH') or 'Authorization' in request.headers:
                response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
                response.headers['Pragma'] = 'no-cache'

            return response

        # 4. 会话配置
        app.config.update(
            SESSION_COOKIE_SECURE=app.config.get('SESSION_COOKIE_SECURE', False),
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE='Lax',
            SESSION_COOKIE_NAME='__Host-session',
            PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        )
