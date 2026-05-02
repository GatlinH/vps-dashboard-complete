"""
test_p2_2_metrics_dedup.py — P2-2 自检测试

覆盖范围（与问题描述 E 节要求对应）：
  1. 等价性测试    — 相同 payload 分别走 admin/agent 路径，落库结果一致
  2. 鉴权测试      — admin 路径非管理员拒绝；agent 路径非法/过期凭证拒绝
  3. 校验测试      — 缺字段、类型错误、越界值与历史语义一致
  4. 错误映射测试  — 共享层各类异常在两端点都映射到预期状态码
  5. 回归测试      — 现有测试文件中与 metrics push 相关的用例仍能通过
  6. 幂等/重复上报 — 重复提交不会造成异常重复写入
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid as _uuid

import pytest

from extensions import db as _db
from models.models import ProbeResult, Server


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _agent_headers(agent_key: str, raw_body: bytes, agent_uuid: str, nonce: str = "n1"):
    ts = str(int(time.time()))
    sig = hmac.new(
        agent_key.encode("utf-8"),
        f"{ts}.{nonce}.".encode("utf-8") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-Agent-UUID": agent_uuid,
        "X-Agent-Key": agent_key,
        "X-Agent-Timestamp": ts,
        "X-Agent-Nonce": nonce,
        "X-Agent-Signature": sig,
    }


def _provision_agent(client, auth_headers, server_id):
    """Register an agent key + UUID for *server_id*, return (key, uuid)."""
    key_resp = client.post(
        f"/api/v1/servers/{server_id}/agent-key/generate",
        headers=auth_headers,
    )
    assert key_resp.status_code == 200, key_resp.get_json()
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(_uuid.uuid4())
    claim = client.post(
        "/api/v1/agent/claim",
        json={"server_id": server_id, "uuid": agent_uuid},
        headers=auth_headers,
    )
    assert claim.status_code == 200, claim.get_json()
    return agent_key, agent_uuid


def _agent_push(client, agent_key, agent_uuid, payload: dict, nonce: str):
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce=nonce)
    return client.post(
        "/api/v1/agent/push",
        data=raw,
        headers={**headers, "Content-Type": "application/json"},
    )


def _admin_push(client, auth_headers, server_id, payload: dict):
    return client.post(
        f"/api/v1/servers/{server_id}/metrics",
        json=payload,
        headers=auth_headers,
    )


def _last_probe(app, server_id):
    """Return the most recent ProbeResult for *server_id*."""
    with app.app_context():
        return (
            ProbeResult.query
            .filter_by(server_id=server_id)
            .order_by(ProbeResult.id.desc())
            .first()
        )


def _get_server(app, server_id):
    with app.app_context():
        return _db.session.get(Server, server_id)


# ─────────────────────────────────────────────────────────────────────────────
# 1. 等价性测试
# ─────────────────────────────────────────────────────────────────────────────

class TestEquivalence:
    """相同 payload 分别走 admin/agent 路径，落库结果应一致。"""

    PAYLOAD = {
        "cpu_use": 42.0,
        "ram_use": 55.5,
        "disk_use": 30.0,
        "net_up": 100.0,
        "net_down": 200.0,
        "status": "online",
        "latency_ms": 12,
    }

    def test_admin_probe_result_matches_payload(self, client, auth_headers, test_server, app):
        resp = _admin_push(client, auth_headers, test_server, self.PAYLOAD)
        assert resp.status_code == 200, resp.get_json()

        probe = _last_probe(app, test_server)
        assert probe is not None
        assert abs(probe.cpu_use - 42.0) < 1e-6
        assert abs(probe.ram_use - 55.5) < 1e-6
        assert abs(probe.disk_use - 30.0) < 1e-6
        assert probe.status == "online"
        assert probe.latency_ms == 12

    def test_agent_probe_result_matches_payload(self, client, auth_headers, test_server, app):
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        payload = {**self.PAYLOAD, "uuid": agent_uuid}
        resp = _agent_push(client, agent_key, agent_uuid, payload, nonce="eq-agent-1")
        assert resp.status_code == 202, resp.get_json()

        # Agent push enqueues to Redis; simulate the consumer processing the item.
        from api.agent import _QUEUE_KEY
        import extensions as _ext
        raw = None
        # fakeredis exposes rpop; _InMemoryRedis does not have rpop but also lacks rpush,
        # so the fallback path already wrote to DB synchronously.
        if hasattr(_ext.redis_client, "rpop"):
            raw = _ext.redis_client.rpop(_QUEUE_KEY)
        if raw:
            from workers.agent_consumer import _handle_message
            with app.app_context():
                _handle_message(raw)

        probe = _last_probe(app, test_server)
        assert probe is not None
        assert abs(probe.cpu_use - 42.0) < 1e-6
        assert abs(probe.ram_use - 55.5) < 1e-6
        assert abs(probe.disk_use - 30.0) < 1e-6
        assert probe.status == "online"
        assert probe.latency_ms == 12

    def test_admin_and_agent_write_same_server_fields(self, client, auth_headers, test_server, app):
        """Both paths should result in the same server object state for valid data."""
        # Push via admin
        _admin_push(client, auth_headers, test_server, {"cpu_use": 11.0, "ram_use": 22.0, "status": "online"})
        srv_admin = _get_server(app, test_server)
        admin_cpu = srv_admin.cpu_use
        admin_ram = srv_admin.ram_use
        admin_status = srv_admin.status

        # Push via agent with same values
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        _agent_push(client, agent_key, agent_uuid,
                    {"uuid": agent_uuid, "cpu_use": 11.0, "ram_use": 22.0, "status": "online"},
                    nonce="eq-both-1")
        srv_agent = _get_server(app, test_server)
        assert abs(srv_agent.cpu_use - admin_cpu) < 1e-6
        assert abs(srv_agent.ram_use - admin_ram) < 1e-6
        assert srv_agent.status == admin_status


# ─────────────────────────────────────────────────────────────────────────────
# 2. 鉴权测试
# ─────────────────────────────────────────────────────────────────────────────

class TestAuth:
    """admin 路径需要 JWT admin 角色；agent 路径需要有效凭证。"""

    def test_admin_push_requires_jwt(self, client, test_server):
        resp = client.post(f"/api/v1/servers/{test_server}/metrics", json={"cpu_use": 1.0})
        assert resp.status_code == 401

    def test_admin_push_requires_admin_role(self, client, test_server):
        from flask_jwt_extended import create_access_token
        with client.application.app_context():
            token = create_access_token(
                identity="9999",
                additional_claims={"role": "viewer", "username": "viewer_user"},
            )
        resp = client.post(
            f"/api/v1/servers/{test_server}/metrics",
            json={"cpu_use": 1.0},
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 403

    def test_agent_push_requires_valid_key(self, client, auth_headers, test_server):
        agent_uuid = str(_uuid.uuid4())
        # Claim UUID but do NOT generate a proper key
        client.post(
            "/api/v1/servers/{}/agent-key/generate".format(test_server),
            headers=auth_headers,
        )
        client.post(
            "/api/v1/agent/claim",
            json={"server_id": test_server, "uuid": agent_uuid},
            headers=auth_headers,
        )
        bad_key = "thisisnottheagentkey"
        payload = {"uuid": agent_uuid, "cpu_use": 10.0}
        raw = json.dumps(payload, separators=(",", ":")).encode()
        headers = _agent_headers(bad_key, raw, agent_uuid, nonce="auth-bad-1")
        resp = client.post(
            "/api/v1/agent/push",
            data=raw,
            headers={**headers, "Content-Type": "application/json"},
        )
        assert resp.status_code == 401

    def test_agent_push_rejects_missing_auth_headers(self, client, auth_headers, test_server):
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        raw = json.dumps({"uuid": agent_uuid, "cpu_use": 5.0}).encode()
        # Send request without any X-Agent-* headers
        resp = client.post(
            "/api/v1/agent/push",
            data=raw,
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 401

    def test_agent_push_rejects_unknown_uuid(self, client):
        agent_uuid = str(_uuid.uuid4())
        raw = b'{"cpu_use": 1.0}'
        headers = _agent_headers("anykey", raw, agent_uuid, nonce="auth-unknown-1")
        resp = client.post(
            "/api/v1/agent/push",
            data=raw,
            headers={**headers, "Content-Type": "application/json"},
        )
        assert resp.status_code == 401


# ─────────────────────────────────────────────────────────────────────────────
# 3. 校验测试
# ─────────────────────────────────────────────────────────────────────────────

class TestValidation:
    """字段校验行为：admin 路径严格（抛 400），agent 路径宽松（忽略）。"""

    # ── Admin path ────────────────────────────────────────────────────────────

    def test_admin_rejects_non_numeric_cpu(self, client, auth_headers, test_server):
        resp = _admin_push(client, auth_headers, test_server, {"cpu_use": "notanumber"})
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error_code"] == "VALIDATION_ERROR"
        assert body["details"]["field"] == "cpu_use"

    def test_admin_rejects_out_of_range_ram(self, client, auth_headers, test_server):
        resp = _admin_push(client, auth_headers, test_server, {"ram_use": 150.0})
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error_code"] == "VALIDATION_ERROR"
        assert body["details"]["field"] == "ram_use"

    def test_admin_rejects_negative_disk(self, client, auth_headers, test_server):
        resp = _admin_push(client, auth_headers, test_server, {"disk_use": -1.0})
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["error_code"] == "VALIDATION_ERROR"

    def test_admin_accepts_zero_and_hundred(self, client, auth_headers, test_server, app):
        resp = _admin_push(client, auth_headers, test_server, {"cpu_use": 0.0, "disk_use": 100.0})
        assert resp.status_code == 200

    def test_admin_empty_payload_succeeds(self, client, auth_headers, test_server):
        """Empty payload is valid — nothing is updated, probe snapshot still written."""
        resp = _admin_push(client, auth_headers, test_server, {})
        assert resp.status_code == 200
        body = resp.get_json()
        assert body["metrics"] == {}

    # ── Agent path ────────────────────────────────────────────────────────────

    def test_agent_silently_ignores_non_numeric_cpu(self, client, auth_headers, test_server, app):
        """Agent must NOT crash on bad cpu_use — it returns 202 and skips the field."""
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        # First, set a known cpu_use via admin
        _admin_push(client, auth_headers, test_server, {"cpu_use": 77.0})

        resp = _agent_push(client, agent_key, agent_uuid,
                           {"uuid": agent_uuid, "cpu_use": "bad"},
                           nonce="val-agent-1")
        assert resp.status_code == 202
        srv = _get_server(app, test_server)
        # cpu_use must NOT have been overwritten with garbage
        assert abs(srv.cpu_use - 77.0) < 1e-6

    def test_agent_silently_ignores_out_of_range_ram(self, client, auth_headers, test_server, app):
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        _admin_push(client, auth_headers, test_server, {"ram_use": 33.0})

        resp = _agent_push(client, agent_key, agent_uuid,
                           {"uuid": agent_uuid, "ram_use": 999.0},
                           nonce="val-agent-2")
        assert resp.status_code == 202
        srv = _get_server(app, test_server)
        assert abs(srv.ram_use - 33.0) < 1e-6

    def test_agent_silently_ignores_negative_net_up(self, client, auth_headers, test_server, app):
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        _admin_push(client, auth_headers, test_server, {"net_up": 50.0})

        resp = _agent_push(client, agent_key, agent_uuid,
                           {"uuid": agent_uuid, "net_up": -10.0},
                           nonce="val-agent-3")
        assert resp.status_code == 202
        srv = _get_server(app, test_server)
        assert abs(srv.net_up - 50.0) < 1e-6

    def test_agent_silently_ignores_long_status_string(self, client, auth_headers, test_server, app):
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        _admin_push(client, auth_headers, test_server, {"status": "online"})

        resp = _agent_push(client, agent_key, agent_uuid,
                           {"uuid": agent_uuid, "status": "x" * 65},
                           nonce="val-agent-4")
        assert resp.status_code == 202
        srv = _get_server(app, test_server)
        assert srv.status == "online"


# ─────────────────────────────────────────────────────────────────────────────
# 4. 错误映射测试
# ─────────────────────────────────────────────────────────────────────────────

class TestErrorMapping:
    """Errors raised by shared layer map to stable HTTP codes on both endpoints."""

    def test_admin_404_for_missing_server(self, client, auth_headers):
        resp = _admin_push(client, auth_headers, 999999, {"cpu_use": 1.0})
        assert resp.status_code == 404

    def test_admin_400_on_validation_error_has_stable_schema(self, client, auth_headers, test_server):
        resp = _admin_push(client, auth_headers, test_server, {"cpu_use": "bad"})
        assert resp.status_code == 400
        body = resp.get_json()
        assert body["success"] is False
        assert body["error_code"] == "VALIDATION_ERROR"
        assert "field" in body["details"]

    def test_agent_401_on_invalid_credentials(self, client):
        """Agent path must map AuthenticationError → 401."""
        raw = b'{"cpu_use": 1.0}'
        headers = _agent_headers("wrongkey", raw, "no-such-uuid", nonce="err-1")
        resp = client.post(
            "/api/v1/agent/push",
            data=raw,
            headers={**headers, "Content-Type": "application/json"},
        )
        assert resp.status_code == 401

    def test_admin_push_returns_metrics_key_in_body(self, client, auth_headers, test_server):
        """Successful admin push always wraps result in a 'metrics' key."""
        resp = _admin_push(client, auth_headers, test_server, {"cpu_use": 10.0})
        assert resp.status_code == 200
        body = resp.get_json()
        assert "metrics" in body

    def test_agent_push_returns_accepted_true(self, client, auth_headers, test_server):
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        resp = _agent_push(client, agent_key, agent_uuid,
                           {"uuid": agent_uuid, "cpu_use": 10.0},
                           nonce="err-agent-1")
        assert resp.status_code == 202
        body = resp.get_json()
        assert body.get("accepted") is True


# ─────────────────────────────────────────────────────────────────────────────
# 5. Traffic-delta equivalence
# ─────────────────────────────────────────────────────────────────────────────

class TestTrafficDelta:
    """bytes_out_total / bytes_in_total delta logic behaves identically on both paths."""

    # Use exact GiB multiples so assertions are deterministic.
    # prime: prev_out=0, prev_in=0 → no delta; only sets snapshot.
    # delta: diff of exactly 1 GiB out, 0.5 GiB in.
    _PRIME_OUT = 1_073_741_824        # 1 GiB
    _PRIME_IN  =   536_870_912        # 0.5 GiB
    _DELTA_OUT = 2_147_483_648        # 2 GiB (→ delta = 1 GiB)
    _DELTA_IN  = 1_073_741_824        # 1 GiB (→ delta = 0.5 GiB)

    def _prime_snapshot(self, client, auth_headers, server_id):
        _admin_push(client, auth_headers, server_id, {
            "bytes_out_total": self._PRIME_OUT,
            "bytes_in_total":  self._PRIME_IN,
        })

    def test_admin_traffic_delta(self, client, auth_headers, test_server, app):
        # Prime snapshot (prev=0 so no delta yet)
        self._prime_snapshot(client, auth_headers, test_server)
        # Push delta
        _admin_push(client, auth_headers, test_server, {
            "bytes_out_total": self._DELTA_OUT,
            "bytes_in_total":  self._DELTA_IN,
        })
        srv = _get_server(app, test_server)
        assert srv.traffic_up_gb is not None
        assert abs(srv.traffic_up_gb - 1.0) < 1e-6
        assert srv.traffic_down_gb is not None
        assert abs(srv.traffic_down_gb - 0.5) < 1e-6

    def test_agent_traffic_delta(self, client, auth_headers, test_server, app):
        # Prime snapshot via admin
        self._prime_snapshot(client, auth_headers, test_server)
        # Push delta via agent
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
        resp = _agent_push(client, agent_key, agent_uuid, {
            "uuid": agent_uuid,
            "bytes_out_total": self._DELTA_OUT,
            "bytes_in_total":  self._DELTA_IN,
        }, nonce="traffic-agent-1")
        assert resp.status_code == 202

        # Drain the queue (simulate agent consumer)
        from api.agent import _QUEUE_KEY
        import extensions as _ext
        raw = None
        if hasattr(_ext.redis_client, "rpop"):
            raw = _ext.redis_client.rpop(_QUEUE_KEY)
        if raw:
            from workers.agent_consumer import _handle_message
            with app.app_context():
                _handle_message(raw)

        srv = _get_server(app, test_server)
        assert srv.traffic_up_gb is not None
        assert abs(srv.traffic_up_gb - 1.0) < 1e-6
        assert srv.traffic_down_gb is not None
        assert abs(srv.traffic_down_gb - 0.5) < 1e-6


# ─────────────────────────────────────────────────────────────────────────────
# 6. 幂等/重复上报测试
# ─────────────────────────────────────────────────────────────────────────────

class TestIdempotency:
    """Repeated identical pushes create additional ProbeResult rows (expected)
    but do NOT corrupt traffic counters."""

    def test_repeated_admin_push_creates_multiple_probe_results(
        self, client, auth_headers, test_server, app
    ):
        with app.app_context():
            before_count = ProbeResult.query.filter_by(server_id=test_server).count()

        for i in range(3):
            resp = _admin_push(client, auth_headers, test_server,
                               {"cpu_use": 50.0, "status": "online"})
            assert resp.status_code == 200

        with app.app_context():
            after_count = ProbeResult.query.filter_by(server_id=test_server).count()
        assert after_count == before_count + 3

    def test_repeated_identical_traffic_snapshot_does_not_accumulate(
        self, client, auth_headers, test_server, app
    ):
        """If bytes_out_total is not monotonically increasing, no delta is added."""
        _admin_push(client, auth_headers, test_server, {
            "bytes_out_total": 2_000_000_000,
            "bytes_in_total": 1_000_000_000,
        })
        srv_after_first = _get_server(app, test_server)
        up_after_first = srv_after_first.traffic_up_gb or 0.0

        # Push same snapshot again (bytes_out did not increase)
        _admin_push(client, auth_headers, test_server, {
            "bytes_out_total": 2_000_000_000,
            "bytes_in_total": 1_000_000_000,
        })
        srv_after_second = _get_server(app, test_server)
        up_after_second = srv_after_second.traffic_up_gb or 0.0

        # No delta should have been added
        assert abs(up_after_second - up_after_first) < 1e-9


# ─────────────────────────────────────────────────────────────────────────────
# 7. 共享层单元测试
# ─────────────────────────────────────────────────────────────────────────────

class TestIngestMetricsDirect:
    """Direct unit tests for services.metrics_ingest.ingest_metrics."""

    def test_strict_raises_on_bad_cpu(self, app, test_server):
        from services.metrics_ingest import ingest_metrics
        from utils.errors import ValidationError as VE

        with app.app_context():
            srv = _db.session.get(Server, test_server)
            with pytest.raises(VE) as exc_info:
                ingest_metrics(srv, {"cpu_use": "bad"}, strict=True, source="test")
            assert exc_info.value.field == "cpu_use"

    def test_strict_raises_on_out_of_range(self, app, test_server):
        from services.metrics_ingest import ingest_metrics
        from utils.errors import ValidationError as VE

        with app.app_context():
            srv = _db.session.get(Server, test_server)
            with pytest.raises(VE) as exc_info:
                ingest_metrics(srv, {"ram_use": -5.0}, strict=True, source="test")
            assert exc_info.value.field == "ram_use"

    def test_lenient_skips_bad_cpu(self, app, test_server):
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            srv = _db.session.get(Server, test_server)
            original_cpu = srv.cpu_use
            result = ingest_metrics(srv, {"cpu_use": "bad"}, strict=False, source="test")
            # cpu_use NOT in applied dict
            assert "cpu_use" not in result
            # server field unchanged
            assert srv.cpu_use == original_cpu
            _db.session.rollback()

    def test_applied_dict_contains_only_written_fields(self, app, test_server):
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            srv = _db.session.get(Server, test_server)
            result = ingest_metrics(srv, {"cpu_use": 55.0, "status": "online"}, strict=True)
            assert "cpu_use" in result
            assert "status" in result
            assert "ram_use" not in result
            _db.session.rollback()

    def test_probe_result_is_added_to_session(self, app, test_server):
        from services.metrics_ingest import ingest_metrics

        with app.app_context():
            before = ProbeResult.query.filter_by(server_id=test_server).count()
            srv = _db.session.get(Server, test_server)
            ingest_metrics(srv, {"cpu_use": 10.0}, strict=False, source="test")
            _db.session.commit()
            after = ProbeResult.query.filter_by(server_id=test_server).count()
            assert after == before + 1
