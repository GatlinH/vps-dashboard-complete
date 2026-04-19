"""
backend/services/observability/sentry.py
Sentry 错误聚合 & 性能追踪初始化封装

功能：
  - 自动集成 Flask、SQLAlchemy、Redis
  - 注入 request_id / user 上下文到 Sentry scope
  - 按环境动态配置采样率（生产 10%，开发 0%）
  - 过滤健康检查、404、401 等噪音事件
  - 提供 capture_business_event() 手动上报业务异常

环境变量：
  SENTRY_DSN          Sentry 数据源（为空时完全禁用）
  FLASK_ENV           production | development | testing
  SENTRY_TRACES_RATE  性能追踪采样率（默认 production=0.1，dev=0.0）
  SENTRY_PROFILES_RATE  性能剖析采样率（默认 0.1）
"""

import logging
import os
from typing import Optional

logger = logging.getLogger(__name__)

# ── 采样率配置 ────────────────────────────────────────────────────────────────

_TRACES_RATE_BY_ENV = {
    "production":  float(os.getenv("SENTRY_TRACES_RATE",   "0.1")),
    "staging":     float(os.getenv("SENTRY_TRACES_RATE",   "0.2")),
    "development": 0.0,
    "testing":     0.0,
}

# ── 噪音过滤：不上报到 Sentry 的路径前缀 & 状态码 ────────────────────────────

_IGNORE_PATHS = (
    "/health", "/metrics", "/favicon.ico",
    "/api/v1/probe/push",           # 探针高频 push，不上报
    "/api/geo/tile/",               # 地图瓦片
)
_IGNORE_STATUS_CODES = (400, 401, 403, 404, 405, 429)


def _before_send(event: dict, hint: dict) -> Optional[dict]:
    """
    Sentry before_send 钩子：过滤噪音事件。
    返回 None 表示丢弃，返回 event 表示上报。
    """
    # 过滤健康检查 & 地图瓦片路径
    req = event.get("request", {})
    path = req.get("url", "")
    if any(path.endswith(p) or (p.endswith("/") and p in path)
           for p in _IGNORE_PATHS):
        return None

    # 过滤常见非错误状态码
    resp = event.get("response", {})
    status = resp.get("status_code")
    if status in _IGNORE_STATUS_CODES:
        return None

    # 过滤 404 类型异常
    exc_values = event.get("exception", {}).get("values", [])
    for exc in exc_values:
        exc_type = exc.get("type", "")
        if exc_type in ("NotFound", "MethodNotAllowed", "Unauthorized"):
            return None

    return event


def _traces_sampler(sampling_context: dict) -> float:
    """
    动态追踪采样：对健康检查路径强制采样率 0。
    """
    wsgi_env = sampling_context.get("wsgi_environ", {})
    path = wsgi_env.get("PATH_INFO", "")
    if any(path.startswith(p) for p in _IGNORE_PATHS):
        return 0.0

    flask_env = os.getenv("FLASK_ENV", "development")
    return _TRACES_RATE_BY_ENV.get(flask_env, 0.0)


# ── 初始化入口 ────────────────────────────────────────────────────────────────

