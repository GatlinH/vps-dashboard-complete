# backend/middleware/security.py - 修改

"""
安全配置管理 - 完善版本
添加更多安全头和优化 CSP 策略
"""
from flask import Flask, request
from flask_talisman import Talisman
from datetime import timedelta

class SecurityConfig:
    """安全配置管理"""
    
    @staticmethod
    def init_app(app: Flask):
        """初始化安全中间件"""
        
        # 1. 安全头配置（完善版本）
        Talisman(
            app,
            force_https=app.config.get('FORCE_HTTPS', True),
            strict_transport_security=True,
            strict_transport_security_max_age=31536000,  # 1 year
            strict_transport_security_include_subdomains=True,
            strict_transport_security_preload=True,  # ��� 新增
            content_security_policy={
                'default-src': "'self'",
                'script-src': [
                    "'self'",
                    "https://cdn.jsdelivr.net",
                    "https://unpkg.com",
                ],
                'style-src': [
                    "'self'",
                    "'unsafe-inline'",  # 前端需要内联样式
                    "https://fonts.googleapis.com",
                ],
                'img-src': [
                    "'self'",
                    "data:",
                    "https:",
                ],
                'font-src': [
                    "'self'",
                    "https://fonts.gstatic.com",
                ],
                'connect-src': [
                    "'self'",
                    "https://api.telegram.org",
                    "https://ip-api.com",
                ],
                'frame-ancestors': "'none'",
                'base-uri': "'self'",  # ✅ 新增
                'form-action': "'self'",  # ✅ 新增
            },
            content_security_policy_nonce_in=['script-src', 'style-src'],
        )
        
        # 2. CORS 配置（保持现有）
        from flask_cors import CORS
        CORS(
            app,
            origins=app.config.get('CORS_ORIGINS', []),
            methods=['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
            allow_headers=['Content-Type', 'Authorization'],
            expose_headers=['X-Total-Count', 'X-Page-Number'],
            supports_credentials=True,
            max_age=3600,
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
            response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
            
            # 功能政策
            response.headers['Permissions-Policy'] = (
                'geolocation=(), '
                'microphone=(), '
                'camera=(), '
                'payment=(), '
                'usb=(), '
                'magnetometer=()'  # ✅ 新增
            )
            
            # ✅ 新增安全头
            response.headers['X-Permitted-Cross-Domain-Policies'] = 'none'
            response.headers['X-DNS-Prefetch-Control'] = 'off'
            response.headers['X-Content-Type-Options'] = 'nosniff'
            
            # 只对写操作或含 Authorization 的请求禁缓存，保留公开只读接口的浏览器缓存
            if request.method in ('POST', 'PUT', 'DELETE', 'PATCH') or 'Authorization' in request.headers:
                response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
                response.headers['Pragma'] = 'no-cache'
            
            return response
        
        # 4. 会话配置
        app.config.update(
            SESSION_COOKIE_SECURE=True,
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE='Lax',
            SESSION_COOKIE_NAME='__Host-session',  # ✅ 前缀提升安全
            PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        )
