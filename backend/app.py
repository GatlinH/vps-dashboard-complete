import logging
import time
from datetime import datetime, timezone
from flask import Flask, g, request
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
from flask_migrate import Migrate
from utils.logging_config import setup_logging
from config import get_config
from services.scheduler import create_scheduler

logger = logging.getLogger(__name__)


def _register_request_logger(app: Flask):
    """注册基础请求日志中间件（method/path/status/latency）。
    不记录请求体，避免泄露敏感信息。"""

    @app.before_request
    def _before():
        g._req_start = time.monotonic()

    @app.after_request
    def _after(response):
        start = getattr(g, "_req_start", None)
        if start is not None:
            latency_ms = round((time.monotonic() - start) * 1000, 1)
        else:
            latency_ms = -1
        # 跳过健康检查路径，减少日志噪声
        if request.path != "/health":
            logger.info(
                "%s %s %s %.1fms",
                request.method,
                request.path,
                response.status_code,
                latency_ms,
            )
        return response


def create_app(**config_overrides):
    """应用工厂"""
    app = Flask(__name__)
    setup_logging(app)  # 最先初始化日志
    app.config.from_object(get_config())
    app.config.update(config_overrides)

    # Swagger 初始化
    Flasgger(app)

    # ===== 扩展初始化 =====
    db.init_app(app)
    jwt.init_app(app)
    init_redis(app)
    migrate_ext = Migrate(app, db)  # noqa: F841

    # ===== JWT 令牌黑名单检查 =====
    @jwt.token_in_blocklist_loader
    def check_if_token_revoked(jwt_header, jwt_payload):
        from utils.token_blocklist import is_token_revoked
        try:
            return is_token_revoked(jwt_payload.get("jti", ""))
        except Exception:
            # Redis 不可用时放行，避免阻断正常请求
            return False

    # ===== 安全中间件 =====
    SecurityConfig.init_app(app)
    limiter = RateLimitConfig.init_app(app)
    app.limiter = limiter

    # ===== 请求日志 =====
    _register_request_logger(app)

    # ===== 错误处理与审计 =====
    ErrorHandler(app)
    AuditMiddleware(app)

    # ===== 蓝图注册 =====
    blueprints = [
        (auth_bp,     '/api/v1/auth'),
        (servers_bp,  '/api/v1/servers'),
        (probe_bp,    '/api/v1/probe'),
        (telegram_bp, '/api/v1/telegram'),
        (geo_bp,      '/api/v1/geo'),
        (traffic_bp,  '/api/v1/traffic'),
        (audit_bp,    '/api/v1/audit'),
        (aff_bp,      '/api/v1/aff'),
        (exchange_bp, '/api/v1/exchange'),
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
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'version': '1.0.0',
        }, 200

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)
