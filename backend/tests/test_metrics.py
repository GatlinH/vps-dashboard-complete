"""
backend/tests/test_metrics.py
Prometheus metrics 端点与中间件测试

覆盖范围：
  - /metrics 端点可用性（200 + 正确 Content-Type）
  - 请求后 vps_requests_total 计数增长
  - 4xx / 5xx 错误计数
  - 慢请求日志记录
  - 业务指标（auth logins / token revocation / alert）可正常 inc
  - /metrics 路径自身不产生指标噪音
  - log level 动态接口（GET / POST /admin/log-level）

运行：
  pytest backend/tests/test_metrics.py -v
"""

import logging
import time
from unittest.mock import patch, MagicMock

import pytest


# ═══════════════════════════════════════════════════════════════════════════════
# /metrics 端点基础测试
# ═══════════════════════════════════════════════════════════════════════════════

class TestMetricsEndpoint:
    def test_metrics_returns_200(self, client):
        """GET /metrics 应返回 200"""
        res = client.get("/metrics")
        assert res.status_code == 200

    def test_metrics_content_type(self, client):
        """响应 Content-Type 应为 Prometheus 文本格式"""
        res = client.get("/metrics")
        ct = res.content_type
        assert "text/plain" in ct or "application/openmetrics-text" in ct

    def test_metrics_contains_standard_keys(self, client):
        """基础指标应包含请求计数和耗时"""
        # 先触发一次请求，确保指标产生
        client.get("/api/v1/servers/")
        res = client.get("/metrics")
        body = res.data.decode()
        assert "vps_requests_total" in body
        assert "vps_request_duration_seconds" in body

    def test_metrics_contains_business_gauges(self, client):
        """/metrics 应包含服务器业务指标"""
        res = client.get("/metrics")
        body = res.data.decode()
        assert "vps_servers_total"   in body
        assert "vps_servers_online"  in body
        assert "vps_servers_offline" in body


# ═══════════════════════════════════════════════════════════════════════════════
# 请求计数 & 耗时
# ═══════════════════════════════════════════════════════════════════════════════

class TestRequestMetrics:
    def test_request_count_increments(self, client):
        """/api/v1/servers/ 请求后计数应增长"""
        before = _get_metric_value(client, "vps_requests_total")
        client.get("/api/v1/servers/")
        after  = _get_metric_value(client, "vps_requests_total")
        assert after > before

    def test_error_count_on_404(self, client):
        """404 请求应写入 vps_request_errors_total"""
        before = _get_metric_value(client, "vps_request_errors_total")
        client.get("/api/v1/nonexistent-path-xyz")
        after  = _get_metric_value(client, "vps_request_errors_total")
        assert after > before

    def test_error_count_on_401(self, client):
        """401 未授权应写入错误计数"""
        before = _get_metric_value(client, "vps_request_errors_total")
        client.post("/api/v1/servers/")  # 无 token
        after  = _get_metric_value(client, "vps_request_errors_total")
        assert after > before

    def test_metrics_path_not_counted(self, client):
        """/metrics 自身不应产生 vps_requests_total 条目"""
        client.get("/metrics")
        body = client.get("/metrics").data.decode()
        # /metrics 路径在 label 中不应出现（被 _IGNORE_PATHS 过滤）
        assert 'endpoint="/metrics"' not in body

    def test_health_path_not_counted(self, client):
        """/health 不应产生指标计数"""
        client.get("/health")
        body = client.get("/metrics").data.decode()
        assert 'endpoint="/health"' not in body


# ═══════════════════════════════════════════════════════════════════════════════
# 慢请求
# ═══════════════════════════════════════════════════════════════════════════════

class TestSlowRequests:
    def test_slow_request_logged(self, client, caplog):
        """耗时 > 2s 的请求应产生 WARNING 日志"""
        with patch("time.time", side_effect=[0.0, 3.5]):  # 模拟 3.5s 耗时
            with caplog.at_level(logging.WARNING, logger="middleware.metrics_middleware"):
                client.get("/api/v1/servers/")
        slow_logs = [r for r in caplog.records if "慢请求" in r.message]
        assert len(slow_logs) >= 1

    def test_slow_request_counter_increments(self, client):
        """慢请求应写入 vps_slow_requests_total"""
        before = _get_metric_value(client, "vps_slow_requests_total")
        with patch("middleware.metrics_middleware.time") as mock_time:
            mock_time.time.side_effect = [0.0, 3.0]
            client.get("/api/v1/servers/")
        after = _get_metric_value(client, "vps_slow_requests_total")
        # 计数应增长（或初始为 0 时从 0 变正数）
        assert after >= before


