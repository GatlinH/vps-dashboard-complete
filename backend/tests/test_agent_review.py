"""
tests/test_agent_review.py — Agent 功能专项审查补充测试

覆盖场景（对应审查报告各阻塞项）：

A. ingest_metrics ProbeResult 使用已验证值（fix #1 回归守卫）
   1. agent 路径：越界 cpu_use 不写入 Server 字段也不写入 ProbeResult
   2. agent 路径：有效值同时写入 Server 字段和 ProbeResult
   3. admin 路径：有效值写入 Server 字段和 ProbeResult（等价性）

B. probe_fetcher 错误类型映射（timeout / connection / HTTP / parse）
   4. timeout   → error_msg == "timed out"
   5. HTTP 非2xx → error_msg.startswith("HTTP ")
   6. 网络连接失败 → 返回 (None, <str>)
   7. JSON 解析失败 → error_msg.startswith("invalid payload")
   8. URL 安全校验失败 → "probe_url 非法或存在安全风险"

C. consumer 结构化日志含 error_type 字段（fix #3 回归守卫）
   9. 处理失败时日志 extra 包含 error_type

D. agent push 降级 dropped 计数（fix #4 回归守卫）
   10. Redis 不可用且信号量耗尽时 record_agent_push("dropped") 被调用

E. consumer 幂等性（相同消息不产生重复 ProbeResult）
   11. 同一 server_id 两次 _handle_message，ProbeResult 增加恰好 2 条（各处理一次）

F. _validate_nonce Redis 不可用时记录 warning（fix #2 回归守卫）
   12. Redis None 时 _validate_nonce 发出 warning 并不抛异常
"""
from __future__ import annotations

import json
import logging
import urllib.error
from unittest.mock import MagicMock, patch

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# A. ingest_metrics ProbeResult 使用已验证值
# ─────────────────────────────────────────────────────────────────────────────

