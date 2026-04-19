"""
backend/middleware/metrics_middleware.py
Prometheus 指标中间件（完善版）

暴露的指标：
  系统级：
    vps_requests_total{method, endpoint, status}        请求总数
    vps_request_duration_seconds{method, endpoint}      请求耗时直方图
    vps_request_errors_total{method, endpoint, status}  4xx/5xx 错误计数
    vps_slow_requests_total{endpoint}                   慢请求（>2s）计数

  业务级：
    vps_servers_total                   当前服务器总数
    vps_servers_online                  在线数
    vps_servers_offline                 离线数
    vps_probe_latency_ms                探针延迟直方图（毫秒）
    vps_auth_logins_total{status}       登录计数（success/failure）
    vps_auth_token_revocations_total    token 吊销计数
    vps_alerts_fired_total{type}        告警触发计数
    vps_traffic_limit_exceeded_total    流量超限事件计数

挂载路径：
  GET /metrics  → Prometheus text format（建议通过 nginx 限制内网访问）

警告：
  /metrics 端点不应对公网开放，在 nginx.conf 中添加 IP 白名单：
    location = /metrics {
        allow 127.0.0.1;
        allow 10.0.0.0/8;
        deny  all;
        proxy_pass http://api:5000;
    }
"""

import logging
import time
from flask import Flask, request

logger = logging.getLogger(__name__)

# ── 懒加载 prometheus_client（避免无依赖时启动报错）─────────────────────────

def _get_prometheus():
    try:
        from prometheus_client import (
            Counter, Histogram, Gauge,
            generate_latest, CONTENT_TYPE_LATEST,
        )
        return Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST
    except ImportError:
        return None, None, None, None, None


Counter, Histogram, Gauge, _generate_latest, _CONTENT_TYPE = _get_prometheus()

# ── 指标定义（仅在 prometheus_client 可用时初始化）──────────────────────────

if Counter:
    # ── 系统级 ────────────────────────────────────────────────────────────────
    _req_total = Counter(
        "vps_requests_total",
        "HTTP request count",
        ["method", "endpoint", "status"],
    )
    _req_duration = Histogram(
        "vps_request_duration_seconds",
        "HTTP request latency",
        ["method", "endpoint"],
        buckets=(0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0),
    )
    _req_errors = Counter(
        "vps_request_errors_total",
        "HTTP 4xx/5xx error count",
        ["method", "endpoint", "status"],
    )
    _slow_requests = Counter(
        "vps_slow_requests_total",
        "Requests taking longer than 2 seconds",
        ["endpoint"],
    )

    # ── 业务级 ────────────────────────────────────────────────────────────────
    vps_servers_total = Gauge(
        "vps_servers_total",
        "Total number of VPS servers",
    )
    vps_servers_online = Gauge(
        "vps_servers_online",
        "Number of online VPS servers",
    )
    vps_servers_offline = Gauge(
        "vps_servers_offline",
        "Number of offline VPS servers",
    )
    vps_probe_latency_ms = Histogram(
        "vps_probe_latency_ms",
        "TCP probe latency in milliseconds",
        buckets=(10, 50, 100, 200, 300, 500, 1000, 3000),
    )
    vps_auth_logins = Counter(
        "vps_auth_logins_total",
        "Login attempts",
        ["status"],  # "success" | "failure" | "locked"
    )
    vps_auth_token_revocations = Counter(
        "vps_auth_token_revocations_total",
        "JWT token revocations (logout / change-password)",
        ["token_type"],  # "access" | "refresh"
    )
    vps_alerts_fired = Counter(
        "vps_alerts_fired_total",
        "Alert notifications sent",
        ["alert_type", "channel"],  # channel: "telegram" | "email"
    )
    vps_traffic_limit_exceeded = Counter(
        "vps_traffic_limit_exceeded_total",
        "Traffic limit exceeded events",
    )
    vps_email_sent = Counter(
        "vps_email_sent_total",
        "Emails sent by email_service",
        ["template", "status"],  # template: "verify"|"reset"|"welcome"
    )

else:
    # prometheus_client 未安装时，使用 no-op 占位
    class _NoOp:
        def labels(self, **_): return self
        def inc(self, *a, **k): pass
        def observe(self, *a, **k): pass
        def set(self, *a, **k): pass

    _req_total = _req_duration = _req_errors = _slow_requests = _NoOp()
    vps_servers_total = vps_servers_online = vps_servers_offline = _NoOp()
    vps_probe_latency_ms = _NoOp()
    vps_auth_logins = vps_auth_token_revocations = _NoOp()
    vps_alerts_fired = vps_traffic_limit_exceeded = vps_email_sent = _NoOp()


# ── 路径规范化（避免高基数 label）────────────────────────────────────────────

_IGNORE_PATHS = {"/health", "/metrics", "/favicon.ico"}

def _normalize_endpoint(path: str) -> str:
    """
    将动态路径中的 ID 替换为占位符，防止 Prometheus 标签基数爆炸。
    /api/v1/servers/42/metrics → /api/v1/servers/:id/metrics
    """
    import re
    path = re.sub(r"/\d+", "/:id", path)
    return path


# ── 中间件注册 ────────────────────────────────────────────────────────────────

def init_metrics(app: Flask) -> None:
    """初始化 Prometheus 指标中间件，注册请求钩子并挂载 /metrics 端点"""

    @app.before_request
    def _metrics_before():
        request._metrics_start = time.time()

    @app.after_request
    def _metrics_after(response):
        path = request.path
        if path in _IGNORE_PATHS:
            return response

        start    = getattr(request, "_metrics_start", None)
        endpoint = _normalize_endpoint(path)
        method   = request.method
        status   = str(response.status_code)

        # 请求总数
        try:
            _req_total.labels(method=method, endpoint=endpoint, status=status).inc()
        except Exception:
            pass

        # 请求耗时
        if start is not None:
            duration = time.time() - start
            try:
                _req_duration.labels(method=method, endpoint=endpoint).observe(duration)
            except Exception:
                pass

            # 慢请求（>2s）
            if duration > 2.0:
                try:
                    _slow_requests.labels(endpoint=endpoint).inc()
                except Exception:
                    pass
                logger.warning(
                    f"🐢 慢请求: {method} {path} — {duration:.2f}s (status={status})",
                    extra={"duration_ms": round(duration * 1000)},
                )

        # 4xx / 5xx 错误
        sc = response.status_code
        if sc >= 400:
            try:
                _req_errors.labels(method=method, endpoint=endpoint, status=status).inc()
            except Exception:
                pass

        return response

    # /metrics 端点
    @app.route("/metrics")
    def metrics_endpoint():
        """
        Prometheus scrape endpoint。
        ⚠️  在 nginx.conf 中限制此路径仅内网可访问。
        """
        if _generate_latest is None:
            return "prometheus_client not installed", 503
        return _generate_latest(), 200, {"Content-Type": _CONTENT_TYPE}

    logger.info("✓ Prometheus metrics 中间件已初始化")


# ── 对外暴露常用业务指标，方便其他模块 import ─────────────────────────────────

__all__ = [
    "init_metrics",
    "vps_servers_total",
    "vps_servers_online",
    "vps_servers_offline",
    "vps_probe_latency_ms",
    "vps_auth_logins",
    "vps_auth_token_revocations",
    "vps_alerts_fired",
    "vps_traffic_limit_exceeded",
    "vps_email_sent",
]
