# backend/app.py - 改进版本

"""
VPS 星图 · Flask 后端入口
完全重构版本，集成安全加固
"""
from flask import Flask
from flask_cors import CORS
from extensions import db, redis_client, jwt
from middleware.security import SecurityConfig
from middleware.rate_limit import RateLimitConfig
from middleware.error_handler import ErrorHandler
from middleware.audit import AuditMiddleware
from api.servers import servers_bp
from api.auth import auth_bp
from api.probe import probe_bp
from api.telegram import telegram_bp
from api.geo import geo_bp
from api.traffic import traffic_bp
from api.audit import audit_bp
from config import Config

def create_app(config_class=Config):
    """应用工厂"""
    app = Flask(__name__)
    app.config.from_object(config_class)

    # ===== 扩展初始化 =====
    db.init_app(app)
    jwt.init_app(app)
    
    # ===== 安全中间件 =====
    SecurityConfig.init_app(app)
    limiter = RateLimitConfig.init_app(app)
    app.limiter = limiter  # 暴露 limiter 实例
    
    # ===== 错误处理与审计 =====
    ErrorHandler(app)
    AuditMiddleware(app)

    # ===== 蓝图注册 =====
    blueprints = [
        (auth_bp, '/api/auth'),
        (servers_bp, '/api/servers'),
        (probe_bp, '/api/probe'),
        (telegram_bp, '/api/telegram'),
        (geo_bp, '/api/geo'),
        (traffic_bp, '/api/traffic'),
        (audit_bp, '/api/audit'),
    ]
    
    for bp, prefix in blueprints:
        app.register_blueprint(bp, url_prefix=prefix)

    # ===== 数据库初始化 =====
    with app.app_context():
        db.create_all()

    # ===== 健康检查 =====
    @app.route('/health')
    def health():
        """健康检查端点"""
        return {
            'status': 'ok',
            'timestamp': datetime.utcnow().isoformat(),
            'version': '1.0.0',
        }, 200

    # ===== 404 处理 =====
    @app.errorhandler(404)
    def not_found(error):
        return {
            'success': False,
            'error_code': 'NOT_FOUND',
            'message': '请求的资源不存在',
        }, 404

    return app


if __name__ == "__main__":
    from datetime import datetime
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)