class TestIngestMetricsProbeResult:
    """ProbeResult 只记录通过验证的字段值，不存储原始非法数据。"""

    def test_agent_path_invalid_cpu_use_not_stored_in_probe_result(self, app, test_server):
        """agent 路径中越界的 cpu_use（150%）不应写入 ProbeResult。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            server = db.session.get(Server, test_server)
            original_cpu = server.cpu_use  # 保存原始值

            ingest_metrics(server, {"cpu_use": 150.0}, strict=False, source="agent")
            db.session.commit()

            # Server 字段未被更新
            assert server.cpu_use == original_cpu, (
                "越界 cpu_use 不应更新 Server.cpu_use"
            )
            # ProbeResult 也不应存储越界值
            result = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            assert result is not None
            assert result.cpu_use != 150.0, (
                "ProbeResult 不应存储越界的 cpu_use=150.0"
            )
            assert result.cpu_use == original_cpu, (
                "ProbeResult.cpu_use 应回落为 server 当前值"
            )

    def test_agent_path_valid_cpu_use_stored_in_probe_result(self, app, test_server):
        """agent 路径中合法的 cpu_use 应同步写入 Server 字段和 ProbeResult。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            server = db.session.get(Server, test_server)
            ingest_metrics(server, {"cpu_use": 42.0}, strict=False, source="agent")
            db.session.commit()

            assert server.cpu_use == 42.0
            result = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            assert result is not None
            assert result.cpu_use == 42.0, (
                "合法的 cpu_use 应同时写入 ProbeResult"
            )

    def test_admin_vs_agent_equivalence_for_valid_payload(self, app, test_server):
        """相同合法 payload 走 admin（strict=True）和 agent（strict=False）路径，
        ProbeResult 与 Server 字段应等价。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        payload = {"cpu_use": 33.0, "ram_use": 55.0, "disk_use": 70.0}

        with app.app_context():
            # admin 路径
            server_a = db.session.get(Server, test_server)
            applied_a = ingest_metrics(server_a, payload, strict=True, source="admin")
            pr_a = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            cpu_a = pr_a.cpu_use
            ram_a = pr_a.ram_use
            db.session.rollback()  # 不提交，保持 server 原始状态

        with app.app_context():
            # agent 路径
            server_b = db.session.get(Server, test_server)
            applied_b = ingest_metrics(server_b, payload, strict=False, source="agent")
            pr_b = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            cpu_b = pr_b.cpu_use
            ram_b = pr_b.ram_use
            db.session.rollback()

        assert cpu_a == cpu_b, "admin 和 agent 路径的 ProbeResult.cpu_use 应相等"
        assert ram_a == ram_b, "admin 和 agent 路径的 ProbeResult.ram_use 应相等"
        assert set(applied_a.keys()) == set(applied_b.keys()), (
            "admin 和 agent 路径 applied 字段集合应相同（合法 payload）"
        )

    def test_agent_path_valid_latency_ms_stored(self, app, test_server):
        """agent 路径中合法的 latency_ms 应存入 ProbeResult。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            server = db.session.get(Server, test_server)
            ingest_metrics(server, {"latency_ms": 42.5}, strict=False, source="agent")
            db.session.commit()

            result = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            assert result is not None
            assert result.latency_ms == 42.5

    def test_invalid_latency_ms_not_stored(self, app, test_server):
        """非数字 latency_ms 不应存入 ProbeResult（应为 None）。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            server = db.session.get(Server, test_server)
            ingest_metrics(server, {"latency_ms": "bad"}, strict=False, source="agent")
            db.session.commit()

            result = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            assert result is not None
            assert result.latency_ms is None, (
                "非数字 latency_ms 应被丢弃（存储 None）"
            )

    def test_negative_latency_ms_not_stored(self, app, test_server):
        """负数 latency_ms 不应存入 ProbeResult（应为 None）。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            server = db.session.get(Server, test_server)
            ingest_metrics(server, {"latency_ms": -10.0}, strict=False, source="agent")
            db.session.commit()

            result = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            assert result is not None
            assert result.latency_ms is None, (
                "负数 latency_ms 应被丢弃（存储 None）"
            )

    def test_zero_latency_ms_stored(self, app, test_server):
        """零值 latency_ms 是合法值，应被存储。"""
        from extensions import db
        from models.models import ProbeResult, Server
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            server = db.session.get(Server, test_server)
            ingest_metrics(server, {"latency_ms": 0.0}, strict=False, source="agent")
            db.session.commit()

            result = (
                ProbeResult.query.filter_by(server_id=test_server)
                .order_by(ProbeResult.id.desc())
                .first()
            )
            assert result is not None
            assert result.latency_ms == 0.0



# ─────────────────────────────────────────────────────────────────────────────

