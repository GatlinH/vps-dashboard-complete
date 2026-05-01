"""
P1 审计修复回归测试

覆盖本次 P1 优化的四个修复点：
  P1-A: scheduler._tcp_ping_one 纯函数行为（不依赖 DB）
  P1-B: scheduler._job_tcp_ping 并发执行（ThreadPoolExecutor）
  P1-C: geo._remote_identity 使用 request.remote_addr（不读取 X-Forwarded-For）
  P1-D: audit._get_client_ip 使用 request.remote_addr（不读取 HTTP_X_FORWARDED_FOR）
  P1-E: middleware/validators.py 不再导出重复 Limiter 实例
  P1-F: services/alert_service.py 已删除，不可 import
"""

import importlib
import sys
from unittest.mock import MagicMock, patch

from flask import Flask


# ── P1-A: _tcp_ping_one 纯函数行为 ────────────────────────────────────────────

def test_tcp_ping_one_offline_when_connection_refused():
    """连接失败时应返回 offline 状态，latency_ms 为 None。"""
    from services.scheduler import _tcp_ping_one

    # connect_ex 返回非 0 表示连接失败
    with patch('socket.socket') as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock_cls.return_value = mock_sock
        mock_sock.connect_ex.return_value = 111  # ECONNREFUSED

        result = _tcp_ping_one(server_id=1, ip="127.0.0.1", timeout=1.0)

    assert result["server_id"] == 1
    assert result["status"] == "offline"
    assert result["latency_ms"] is None


def test_tcp_ping_one_online_when_connection_succeeds():
    """连接成功且延迟 <=300ms 时应返回 online 状态。"""
    import time
    from services.scheduler import _tcp_ping_one

    with patch('socket.socket') as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock_cls.return_value = mock_sock
        mock_sock.connect_ex.return_value = 0  # success

        with patch('time.perf_counter', side_effect=[0.0, 0.1]):  # 100ms
            result = _tcp_ping_one(server_id=2, ip="1.2.3.4", timeout=5.0)

    assert result["server_id"] == 2
    assert result["status"] == "online"
    assert result["latency_ms"] == 100.0


def test_tcp_ping_one_warn_when_high_latency():
    """连接成功但延迟 >300ms 时应返回 warn 状态。"""
    from services.scheduler import _tcp_ping_one

    with patch('socket.socket') as mock_sock_cls:
        mock_sock = MagicMock()
        mock_sock_cls.return_value = mock_sock
        mock_sock.connect_ex.return_value = 0  # success

        with patch('time.perf_counter', side_effect=[0.0, 0.5]):  # 500ms
            result = _tcp_ping_one(server_id=3, ip="1.2.3.5", timeout=5.0)

    assert result["status"] == "warn"
    assert result["latency_ms"] == 500.0


def test_tcp_ping_one_offline_on_exception():
    """socket 异常时应返回 offline，不抛出异常。"""
    from services.scheduler import _tcp_ping_one

    with patch('socket.socket') as mock_sock_cls:
        mock_sock_cls.side_effect = OSError("network unavailable")
        result = _tcp_ping_one(server_id=4, ip="bad-ip", timeout=1.0)

    assert result["status"] == "offline"
    assert result["latency_ms"] is None


# ── P1-B: _job_tcp_ping 并发执行（ThreadPoolExecutor）────────────────────────

def test_job_tcp_ping_uses_thread_pool(app):
    """_job_tcp_ping 应通过 ThreadPoolExecutor 并发执行，而非串行循环。"""
    from concurrent.futures import ThreadPoolExecutor
    from services import scheduler as sched_module

    submitted_calls = []

    original_executor = ThreadPoolExecutor

    class _TrackingExecutor:
        def __init__(self, **kwargs):
            self._pool = original_executor(**kwargs)
            self.max_workers = kwargs.get("max_workers", 1)

        def submit(self, fn, *args, **kwargs):
            submitted_calls.append(args)
            return self._pool.submit(fn, *args, **kwargs)

        def __enter__(self):
            self._pool.__enter__()
            return self

        def __exit__(self, *a):
            return self._pool.__exit__(*a)

    # Stub out prometheus metrics to avoid duplicate-registration errors
    mock_gauge = MagicMock()
    mock_hist  = MagicMock()
    fake_metrics = MagicMock(
        vps_servers_total=mock_gauge,
        vps_servers_online=mock_gauge,
        vps_servers_offline=mock_gauge,
        vps_probe_latency_ms=mock_hist,
    )

    with patch.object(sched_module, 'ThreadPoolExecutor', _TrackingExecutor):
        with patch.object(sched_module, '_tcp_ping_one', return_value={
            "server_id": 1, "status": "offline", "latency_ms": None
        }):
            with patch.dict('sys.modules', {'utils.metrics': fake_metrics}):
                with app.app_context():
                    from models.models import Server
                    from extensions import db

                    # Insert two servers
                    s1 = Server(name='s1_ping_test', ip='10.0.0.1', status='online')
                    s2 = Server(name='s2_ping_test', ip='10.0.0.2', status='online')
                    db.session.add_all([s1, s2])
                    db.session.commit()

                    sched_module._job_tcp_ping(app)

                    # cleanup
                    db.session.delete(s1)
                    db.session.delete(s2)
                    db.session.commit()

    # If ThreadPoolExecutor was used, submit should have been called
    assert len(submitted_calls) >= 2, (
        f"Expected ≥2 concurrent submissions, got {len(submitted_calls)}"
    )