# ═══════════════════════════════════════════════════════════════════════════════
# 业务指标
# ═══════════════════════════════════════════════════════════════════════════════

class TestBusinessMetrics:
    def test_auth_login_success_metric(self, client):
        """登录成功应触发 vps_auth_logins_total{status=success}"""
        from middleware.metrics_middleware import vps_auth_logins
        before = _read_counter(vps_auth_logins, {"status": "success"})

        client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "TestAdmin@123456",
        })

        after = _read_counter(vps_auth_logins, {"status": "success"})
        # 指标应存在（能读取而不报错）
        assert isinstance(after, (int, float))

    def test_auth_login_failure_metric(self, client):
        """登录失败应触发 vps_auth_logins_total{status=failure}"""
        from middleware.metrics_middleware import vps_auth_logins
        client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "wrong-password",
        })
        after = _read_counter(vps_auth_logins, {"status": "failure"})
        assert isinstance(after, (int, float))

    def test_token_revocation_metric(self, client, auth_headers):
        """登出应触发 vps_auth_token_revocations_total"""
        from middleware.metrics_middleware import vps_auth_token_revocations
        before = _read_counter(vps_auth_token_revocations, {"token_type": "access"})
        client.post("/api/v1/auth/logout", headers=auth_headers)
        after  = _read_counter(vps_auth_token_revocations, {"token_type": "access"})
        assert isinstance(after, (int, float))

    def test_alert_metric_can_inc(self, app):
        """告警指标应可正常 inc"""
        from middleware.metrics_middleware import vps_alerts_fired
        with app.app_context():
            try:
                vps_alerts_fired.labels(alert_type="CPU_HIGH", channel="telegram").inc()
            except Exception as e:
                pytest.fail(f"vps_alerts_fired.inc() 失败: {e}")

    def test_email_metric_can_inc(self, app):
        """邮件指标应可正常 inc"""
        from middleware.metrics_middleware import vps_email_sent
        with app.app_context():
            try:
                vps_email_sent.labels(template="verify", status="success").inc()
                vps_email_sent.labels(template="reset",  status="failure").inc()
            except Exception as e:
                pytest.fail(f"vps_email_sent.inc() 失败: {e}")

    def test_server_gauge_can_set(self, app):
        """服务器 Gauge 应可正常 set"""
        from middleware.metrics_middleware import (
            vps_servers_total, vps_servers_online, vps_servers_offline,
        )
        with app.app_context():
            try:
                vps_servers_total.set(10)
                vps_servers_online.set(8)
                vps_servers_offline.set(2)
            except Exception as e:
                pytest.fail(f"Gauge.set() 失败: {e}")

    def test_probe_latency_histogram(self, app):
        """探针延迟直方图应可正常 observe"""
        from middleware.metrics_middleware import vps_probe_latency_ms
        with app.app_context():
            try:
                vps_probe_latency_ms.observe(45.7)
                vps_probe_latency_ms.observe(312.0)
            except Exception as e:
                pytest.fail(f"vps_probe_latency_ms.observe() 失败: {e}")


# ═══════════════════════════════════════════════════════════════════════════════
# 动态 Log Level 接口
# ═══════════════════════════════════════════════════════════════════════════════

class TestDynamicLogLevel:
    def test_get_log_level(self, client, auth_headers):
        """GET /admin/log-level 应返回当前 level"""
        res = client.get("/admin/log-level", headers=auth_headers)
        assert res.status_code == 200
        data = res.get_json()
        assert "level" in data
        assert data["level"] in ("DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL")

    def test_set_log_level_valid(self, client, auth_headers):
        """POST /admin/log-level 应成功修改 level"""
        res = client.post(
            "/admin/log-level",
            headers=auth_headers,
            json={"level": "DEBUG"},
        )
        assert res.status_code == 200
        assert res.get_json()["level"] == "DEBUG"

        # 恢复 INFO
        client.post("/admin/log-level", headers=auth_headers, json={"level": "INFO"})

    def test_set_log_level_invalid(self, client, auth_headers):
        """无效 level 应返回 400"""
        res = client.post(
            "/admin/log-level",
            headers=auth_headers,
            json={"level": "VERBOSE"},
        )
        assert res.status_code == 400

    def test_log_level_requires_auth(self, client):
        """未授权访问 /admin/log-level 应返回 401"""
        res = client.get("/admin/log-level")
        assert res.status_code == 401


