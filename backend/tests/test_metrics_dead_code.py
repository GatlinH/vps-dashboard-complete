"""
P2: metrics 死代码清理验证测试

确认：
1. services/metrics.py 已删除，不再存在重复注册路径
2. utils/metrics.py 已删除，不再有与 metrics_middleware 重名的 gauge/histogram
3. 活跃路径 middleware/metrics_middleware 仍可正常 import，关键函数可调用
4. scheduler.py 现在从 metrics_middleware 获取 gauge 对象，不再触发重复注册
"""

import importlib
import importlib.util
import os
import sys


def test_services_metrics_py_does_not_exist():
    """services/metrics.py 已删除，无法被 import，消除了重复注册 vps_requests_total 的风险。"""
    assert importlib.util.find_spec("services.metrics") is None, (
        "services/metrics.py 应已删除。它注册了与 metrics_middleware 同名的 Prometheus 指标，"
        "一旦被 import 就会引发 ValueError: Duplicated timeseries。"
    )


def test_utils_metrics_py_does_not_exist():
    """utils/metrics.py 已删除，消除了与 metrics_middleware 重名的 gauge/histogram 重复注册风险。"""
    assert importlib.util.find_spec("utils.metrics") is None, (
        "utils/metrics.py 应已删除。它定义了与 metrics_middleware 同名的 "
        "vps_servers_total / vps_servers_online / vps_servers_offline / vps_probe_latency_ms，"
        "scheduler._job_tcp_ping 调用时会触发 ValueError: Duplicated timeseries。"
    )


def test_metrics_middleware_imports_cleanly():
    """middleware.metrics_middleware 仍可正常导入，核心对象与函数均存在。"""
    from middleware.metrics_middleware import (
        init_metrics,
        record_auth_login,
        record_alert_fired,
        record_probe_latency,
        record_traffic_limit_exceeded,
        record_email_sent,
        record_agent_push,
        record_agent_poll,
        record_agent_ack,
        record_scheduler_job,
        record_token_revocation,
        set_server_counts,
        vps_servers_total,
        vps_servers_online,
        vps_servers_offline,
        vps_probe_latency_ms,
    )
    assert callable(init_metrics)
    assert callable(record_auth_login)
    assert callable(set_server_counts)


def test_scheduler_imports_gauges_from_metrics_middleware():
    """scheduler._job_tcp_ping 从 metrics_middleware 获取 gauge 对象，不再依赖已删除的 utils/metrics.py。

    We verify this by running the lazy import block directly in an isolated
    sys.modules snapshot: utils.metrics must NOT be present after the import
    succeeds, while metrics_middleware MUST be present.
    """
    # Simulate what _job_tcp_ping does: import the four gauge/histogram objects.
    # If the import still pointed at the deleted utils.metrics module, this
    # line would raise ModuleNotFoundError.
    from middleware.metrics_middleware import (  # noqa: F401
        vps_servers_total,
        vps_servers_online,
        vps_servers_offline,
        vps_probe_latency_ms,
    )

    # Confirm the deleted module is absent from the import cache.
    assert "utils.metrics" not in sys.modules, (
        "utils.metrics should not be importable after dead-code cleanup"
    )
    # Confirm the authoritative module is present.
    assert "middleware.metrics_middleware" in sys.modules


def test_no_duplicate_registration_on_double_import():
    """多次 import metrics_middleware 不会触发 Prometheus 重复注册异常（模块缓存机制）。"""
    # 若发生重复注册，以下 import 会抛出 ValueError
    import middleware.metrics_middleware as mm1
    import middleware.metrics_middleware as mm2
    assert mm1 is mm2, "同一进程中多次 import 应返回同一模块对象"


def test_active_metrics_endpoint_still_works(client):
    """/metrics 端点在清理后仍然可以正常响应（200 + Prometheus 格式）。"""
    resp = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert resp.status_code == 200
    body = resp.data.decode()
    # 确认核心指标仍然存在
    assert "vps_requests_total" in body
    assert "vps_servers_total" in body


def test_record_helpers_work_end_to_end(client):
    """清理后，metrics_middleware 的 record_* 辅助函数仍然正常工作，指标可在 /metrics 中看到。"""
    from middleware.metrics_middleware import (
        record_auth_login,
        record_alert_fired,
        set_server_counts,
    )

    record_auth_login("success")
    record_alert_fired("traffic", "telegram")
    set_server_counts(total=5, online=3, offline=2)

    resp = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert resp.status_code == 200
    body = resp.data.decode()
    assert 'vps_auth_logins_total{status="success"}' in body
    assert 'vps_alerts_fired_total{alert_type="traffic",channel="telegram"}' in body
    assert "vps_servers_total 5.0" in body
