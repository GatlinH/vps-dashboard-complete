# backend/app.py

from datetime import datetime
from flask import Flask
from flask_cors import CORS
from flasgger import Swagger as Flasgger
from extensions import db, jwt, init_redis
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
from config import Config
from services.scheduler import create_scheduler


def create_app(config_class=Config, **config_overrides):
    """应用工厂"""
    app = Flask(__name__)
    app.config.from_object(config_class)
    if config_overrides:
        app.config.update(config_overrides)
    swagger = Flasgger(
        app,
        config={
            "headers": [],
            "specs": [
                {
                    "endpoint": "apispec",
                    "route": "/apispec.json",
                    "rule_filter": lambda rule: True,
                    "model_filter": lambda tag: True,
                }
            ],
            "static_url_path": "/flasgger_static",
            "swagger_ui": True,
            "specs_route": "/api/docs",
        },
        template={
            "swagger": "2.0",
            "info": {
                "title": "VPS Dashboard API",
                "version": "1.0.0",
                "description": "VPS 监控与管理平台 API 文档",
            },
            "basePath": "/",
            "schemes": ["http", "https"],
        },
    )

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
    ]

    for bp, prefix in blueprints:
        app.register_blueprint(bp, url_prefix=prefix)

    # ===== 数据库初始化 & 调度器启动 =====
    with app.app_context():
        db.create_all()
        if not app.config.get('TESTING', False):
            app.scheduler = create_scheduler(app)

    # ===== 健康检查 =====
    @app.route('/health')
    def health():
        """健康检查端点"""
        scheduler = getattr(app, 'scheduler', None)
        return {
            'status': 'ok',
            'timestamp': datetime.utcnow().isoformat(),
            'version': '1.0.0',
            'scheduler_running': scheduler.running if scheduler else False,
        }, 200

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)