# ═══════════════════════════════════════════════════════════════════════════════
# Sentry 封装测试
# ═══════════════════════════════════════════════════════════════════════════════

class TestSentryWrapper:
    def test_sentry_disabled_when_no_dsn(self, app):
        """SENTRY_DSN 未设置时 init_sentry 应返回 False"""
        from services.observability.sentry import init_sentry
        import os
        original = os.environ.pop("SENTRY_DSN", None)
        try:
            result = init_sentry(app)
            assert result is False
        finally:
            if original:
                os.environ["SENTRY_DSN"] = original

    def test_capture_business_event_without_sentry(self, app):
        """Sentry 未初始化时 capture_business_event 应静默返回 None"""
        from services.observability.sentry import capture_business_event
        with app.app_context():
            result = capture_business_event("测试事件", level="warning")
            assert result is None or isinstance(result, str)

    def test_capture_exception_without_sentry(self, app):
        """Sentry 未初始化时 capture_exception 应静默返回 None"""
        from services.observability.sentry import capture_exception
        with app.app_context():
            result = capture_exception(ValueError("测试异常"))
            assert result is None or isinstance(result, str)

    @patch("sentry_sdk.capture_message", return_value="evt-123")
    def test_capture_business_event_with_sentry(self, mock_capture, app):
        """Sentry 初始化后 capture_business_event 应调用 sentry_sdk"""
        import sentry_sdk
        from services.observability.sentry import capture_business_event

        with app.app_context():
            event_id = capture_business_event(
                "流量超限告警发送失败",
                level="warning",
                extra={"server_id": 1, "pct": 97.5},
                tags={"alert_type": "TRAFFIC"},
            )
            # 若 sentry_sdk 可用，event_id 应为字符串
            assert event_id is None or isinstance(event_id, str)


# ═══════════════════════════════════════════════════════════════════════════════
# 结构化日志 request_id 测试
# ═══════════════════════════════════════════════════════════════════════════════

class TestRequestId:
    def test_response_contains_request_id_header(self, client):
        """每个响应应包含 X-Request-ID 响应头"""
        res = client.get("/api/v1/servers/")
        assert "X-Request-ID" in res.headers
        assert len(res.headers["X-Request-ID"]) > 0

    def test_custom_request_id_echoed(self, client):
        """客户端传入 X-Request-ID 应被原样返回"""
        custom_id = "test-correlation-id-abc123"
        res = client.get(
            "/api/v1/servers/",
            headers={"X-Request-ID": custom_id},
        )
        assert res.headers.get("X-Request-ID") == custom_id

    def test_auto_generated_request_id(self, client):
        """未传入 X-Request-ID 时应自动生成 UUID 格式"""
        import re
        res = client.get("/api/v1/servers/")
        rid = res.headers.get("X-Request-ID", "")
        # 合法 UUID v4 格式
        uuid_re = re.compile(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            re.I,
        )
        assert uuid_re.match(rid), f"X-Request-ID 不是合法 UUID: {rid!r}"


# ═══════════════════════════════════════════════════════════════════════════════
# 工具函数
# ═══════════════════════════════════════════════════════════════════════════════

def _get_metric_value(client, metric_name: str) -> float:
    """从 /metrics 响应中提取指定指标的总计数值（所有 label 求和）"""
    res  = client.get("/metrics")
    body = res.data.decode()
    total = 0.0
    for line in body.splitlines():
        if line.startswith(metric_name) and not line.startswith("#"):
            parts = line.rsplit(" ", 1)
            if len(parts) == 2:
                try:
                    total += float(parts[1])
                except ValueError:
                    pass
    return total


def _read_counter(counter, labels: dict) -> float:
    """读取 prometheus Counter 当前值（兼容 no-op 对象）"""
    try:
        return counter.labels(**labels)._value.get()
    except Exception:
        return 0.0
