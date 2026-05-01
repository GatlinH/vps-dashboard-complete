"""
utils/logging_config.py — 结构化日志配置（扩展版）

功能：
  - 生产环境输出 JSON 格式，便于 ELK / Loki / Grafana 采集
  - 开发环境输出可读文本格式
  - 每条日志自动注入 request_id（X-Request-ID 或随机生成）
  - 支持运行时动态调整 log level（通过 /admin/log-level 接口）
  - 预留外部 Sink：Loki HTTP Handler（按需开启）
  - Sentry 错误级别自动上报（由 sentry.py 注册 handler）
"""

import logging
import logging.handlers
import json
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

# Flask / 线程局部变量（在 request context 外也能安全调用）
try:
    from flask import g, has_request_context
except ImportError:
    has_request_context = lambda: False  # noqa: E731
    g = None


# ── Request ID 注入 ────────────────────────────────────────────────────────────

def get_request_id() -> str:
    """获取当前请求 ID（request context 内取 g.request_id，否则返回空串）"""
    if has_request_context() and g:
        return getattr(g, "request_id", "")
    return ""


# ── JSON 格式化器 ──────────────────────────────────────────────────────────────

class JsonFormatter(logging.Formatter):
    """
    生产环境 JSON 结构化日志。
    输出字段：time / level / logger / message / module / line / request_id / exception
    可被 Loki、ELK、Grafana 直接解析。
    """
    # 额外字段白名单（通过 logger.info("msg", extra={...}) 传入）
    EXTRA_FIELDS = ("server_id", "user_id", "username", "action", "duration_ms")

    def format(self, record: logging.LogRecord) -> str:
        log_entry: dict = {
            "time":       datetime.now(timezone.utc).isoformat(),
            "level":      record.levelname,
            "logger":     record.name,
            "message":    record.getMessage(),
            "module":     record.module,
            "func":       record.funcName,
            "line":       record.lineno,
            "request_id": get_request_id(),
        }

        # 注入额外业务字段
        for field in self.EXTRA_FIELDS:
            val = getattr(record, field, None)
            if val is not None:
                log_entry[field] = val

        # 异常堆栈
        if record.exc_info:
            log_entry["exception"] = self.formatException(record.exc_info)

        return json.dumps(log_entry, ensure_ascii=False, default=str)


# ── 可读文本格式化器（开发） ───────────────────────────────────────────────────

_DEV_FMT = "[%(asctime)s] %(levelname)-8s %(name)s:%(lineno)d — %(message)s"


# ── 可选：Loki HTTP Handler ───────────────────────────────────────────────────

class LokiHttpHandler(logging.Handler):
    """
    将 WARNING+ 日志异步推送到 Loki Push API。
    按需开启：设置环境变量 LOKI_URL=http://loki:3100/loki/api/v1/push
    """
    def __init__(self, loki_url: str, labels: Optional[dict] = None):
        super().__init__(level=logging.WARNING)
        self.loki_url = loki_url
        self.labels   = labels or {"app": "vps-dashboard", "env": os.getenv("FLASK_ENV", "production")}
        self._json_fmt = JsonFormatter()

    def emit(self, record: logging.LogRecord) -> None:
        try:
            import threading, urllib.request as _req
            line      = self._json_fmt.format(record)
            ts_ns     = str(int(datetime.now(timezone.utc).timestamp() * 1e9))
            payload   = json.dumps({
                "streams": [{
                    "stream": self.labels,
                    "values": [[ts_ns, line]],
                }]
            }).encode()
            req = _req.Request(
                self.loki_url, data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            def _push():
                try:
                    _req.urlopen(req, timeout=3)
                except Exception:
                    pass
            threading.Thread(target=_push, daemon=True).start()
        except Exception:
            self.handleError(record)


# ── 主配置入口 ────────────────────────────────────────────────────────────────

def setup_logging(app=None) -> None:
    """
    根据环境选择日志格式并配置根 Logger。

    优先级：
      1. 环境变量 LOG_LEVEL（DEBUG / INFO / WARNING / ERROR）
      2. FLASK_ENV == production → JSON 格式
      3. 其余 → 可读文本格式

    额外 Sink（按需）：
      LOKI_URL 设置后自动追加 LokiHttpHandler
    """
    flask_env     = os.getenv("FLASK_ENV", "development")
    log_level_str = os.getenv("LOG_LEVEL", "INFO").upper()
    log_level     = getattr(logging, log_level_str, logging.INFO)

    # 控制台 Handler
    console_handler = logging.StreamHandler()
    if flask_env == "production":
        console_handler.setFormatter(JsonFormatter())
    else:
        console_handler.setFormatter(logging.Formatter(_DEV_FMT))
    console_handler.setLevel(log_level)

    # 配置根 Logger
    root = logging.getLogger()
    root.setLevel(log_level)
    root.handlers = [console_handler]

    # Loki Sink（可选）
    loki_url = os.getenv("LOKI_URL", "")
    if loki_url:
        loki_handler = LokiHttpHandler(loki_url)
        root.addHandler(loki_handler)
        logging.getLogger(__name__).info(f"✓ Loki sink 已启用: {loki_url}")

    # 抑制第三方库的冗余日志
    for noisy in ("apscheduler", "werkzeug", "sqlalchemy.engine",
                  "urllib3", "botocore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    if app:
        _register_request_id_hooks(app)
        _register_dynamic_log_level_endpoint(app)


# ── Request ID 注入（Flask 钩子） ─────────────────────────────────────────────

def _register_request_id_hooks(app) -> None:
    """在 before_request 生成/接收 request_id，after_request 写回响应头"""
    from flask import request, g

    @app.before_request
    def _inject_request_id():
        g.request_id = (
            request.headers.get("X-Request-ID")
            or request.headers.get("X-Correlation-ID")
            or str(uuid.uuid4())
        )

    @app.after_request
    def _return_request_id(response):
        rid = getattr(g, "request_id", "")
        if rid:
            response.headers["X-Request-ID"] = rid
        return response


# ── 动态 Log Level 接口 ───────────────────────────────────────────────────────

def _register_dynamic_log_level_endpoint(app) -> None:
    """
    注册内部管理接口，支持运行时调整 log level，无需重启服务。

    GET  /admin/log-level              → 当前 level
    POST /admin/log-level {"level": "DEBUG"}  → 动态修改

    ⚠️  仅 admin 角色可访问，建议在 nginx.conf 限制仅内网访问。
    """
    from flask import Blueprint, request as req, jsonify
    from middleware.rbac import admin_required

    log_bp = Blueprint("log_level", __name__)

    @log_bp.get("/admin/log-level")
    @admin_required
    def get_log_level():
        current = logging.getLevelName(logging.getLogger().level)
        return jsonify(level=current)

    @log_bp.post("/admin/log-level")
    @admin_required
    def set_log_level():
        data      = req.get_json(silent=True) or {}
        new_level = data.get("level", "").upper()
        if new_level not in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"):
            return jsonify(msg="无效的 log level"), 400
        logging.getLogger().setLevel(getattr(logging, new_level))
        logging.getLogger(__name__).info(f"✓ Log level 已动态修改为: {new_level}")
        return jsonify(msg=f"Log level 已设置为 {new_level}", level=new_level)

    app.register_blueprint(log_bp)