def init_sentry(app=None) -> bool:
    """
    初始化 Sentry SDK。

    Args:
        app: Flask 应用实例（可选，传入则注册 request 上下文钩子）

    Returns:
        True 表示 Sentry 已成功初始化，False 表示 DSN 未配置或初始化失败。
    """
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        logger.info("ℹ️  SENTRY_DSN 未配置，Sentry 已禁用")
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.flask       import FlaskIntegration
        from sentry_sdk.integrations.sqlalchemy  import SqlalchemyIntegration
        from sentry_sdk.integrations.redis       import RedisIntegration
        from sentry_sdk.integrations.logging     import LoggingIntegration

        flask_env = os.getenv("FLASK_ENV", "development")

        # Logging 集成：WARNING → Sentry breadcrumb，ERROR → Sentry event
        logging_integration = LoggingIntegration(
            level       = logging.WARNING,  # breadcrumb 级别
            event_level = logging.ERROR,    # 自动上报为 event 的级别
        )

        sentry_sdk.init(
            dsn                  = dsn,
            environment          = flask_env,
            release              = os.getenv("APP_VERSION", "unknown"),
            integrations         = [
                FlaskIntegration(transaction_style="url"),
                SqlalchemyIntegration(),
                RedisIntegration(),
                logging_integration,
            ],
            traces_sampler       = _traces_sampler,
            profiles_sample_rate = float(os.getenv("SENTRY_PROFILES_RATE", "0.1")),
            before_send          = _before_send,
            # 不发送本地变量（生产安全）
            with_locals          = flask_env != "production",
            # 限制面包屑数量，避免内存膨胀
            max_breadcrumbs      = 50,
            # 请求体大小上限（bytes）
            max_value_length     = 2048,
        )

        logger.info(f"✅ Sentry 已初始化: env={flask_env}")

        if app:
            _register_flask_hooks(app)

        return True

    except ImportError:
        logger.warning("⚠️  sentry-sdk 未安装，Sentry 已禁用。运行: pip install sentry-sdk[flask]")
        return False
    except Exception as e:
        logger.error(f"❌ Sentry 初始化失败: {e}")
        return False


# ── Flask 钩子：注入 request_id & user 上下文 ─────────────────────────────────

def _register_flask_hooks(app) -> None:
    """将 request_id 和当前用户注入到每个 Sentry 事件的 scope"""
    try:
        import sentry_sdk
        from flask import g, has_request_context
        from flask_jwt_extended import get_jwt_identity, verify_jwt_in_request

        @app.before_request
        def _sentry_set_scope():
            if not has_request_context():
                return
            with sentry_sdk.configure_scope() as scope:
                # request_id（由 logging_config.py 的钩子生成后存于 g）
                rid = getattr(g, "request_id", "")
                if rid:
                    scope.set_tag("request_id", rid)

                # 当前用户（JWT 解析，失败则忽略）
                try:
                    verify_jwt_in_request(optional=True)
                    uid = get_jwt_identity()
                    if uid:
                        scope.set_user({"id": uid})
                except Exception:
                    pass

    except ImportError:
        pass


# ── 手动上报业务异常 ──────────────────────────────────────────────────────────

def capture_business_event(
    message: str,
    level:   str = "error",
    extra:   Optional[dict] = None,
    tags:    Optional[dict] = None,
) -> Optional[str]:
    """
    手动上报业务事件到 Sentry（不依赖异常抛出）。

    Args:
        message: 事件描述
        level:   "debug" | "info" | "warning" | "error" | "fatal"
        extra:   附加键值对（显示在 Sentry 事件的 Extra 标签页）
        tags:    Sentry tags（可用于过滤/搜索）

    Returns:
        Sentry event_id（字符串），未初始化时返回 None

    Example:
        capture_business_event(
            "流量超限告警发送失败",
            level="warning",
            extra={"server_id": s.id, "used_pct": pct},
            tags={"alert_type": "TRAFFIC"},
        )
    """
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            if extra:
                for k, v in extra.items():
                    scope.set_extra(k, v)
            if tags:
                for k, v in tags.items():
                    scope.set_tag(k, v)
            event_id = sentry_sdk.capture_message(message, level=level)
            return event_id
    except ImportError:
        logger.debug(f"[Sentry disabled] {level.upper()}: {message}")
        return None
    except Exception as e:
        logger.warning(f"⚠️  Sentry capture 失败: {e}")
        return None


# ── 手动上报异常 ──────────────────────────────────────────────────────────────

def capture_exception(exc: Exception, extra: Optional[dict] = None) -> Optional[str]:
    """
    手动上报 Exception 到 Sentry。
    在 except 块中调用时会自动附带当前 traceback。

    Example:
        try:
            ...
        except Exception as e:
            capture_exception(e, extra={"server_id": s.id})
            raise
    """
    try:
        import sentry_sdk
        with sentry_sdk.push_scope() as scope:
            if extra:
                for k, v in extra.items():
                    scope.set_extra(k, v)
            return sentry_sdk.capture_exception(exc)
    except ImportError:
        logger.debug(f"[Sentry disabled] Exception: {exc}")
        return None
    except Exception as e:
        logger.warning(f"⚠️  Sentry capture_exception 失败: {e}")
        return None
