from datetime import datetime
from flask import Flask
from flask_cors import CORS
from flasgger import Swagger as Flasgger
from extensions import db, jwt, redis_client, init_redis
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
from api.aff import aff_bp
from api.exchange import exchange_bp
from config import Config
from services.scheduler import create_scheduler


def create_app(config_class=Config, **config_overrides):
    """应用工厂"""
    app = Flask(__name__)
    app.config.from_object(config_class)
    app.config.update(config_overrides)

    # Swagger 初始化
    Flasgger(app)

    # ===== 扩展初始化 =====
    db.init_app(app)
    jwt.init_app(app)
    init_redis(app)

    # ===== 安全中间件 =====
    SecurityConfig.init_app(app)
    limiter = RateLimitConfig.init_app(app)
    app.limiter = limiter

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
        (aff_bp, '/api/aff'),
        (exchange_bp, '/api/exchange'),
    ]
    for bp, prefix in blueprints:
        app.register_blueprint(bp, url_prefix=prefix)

    # ===== 数据库初始化 =====
    with app.app_context():
        db.create_all()

    # ===== 后台任务调度 =====
    create_scheduler(app)

    # ===== 健康检查 =====
    @app.route('/health')
    def health():
        return {
            'status': 'ok',
            'timestamp': datetime.utcnow().isoformat(),
            'version': '1.0.0',
        }, 200

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)
