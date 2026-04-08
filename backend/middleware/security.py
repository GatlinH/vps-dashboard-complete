# backend/middleware/security.py - 新建文件

from flask import Flask
from flask_talisman import Talisman
from datetime import timedelta

class SecurityConfig:
    """安全配置管理"""
    
    @staticmethod
    def init_app(app: Flask):
        """初始化安全中间件"""
        
        # 1. 安全头配置
        Talisman(
            app,
            force_https=app.config.get('FORCE_HTTPS', True),
            strict_transport_security=True,
            strict_transport_security_max_age=31536000,  # 1 year
            strict_transport_security_include_subdomains=True,
            content_security_policy={
                'default-src': "'self'",
                'script-src': [
                    "'self'",
                    "https://cdn.jsdelivr.net",
                    "https://unpkg.com",
                ],
                'style-src': [
                    "'self'",
                    "'unsafe-inline'",
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
            },
            content_security_policy_nonce_in=['script-src', 'style-src'],
        )
        
        # 2. CORS 配置（更严格）
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
        
        # 3. 响应安全头
        @app.after_request
        def add_security_headers(response):
            # 防止点击劫持
            response.headers['X-Frame-Options'] = 'DENY'
            
            # 防止 MIME 嗅探
            response.headers['X-Content-Type-Options'] = 'nosniff'
            
            # 启用 XSS 保护
            response.headers['X-XSS-Protection'] = '1; mode=block'
            
            # Referrer 政策
            response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
            
            # 功能政策
            response.headers['Permissions-Policy'] = (
                'geolocation=(), '
                'microphone=(), '
                'camera=(), '
                'payment=()'
            )
            
            return response
        
        # 4. 会话配置
        app.config.update(
            SESSION_COOKIE_SECURE=True,
            SESSION_COOKIE_HTTPONLY=True,
            SESSION_COOKIE_SAMESITE='Lax',
            PERMANENT_SESSION_LIFETIME=timedelta(hours=8),
        )
