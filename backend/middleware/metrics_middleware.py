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

import ipaddress
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
    vps_agent_push = Counter(
        "vps_agent_push_total",
        "Agent push requests received",
        ["status"],  # "accepted" | "error"
    )
    vps_agent_poll = Counter(
        "vps_agent_poll_total",
        "Agent poll requests received",
        ["status"],  # "ok" | "error"
    )
    vps_agent_ack = Counter(
        "vps_agent_ack_total",
        "Agent command acknowledgements received",
        ["status"],  # "ok" | "error"
    )
    vps_scheduler_job = Counter(
        "vps_scheduler_job_total",
        "Scheduler job execution results",
        ["job_id", "status"],  # status: "ok" | "error" | "missed"
    )
    # P3-8: alert cooldown check results
    vps_alert_cooldown_check = Counter(
        "vps_alert_cooldown_check_total",
        "Alert cooldown check results",
        ["result", "backend"],  # result: allow|suppress|error_fail_open|error_fail_closed
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
    vps_agent_push = vps_agent_poll = vps_agent_ack = _NoOp()
    vps_scheduler_job = _NoOp()
    vps_alert_cooldown_check = _NoOp()


# ── 路径规范化（避免高基数 label）────────────────────────────────────────────

_IGNORE_PATHS = {"/health", "/metrics", "/favicon.ico"}

# ── /metrics 端点 IP 白名单（防止公网暴露）───────────────────────────────────

_METRICS_ALLOWED_NETWORKS = [
    ipaddress.ip_network("127.0.0.0/8"),    # loopback
    ipaddress.ip_network("10.0.0.0/8"),     # Docker 内网 / 私有网络
    ipaddress.ip_network("172.16.0.0/12"),  # Docker 默认桥接网络
    ipaddress.ip_network("192.168.0.0/16"), # 私有网络
    ipaddress.ip_network("::1/128"),        # IPv6 loopback
]


def _is_metrics_allowed(ip: str) -> bool:
    """
    判断来源 IP 是否在 /metrics 访问白名单内（内网/localhost）。
    测试环境（TESTING=True）或白名单可通过 METRICS_ALLOWED_CIDR 环境变量扩展。
    """
    if not ip:
        return False
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for net in _METRICS_ALLOWED_NETWORKS:
        try:
            if addr in net:
                return True
        except TypeError:
            pass
    return False

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
        ⚠️  仅允许内网/localhost 访问，防止指标数据泄露。
        在 nginx.conf 中同步设置 IP 白名单（location = /metrics）。
        """
        client_ip = request.remote_addr or ""
        if not _is_metrics_allowed(client_ip):
            logger.warning("⛔ /metrics 访问被拒绝: remote_addr=%s", client_ip)
            return "Forbidden", 403
        if _generate_latest is None:
            return "prometheus_client not installed", 503
        return _generate_latest(), 200, {"Content-Type": _CONTENT_TYPE}

    logger.info("✓ Prometheus metrics 中间件已初始化")


# ── 对外暴露常用业务指标，方便其他模块 import ─────────────────────────────────

def record_auth_login(status: str) -> None:
    """记录登录结果（success/failure/locked）。"""
    vps_auth_logins.labels(status=status).inc()


def record_token_revocation(token_type: str) -> None:
    """记录 token 吊销事件（access/refresh）。"""
    vps_auth_token_revocations.labels(token_type=token_type).inc()


def record_alert_fired(alert_type: str, channel: str) -> None:
    """记录告警触发（按类型和渠道）。"""
    vps_alerts_fired.labels(alert_type=alert_type, channel=channel).inc()


def record_traffic_limit_exceeded() -> None:
    """记录流量超限事件。"""
    vps_traffic_limit_exceeded.inc()


def record_probe_latency(latency_ms: float) -> None:
    """记录探针延迟（毫秒）。"""
    vps_probe_latency_ms.observe(latency_ms)


def record_email_sent(template: str, status: str) -> None:
    """记录邮件发送结果。"""
    vps_email_sent.labels(template=template, status=status).inc()


def record_agent_push(status: str) -> None:
    """记录 agent push 事件（accepted/error）。"""
    vps_agent_push.labels(status=status).inc()


def record_agent_poll(status: str) -> None:
    """记录 agent poll 事件（ok/error）。"""
    vps_agent_poll.labels(status=status).inc()


def record_agent_ack(status: str) -> None:
    """记录 agent 命令确认事件（ok/error）。"""
    vps_agent_ack.labels(status=status).inc()


def record_scheduler_job(job_id: str, status: str) -> None:
    """记录调度器任务执行结果（ok/error/missed）。"""
    vps_scheduler_job.labels(job_id=job_id, status=status).inc()


def record_cooldown_check(result: str, backend: str) -> None:
    """记录告警冷却判定结果（allow/suppress/error_fail_open/error_fail_closed）。"""
    vps_alert_cooldown_check.labels(result=result, backend=backend).inc()


def set_server_counts(total: int, online: int, offline: int) -> None:
    """设置服务器总量/在线/离线 Gauge。"""
    vps_servers_total.set(total)
    vps_servers_online.set(online)
    vps_servers_offline.set(offline)

__all__ = [
    "init_metrics",
    "_is_metrics_allowed",
    "vps_servers_total",
    "vps_servers_online",
    "vps_servers_offline",
    "vps_probe_latency_ms",
    "vps_auth_logins",
    "vps_auth_token_revocations",
    "vps_alerts_fired",
    "vps_traffic_limit_exceeded",
    "vps_email_sent",
    "vps_agent_push",
    "vps_agent_poll",
    "vps_agent_ack",
    "record_auth_login",
    "record_token_revocation",
    "record_alert_fired",
    "record_traffic_limit_exceeded",
    "record_probe_latency",
    "record_email_sent",
    "record_agent_push",
    "record_agent_poll",
    "record_agent_ack",
    "record_scheduler_job",
    "record_cooldown_check",
    "set_server_counts",
]