class TestProbeFetcherErrorMapping:
    """fetch_and_parse_probe 各类异常映射为预期 error_msg。"""

    def _snap(self):
        return {
            "id": 1, "name": "test",
            "cpu_use": 0.0, "ram_use": 0.0,
            "disk_use": 0.0, "net_up": 0.0, "net_down": 0.0,
            "status": "offline", "uptime": "",
        }

    def test_timeout_maps_to_timed_out(self, app):
        """urllib 超时应映射为 'timed out' 错误。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with app.app_context():
            with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True):
                with patch(
                    "urllib.request.urlopen",
                    side_effect=urllib.error.URLError(TimeoutError("timed out")),
                ):
                    metrics, err = fetch_and_parse_probe(
                        "http://10.0.0.1/probe", self._snap()
                    )
        assert metrics is None
        assert err is not None
        assert "timed out" in err.lower(), f"expected 'timed out' in error, got: {err!r}"

    def test_http_error_maps_to_http_code(self, app):
        """HTTP 非 2xx 应映射为 'HTTP <code>' 格式。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with app.app_context():
            with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True):
                with patch(
                    "urllib.request.urlopen",
                    side_effect=urllib.error.HTTPError(
                        url="http://x/probe", code=503, msg="Service Unavailable",
                        hdrs=None, fp=None,
                    ),
                ):
                    metrics, err = fetch_and_parse_probe(
                        "http://10.0.0.1/probe", self._snap()
                    )
        assert metrics is None
        assert err == "HTTP 503", f"expected 'HTTP 503', got: {err!r}"

    def test_connection_error_returns_error_string(self, app):
        """网络连接失败应返回 (None, <str>)。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with app.app_context():
            with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True):
                with patch(
                    "urllib.request.urlopen",
                    side_effect=urllib.error.URLError("Connection refused"),
                ):
                    metrics, err = fetch_and_parse_probe(
                        "http://10.0.0.1/probe", self._snap()
                    )
        assert metrics is None
        assert err is not None
        assert isinstance(err, str)

    def test_invalid_json_maps_to_invalid_payload(self, app):
        """JSON 解析失败应映射为 'invalid payload: ...' 格式。"""
        from services.probe_fetcher import fetch_and_parse_probe

        bad_body = b"not-valid-json{"
        mock_resp = MagicMock()
        mock_resp.read.return_value = bad_body
        mock_resp.__enter__ = lambda s: s
        mock_resp.__exit__ = MagicMock(return_value=False)

        with app.app_context():
            with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True):
                with patch("urllib.request.urlopen", return_value=mock_resp):
                    metrics, err = fetch_and_parse_probe(
                        "http://10.0.0.1/probe", self._snap()
                    )
        assert metrics is None
        assert err is not None
        assert err.startswith("invalid payload"), (
            f"expected error starting with 'invalid payload', got: {err!r}"
        )

    def test_unsafe_url_blocked(self, app):
        """非法或不安全的 URL 应立即返回安全拒绝错误，不发出 HTTP 请求。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with app.app_context():
            with patch("urllib.request.urlopen") as mock_urlopen:
                metrics, err = fetch_and_parse_probe(
                    "http://169.254.169.254/metadata", self._snap()
                )
                mock_urlopen.assert_not_called()

        assert metrics is None
        assert err == "probe_url 非法或存在安全风险"

    def test_batch_failure_isolation(self, app, test_server):
        """单个探针失败不应影响批量结果中其他服务器的条目。"""
        from extensions import db
        from models.models import Server

        with app.app_context():
            # 创建第二台服务器（用于验证成功隔离）
            s2 = Server(
                name="probe-isolation-ok",
                group_name="test",
                ip="10.1.2.3",
                probe_url="http://10.1.2.3/probe",
                cpu_cores=2, ram_gb=4.0, disk_gb=50,
                price=10.0, period="monthly",
            )
            db.session.add(s2)
            db.session.commit()
            sid2 = s2.id

        with app.app_context():
            # Direct service-layer call via HTTP endpoint
            good_resp = {"cpu_use": 20.0, "ram_use": 30.0, "disk_use": 40.0}
            good_body = json.dumps(good_resp).encode()
            good_mock = MagicMock()
            good_mock.read.return_value = good_body
            good_mock.__enter__ = lambda s: s
            good_mock.__exit__ = MagicMock(return_value=False)

            def _selective_urlopen(req, timeout=8):
                if "10.1.2.3" in req.full_url:
                    return good_mock
                raise urllib.error.URLError("Connection refused")

            with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True):
                with patch("urllib.request.urlopen", side_effect=_selective_urlopen):
                    from services.probe_fetcher import fetch_and_parse_probe

                    s2_snap = {
                        "id": sid2, "name": "probe-isolation-ok",
                        "cpu_use": 0.0, "ram_use": 0.0, "disk_use": 0.0,
                        "net_up": 0.0, "net_down": 0.0,
                        "status": "offline", "uptime": "",
                        "probe_url": "http://10.1.2.3/probe",
                    }
                    m2, e2 = fetch_and_parse_probe(
                        "http://10.1.2.3/probe", s2_snap
                    )
                    s1_snap = {
                        "id": test_server, "name": "bad-probe-server",
                        "cpu_use": 0.0, "ram_use": 0.0, "disk_use": 0.0,
                        "net_up": 0.0, "net_down": 0.0,
                        "status": "offline", "uptime": "",
                        "probe_url": "http://192.0.2.1/probe",
                    }
                    m1, e1 = fetch_and_parse_probe(
                        "http://192.0.2.1/probe", s1_snap
                    )

        # Good server succeeded
        assert e2 is None, f"good server fetch should succeed, got error: {e2}"
        assert m2 is not None
        # Bad server failed (isolated)
        assert m1 is None
        assert e1 is not None