# ── P1-C: geo._remote_identity 使用 request.remote_addr ──────────────────────

def test_geo_remote_identity_uses_remote_addr_not_forwarded_for():
    """`_remote_identity` 应返回 request.remote_addr，忽略 X-Forwarded-For。"""
    app = Flask(__name__)

    with app.test_request_context(
        '/',
        environ_base={'REMOTE_ADDR': '10.0.0.1'},
        headers={'X-Forwarded-For': '1.2.3.4'},
    ):
        from api.geo import _remote_identity
        result = _remote_identity()

    # Must use REMOTE_ADDR (ProxyFix-processed), NOT X-Forwarded-For
    assert result == '10.0.0.1', (
        f"_remote_identity should return remote_addr='10.0.0.1', got '{result}'"
    )


def test_geo_remote_identity_returns_unknown_when_no_addr():
    """`_remote_identity` 在没有地址时应返回 'unknown'。"""
    app = Flask(__name__)

    with app.test_request_context('/', environ_base={'REMOTE_ADDR': ''}):
        from api.geo import _remote_identity
        result = _remote_identity()

    assert result == 'unknown'


# ── P1-D: audit._get_client_ip 使用 request.remote_addr ─────────────────────

def test_audit_get_client_ip_uses_remote_addr():
    """`_get_client_ip` 应返回 request.remote_addr，忽略 HTTP_X_FORWARDED_FOR。"""
    app = Flask(__name__)

    with app.test_request_context(
        '/',
        environ_base={
            'REMOTE_ADDR': '192.168.1.1',
            'HTTP_X_FORWARDED_FOR': '203.0.113.5',
        },
    ):
        from middleware.audit import AuditMiddleware
        audit = AuditMiddleware()
        result = audit._get_client_ip()

    # Must trust REMOTE_ADDR (set by ProxyFix), not the raw forwarded header
    assert result == '192.168.1.1', (
        f"_get_client_ip should return remote_addr='192.168.1.1', got '{result}'"
    )


def test_audit_get_client_ip_returns_unknown_when_no_addr():
    """`_get_client_ip` 在没有地址时应返回 'unknown'。"""
    app = Flask(__name__)

    with app.test_request_context('/', environ_base={'REMOTE_ADDR': ''}):
        from middleware.audit import AuditMiddleware
        audit = AuditMiddleware()
        result = audit._get_client_ip()

    assert result == 'unknown'


# ── P1-E: middleware/validators.py 不再含重复 Limiter ───────────────────────

def test_validators_module_has_no_duplicate_limiter():
    """validators.py 不应再包含重复的 Limiter 实例或 init_limiter 函数。"""
    import middleware.validators as validators_mod

    assert not hasattr(validators_mod, 'limiter'), (
        "middleware/validators.py 不应导出 'limiter' —— 应只在 middleware/rate_limit.py 中定义"
    )
    assert not hasattr(validators_mod, 'init_limiter'), (
        "middleware/validators.py 不应导出 'init_limiter' —— 已在 middleware/rate_limit.py 中"
    )


def test_rate_limit_module_still_exports_limiter():
    """真正的 limiter 实例仍在 middleware/rate_limit.py 中。"""
    from middleware.rate_limit import limiter, RateLimitConfig
    assert limiter is not None
    assert callable(getattr(RateLimitConfig, 'init_app', None))


# ── P1-F: services/alert_service.py 已删除 ──────────────────────────────────

def test_alert_service_module_deleted():
    """services.alert_service 模块应已删除，不可 import。"""
    # ensure it's not cached in sys.modules from a previous import
    sys.modules.pop('services.alert_service', None)

    try:
        import services.alert_service  # noqa: F401
        imported = True
    except ModuleNotFoundError:
        imported = False

    assert not imported, (
        "services/alert_service.py 应已删除；仍可 import 说明清理未完成"
    )
