import logging
import time
from datetime import datetime, timezone
from flask import Flask, g, request
from flask_cors import CORS
from flasgger import Swagger as Flasgger
from werkzeug.middleware.proxy_fix import ProxyFix
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
from api.agent import agent_bp
from flask_migrate import Migrate
from services.observability import init_observability
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
        response.headers["X-API-Schema-Version"] = app.config.get("API_SCHEMA_VERSION", "unknown")
        client_schema = request.headers.get("X-Client-Schema-Version")
        if client_schema and client_schema != app.config.get("API_SCHEMA_VERSION"):
            logger.warning(
                "API schema mismatch client=%s server=%s path=%s",
                client_schema,
                app.config.get("API_SCHEMA_VERSION"),
                request.path,
            )
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
    init_observability(app)  # 最先初始化日志/Sentry/Metrics
    app.config.from_object(get_config())
    app.config.update(config_overrides)

    if app.config.get("TRUST_PROXY", False):
        app.wsgi_app = ProxyFix(
            app.wsgi_app,
            x_for=app.config.get("PROXY_FIX_X_FOR", 1),
            x_proto=app.config.get("PROXY_FIX_X_PROTO", 1),
            x_host=app.config.get("PROXY_FIX_X_HOST", 1),
            x_port=app.config.get("PROXY_FIX_X_PORT", 1),
            x_prefix=app.config.get("PROXY_FIX_X_PREFIX", 1),
        )

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
        fail_open = app.config.get("JWT_BLOCKLIST_FAIL_OPEN", True)
        try:
            return is_token_revoked(jwt_payload.get("jti", ""))
        except Exception as exc:
            if fail_open:
                logger.warning("JWT blocklist check failed, fail-open enabled: %s", exc)
                # Redis 不可用时放行，避免阻断正常请求
                return False
            logger.error("JWT blocklist check failed, fail-open disabled: %s", exc)
            # fail-close：Redis 异常时将 token 视为已失效，优先保证安全
            return True

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
        (agent_bp, '/api/v1/agent'),
    ]
    for bp, prefix in blueprints:
        app.register_blueprint(bp, url_prefix=prefix)

    # ===== 数据库初始化 =====
    import os
    with app.app_context():
        # 生产环境通过 `flask db upgrade` 管理 schema，避免与 Flask-Migrate 冲突
        # 非生产/测试环境保留 create_all 以便快速启动
        if os.getenv("FLASK_ENV") != "production":
            db.create_all()

    # ===== 后台任务调度 =====
    create_scheduler(app)

    # ===== 健康检查 =====
    @app.route('/health')
    def health():
        from sqlalchemy import text
        import extensions as _ext
        checks = {}
        overall = 'ok'

        # 检查数据库连通性
        try:
            db.session.execute(text('SELECT 1'))
            checks['db'] = 'ok'
        except Exception as exc:
            logger.warning('Health check: DB unavailable: %s', exc, exc_info=True)
            checks['db'] = 'error'
            overall = 'degraded'

        # 检查 Redis 连通性
        rc = _ext.redis_client
        if rc is None:
            checks['redis'] = 'error'
            overall = 'degraded'
        else:
            try:
                rc.ping()
                checks['redis'] = 'ok'
            except Exception as exc:
                logger.warning('Health check: Redis unavailable: %s', exc, exc_info=True)
                checks['redis'] = 'error'
                overall = 'degraded'

        status_code = 200 if overall == 'ok' else 503
        return {
            'status': overall,
            'checks': checks,
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'version': '1.0.0',
        }, status_code

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(host="0.0.0.0", port=5000, debug=False)
