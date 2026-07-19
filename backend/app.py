import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from flask import Flask, abort, g, request, send_from_directory
from flask_cors import CORS
from flasgger import Swagger as Flasgger
from werkzeug.middleware.proxy_fix import ProxyFix
from extensions import db, jwt, redis_client, init_redis
from middleware.security import SecurityConfig
from middleware.rate_limit import RateLimitConfig
from middleware.error_handler import ErrorHandler
from middleware.audit import AuditMiddleware
from api.servers import servers_bp
from api.server_groups import server_groups_bp
from api.auth import auth_bp
from api.auth_account import account_bp
from api.users import users_bp
from api.probe import probe_bp
from api.telegram import telegram_bp
from api.ops import ops_bp
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


def _register_frontend_routes(app: Flask):
    """Serve the bundled Vite app without reserving API or health routes."""
    frontend_dist = Path(os.environ.get("FRONTEND_DIST_DIR", Path(app.root_path).parent / "frontend-dist"))

    def _send_asset(path: str):
        asset = frontend_dist / path
        if not asset.is_file():
            abort(404)
        response = send_from_directory(frontend_dist, path)
        if path in {"sw.js", "manifest.webmanifest"}:
            response.headers["Cache-Control"] = "no-cache"
        elif "/assets/" in f"/{path}" or path.endswith((".js", ".css", ".woff", ".woff2")):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    @app.get("/admin.html")
    def frontend_admin():
        return _send_asset("admin.html")

    @app.get("/assets/<path:path>")
    @app.get("/cesium/<path:path>")
    @app.get("/globe/<path:path>")
    def frontend_assets(path):
        return _send_asset(request.path.lstrip("/"))

    @app.get("/sw.js")
    @app.get("/manifest.webmanifest")
    @app.get("/favicon.ico")
    @app.get("/icon-<path:path>")
    def frontend_root_assets(path=None):
        return _send_asset(request.path.lstrip("/"))

    @app.get("/")
    @app.get("/<path:path>")
    def frontend_spa(path=""):
        if path.startswith(("api/", "health", "metrics")):
            abort(404)
        return _send_asset("index.html")


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

        try:
            suspicious_path = any(x in request.path.lower() for x in ("/.env", "/.git", "wp-admin", "phpmyadmin", "xmlrpc"))
            sensitive_failure = response.status_code in (401, 403, 429) and (
                request.path.startswith("/api/v1/auth")
                or request.path.startswith("/api/v1/agent")
                or request.path.startswith("/api/v1/servers")
                or request.path.startswith("/api/v1/ops")
                or suspicious_path
            )
            ip_for_audit = request.headers.get("X-Forwarded-For", request.remote_addr or "")[:120]
            ua_for_audit = (request.headers.get("User-Agent") or "")[:180]
            noisy_internal_agent = (
                request.path == "/api/v1/agent/push"
                and response.status_code == 401
                and ip_for_audit.startswith("172.18.")
                and "Python-urllib" in ua_for_audit
            )
            if request.path != "/health" and not noisy_internal_agent and (suspicious_path or sensitive_failure):
                from models.models import record_ops_event
                from extensions import db
                level = "error" if response.status_code >= 500 else "warn"
                record_ops_event(
                    "security_http_anomaly",
                    "异常 HTTP 访问",
                    message=f"{request.method} {request.path} -> {response.status_code}",
                    level=level,
                    payload={
                        "method": request.method,
                        "path": request.path[:240],
                        "status": response.status_code,
                        "ip": ip_for_audit,
                        "user_agent": ua_for_audit,
                    },
                )
                db.session.commit()
        except Exception:
            try:
                from extensions import db
                db.session.rollback()
            except Exception:
                pass
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
        from utils.token_blocklist import is_token_revoked, is_user_force_revoked
        fail_open = app.config.get("JWT_BLOCKLIST_FAIL_OPEN", True)
        try:
            jti = jwt_payload.get("jti", "")
            user_id = jwt_payload.get("sub")
            token_type = jwt_payload.get("type", "access")
            if is_token_revoked(jti, token_type=token_type, user_id=user_id):
                return True
            # 检查用户级强制下线（revoke_all_user_tokens 设置的标记）
            token_iat = jwt_payload.get("iat", 0)
            if user_id is not None:
                return is_user_force_revoked(user_id, token_iat)
            # user_id 缺失（异常 token）：拒绝并记录
            logger.warning(
                "JWT blocklist check: token missing sub claim, rejecting. jti=%s", jti
            )
            return True
        except Exception as exc:
            if fail_open or app.config.get("TESTING"):
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
        (account_bp,  '/api/v1/auth'),
        (users_bp,    '/api/v1/auth'),
        (servers_bp,  '/api/v1/servers'),
        (server_groups_bp, '/api/v1/server-groups'),
        (probe_bp,    '/api/v1/probe'),
        (telegram_bp, '/api/v1/telegram'),
        (ops_bp,      '/api/v1/ops'),
        (geo_bp,      '/api/v1/geo'),
        (traffic_bp,  '/api/v1/traffic'),
        (audit_bp,    '/api/v1/audit'),
        (aff_bp,      '/api/v1/aff'),
        (exchange_bp, '/api/v1/exchange'),
        (agent_bp, '/api/v1/agent'),
    ]
    for bp, prefix in blueprints:
        app.register_blueprint(bp, url_prefix=prefix)

    _register_frontend_routes(app)

    # ===== 数据库初始化 =====
    import os
    with app.app_context():
        # 生产环境通过 `flask db upgrade` 管理 schema，避免与 Flask-Migrate 冲突
        # 非生产/测试环境保留 create_all 以便快速启动
        if os.getenv("FLASK_ENV") != "production":
            db.create_all()
        from sqlalchemy.exc import OperationalError
        from services.server_groups import backfill_server_groups
        try:
            backfill_server_groups()
        except OperationalError:
            # Production must apply the checked-in migration before reconciliation.
            if os.getenv("FLASK_ENV") != "production":
                raise
            logger.warning("server_groups schema is not migrated; skipping group backfill")
            db.session.rollback()

    # ===== 后台任务调度 =====
    # 测试环境默认不启动后台 scheduler，避免 APScheduler 与 pytest 的
    # sqlite:///:memory: fixture 并发写库/重建 schema 互相干扰。
    if os.getenv("DISABLE_SCHEDULER", "0").lower() not in ("1", "true", "yes"):
        if not app.config.get("TESTING") or app.config.get("ENABLE_SCHEDULER_IN_TESTS"):
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