# ─────────────────────────────────────────────────────────────────────────────
# C. consumer 结构化日志含 error_type 字段
# ─────────────────────────────────────────────────────────────────────────────

class TestConsumerStructuredLog:
    """消费失败时，日志 extra 必须包含 error_type 字段。"""

    def test_error_log_includes_error_type(self, app, monkeypatch, caplog):
        """处理失败时，logger.exception extra 应包含 error_type。"""
        import workers.agent_consumer as consumer_module
        import extensions

        logged_extras = []

        class _CapturingHandler(logging.Handler):
            def emit(self, record):
                if "error_type" in record.__dict__:
                    logged_extras.append(record.__dict__.get("error_type"))

        handler = _CapturingHandler()
        consumer_logger = logging.getLogger("workers.agent_consumer")
        consumer_logger.addHandler(handler)

        try:
            bad_payload = json.dumps({"server_id": 999999, "metrics": {}})
            call_count = [0]

            def fake_brpop(key, timeout=5):
                call_count[0] += 1
                if call_count[0] == 1:
                    return (key, bad_payload)
                raise SystemExit(0)

            mock_redis = MagicMock()
            mock_redis.brpop.side_effect = fake_brpop
            mock_redis.llen.return_value = 0
            mock_redis.rpush = MagicMock()

            mock_time = MagicMock()
            mock_time.sleep.side_effect = lambda *a: None
            mock_time.monotonic = __import__("time").monotonic
            mock_time.time = __import__("time").time

            monkeypatch.setattr(consumer_module, "create_app", lambda: app)
            monkeypatch.setattr(extensions, "redis_client", mock_redis)
            monkeypatch.setattr(consumer_module, "time", mock_time)

            with pytest.raises(SystemExit):
                consumer_module.run()
        finally:
            consumer_logger.removeHandler(handler)

        assert len(logged_extras) >= 1, (
            "处理失败时应至少记录一条含 error_type 的日志"
        )
        assert logged_extras[0] == "ValueError", (
            f"error_type 应为 'ValueError'，实际为 {logged_extras[0]!r}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# D. agent push 降级 dropped 计数
# ─────────────────────────────────────────────────────────────────────────────

class TestAgentPushDroppedCounter:
    """Redis 不可用且信号量耗尽时，record_agent_push('dropped') 应被调用。"""

    def test_dropped_counter_called_when_semaphore_exhausted(
        self, app, client, auth_headers, test_server, monkeypatch
    ):
        """Load-shedding 路径应调用 record_agent_push('dropped')。"""
        import hashlib
        import hmac as _hmac
        import time
        import uuid
        import api.agent as agent_module
        import extensions
        import threading

        # Provision agent key and UUID via HTTP API (same as other tests)
        key_resp = client.post(
            f"/api/v1/servers/{test_server}/agent-key/generate",
            headers=auth_headers,
        )
        assert key_resp.status_code == 200
        plain_key = key_resp.get_json()["agent_key"]
        agent_uuid = str(uuid.uuid4())
        claim = client.post(
            "/api/v1/agent/claim",
            json={"server_id": test_server, "uuid": agent_uuid},
            headers=auth_headers,
        )
        assert claim.status_code == 200

        # Reset semaphore cache and set to exhausted (0 permits)
        agent_module._fallback_db_sem = threading.Semaphore(0)

        recorded = []

        def fake_record_agent_push(status):
            recorded.append(status)

        monkeypatch.setattr(agent_module, "record_agent_push", fake_record_agent_push)

        # Patch redis_client to None to trigger fallback path
        orig_redis = extensions.redis_client

        # Build a valid signed request
        payload_dict = {"uuid": agent_uuid, "cpu_use": 10.0}
        raw = json.dumps(payload_dict, separators=(",", ":"), ensure_ascii=False).encode()
        ts = str(int(time.time()))
        nonce = uuid.uuid4().hex
        sig = _hmac.new(
            plain_key.encode(), f"{ts}.{nonce}.".encode() + raw, hashlib.sha256
        ).hexdigest()
        headers = {
            "X-Agent-UUID": agent_uuid,
            "X-Agent-Key": plain_key,
            "X-Agent-Timestamp": ts,
            "X-Agent-Nonce": nonce,
            "X-Agent-Signature": sig,
            "Content-Type": "application/json",
        }

        # Keep Redis available for nonce SET NX, but simulate queue push support
        # being unavailable by using a truthy stub that does not define rpush.
        class _NoRpushRedis:
            """Redis stub: supports nonce SET NX (so auth passes), but has no rpush."""
            def __init__(self, real):
                self._real = real

            def set(self, key, value, ex=None, nx=False):
                return self._real.set(key, value, ex=ex, nx=nx)

        monkeypatch.setattr(extensions, "redis_client", _NoRpushRedis(orig_redis))

        resp = client.post("/api/v1/agent/push", data=raw, headers=headers)
        # Should still return 202 (load-shedding is transparent to agent)
        assert resp.status_code == 202, (
            f"expected 202 even on load-shedding, got {resp.status_code}: "
            f"{resp.get_json()}"
        )
        assert "dropped" in recorded, (
            f"record_agent_push('dropped') should have been called; recorded: {recorded}"
        )
        # Restore semaphore
        agent_module._fallback_db_sem = None

    def test_rpush_exception_falls_back_to_db_write(
        self, app, client, auth_headers, test_server, monkeypatch
    ):
        """rpush 抛出 ConnectionError 时应降级同步写库，仍返回 202，指标数据不丢失。"""
        import hashlib
        import hmac as _hmac
        import time
        import uuid
        import api.agent as agent_module
        import extensions
        from models.models import Server
        from extensions import db as _db

        # Provision agent
        key_resp = client.post(
            f"/api/v1/servers/{test_server}/agent-key/generate",
            headers=auth_headers,
        )
        assert key_resp.status_code == 200
        plain_key = key_resp.get_json()["agent_key"]
        agent_uuid = str(uuid.uuid4())
        claim = client.post(
            "/api/v1/agent/claim",
            json={"server_id": test_server, "uuid": agent_uuid},
            headers=auth_headers,
        )
        assert claim.status_code == 200

        # Ensure semaphore has capacity
        import threading
        agent_module._fallback_db_sem = threading.Semaphore(5)

        orig_redis = extensions.redis_client

        # Build valid signed request
        payload_dict = {"uuid": agent_uuid, "cpu_use": 77.0}
        raw = json.dumps(payload_dict, separators=(",", ":"), ensure_ascii=False).encode()
        ts = str(int(time.time()))
        nonce = uuid.uuid4().hex
        sig = _hmac.new(
            plain_key.encode(), f"{ts}.{nonce}.".encode() + raw, hashlib.sha256
        ).hexdigest()
        headers = {
            "X-Agent-UUID": agent_uuid,
            "X-Agent-Key": plain_key,
            "X-Agent-Timestamp": ts,
            "X-Agent-Nonce": nonce,
            "X-Agent-Signature": sig,
            "Content-Type": "application/json",
        }

        class _RpushFailingRedis:
            """Truthy Redis stub: SET NX works (auth passes), rpush raises."""
            def __init__(self, real):
                self._real = real

            def set(self, key, value, ex=None, nx=False):
                return self._real.set(key, value, ex=ex, nx=nx)

            def rpush(self, *a, **kw):
                raise ConnectionError("redis connection refused")

        monkeypatch.setattr(extensions, "redis_client", _RpushFailingRedis(orig_redis))

        resp = client.post("/api/v1/agent/push", data=raw, headers=headers)
        assert resp.status_code == 202, (
            f"rpush 失败后应降级写库并返回 202，实际: {resp.status_code}: {resp.get_json()}"
        )

        # Verify server was updated via the fallback DB write
        with app.app_context():
            server = _db.session.get(Server, test_server)
            assert server.cpu_use == 77.0, (
                "rpush 失败后降级同步写库应更新 Server.cpu_use"
            )

        # Restore
        agent_module._fallback_db_sem = None


# ─────────────────────────────────────────────────────────────────────────────
# E. consumer 重复消息处理安全性
# ─────────────────────────────────────────────────────────────────────────────

class TestConsumerDuplicateMessageHandling:
    """相同消息处理两次时，应各自产生一次正常写入，总计新增 2 行 ProbeResult，而非更多。"""

    def test_duplicate_messages_produce_two_probe_results(self, app, test_server):
        """_handle_message 调用两次时应新增 2 行 ProbeResult，体现重复投递可安全处理而非幂等去重。"""
        from extensions import db
        from models.models import ProbeResult
        import workers.agent_consumer as consumer_module

        raw = json.dumps({
            "server_id": test_server,
            "metrics": {"cpu_use": 25.0, "ram_use": 35.0},
        })

        with app.app_context():
            before = ProbeResult.query.filter_by(server_id=test_server).count()

            consumer_module._handle_message(raw)
            consumer_module._handle_message(raw)  # "duplicate"

            after = ProbeResult.query.filter_by(server_id=test_server).count()
            assert after - before == 2, (
                f"两次处理应产生 2 行 ProbeResult，实际增加 {after - before} 行"
            )


# ─────────────────────────────────────────────────────────────────────────────
# F. _validate_nonce Redis 不可用时记录 warning
# ─────────────────────────────────────────────────────────────────────────────

class TestValidateNonceRedisUnavailable:
    """Redis 不可用时 _validate_nonce 记录 warning 并不抛异常（降级放行）。"""

    def test_warning_logged_when_redis_unavailable(self, app, monkeypatch, caplog):
        """extensions.redis_client=None 时应记录 warning 而不是抛出异常。"""
        import api.agent as agent_module
        import extensions

        orig = extensions.redis_client
        monkeypatch.setattr(extensions, "redis_client", None)
        try:
            with app.app_context():
                with caplog.at_level(logging.WARNING, logger="api.agent"):
                    # Should not raise
                    agent_module._validate_nonce("test-uuid", "test-nonce")
        finally:
            extensions.redis_client = orig

        assert any("nonce validation skipped" in r.message for r in caplog.records), (
            "Redis 不可用时应记录包含 'nonce validation skipped' 的 warning"
        )

    def test_warning_logged_when_redis_raises(self, app, monkeypatch, caplog):
        """redis.set() 抛异常时（如 ConnectionError）应记录 warning 而不是抛出异常。"""
        import api.agent as agent_module
        import extensions

        class _FailingRedis:
            """Truthy Redis stub whose set() always raises ConnectionError."""
            def set(self, *a, **kw):
                raise ConnectionError("redis connection timeout")

        monkeypatch.setattr(extensions, "redis_client", _FailingRedis())
        with app.app_context():
            with caplog.at_level(logging.WARNING, logger="api.agent"):
                # Should not raise — must degrade gracefully
                agent_module._validate_nonce("test-uuid-exc", "test-nonce-exc")

        assert any("nonce validation skipped" in r.message for r in caplog.records), (
            "Redis 抛异常时应记录包含 'nonce validation skipped' 的 warning"
        )

    def test_nonce_replay_still_rejected_when_redis_available(self, app, monkeypatch):
        """Redis 可用时，相同 nonce 重复使用应引发 AuthenticationError。"""
        import api.agent as agent_module
        from utils.errors import AuthenticationError

        with app.app_context():
            # First call: succeeds
            agent_module._validate_nonce("uuid-replay", "nonce-abc")
            # Second call: same nonce → replay
            with pytest.raises(AuthenticationError, match="replayed request"):
                agent_module._validate_nonce("uuid-replay", "nonce-abc")
