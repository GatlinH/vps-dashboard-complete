"""
P2 回归测试 — 覆盖审计报告中全部 P2 修复点。

P2-1: Scheduler job Prometheus 计数器（vps_scheduler_job_total）
P2-2: Agent push/poll/ack 结构化日志（server_id/uuid extra 字段不抛出异常）
P2-3: ProbeResult 保留天数可通过 PROBE_RESULT_RETENTION_DAYS 配置
P2-4: 过期 AgentCommand 定期清理（_job_agent_command_cleanup）
P2-5: 告警计数器 record_alert_fired 已挂载到 scheduler._send_alert
"""
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone, timedelta


# ── helpers ───────────────────────────────────────────────────────────────────


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


def _provision_agent(client, auth_headers, test_server):
    """注册 agent 并返回 (agent_key, agent_uuid)."""
    key_resp = client.post(
        f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers
    )
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    claim = client.post(
        "/api/v1/agent/claim",
        json={"server_id": test_server, "uuid": agent_uuid},
        headers=auth_headers,
    )
    assert claim.status_code == 200
    return agent_key, agent_uuid


def _get_metric_lines(client, prefix: str):
    """从 /metrics 端点获取以指定前缀开头的所有行。"""
    resp = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    lines = [
        line for line in resp.data.decode().splitlines()
        if line.startswith(prefix) and not line.startswith("#")
    ]
    return lines


# ── P2-1: Scheduler job Prometheus 计数器 ─────────────────────────────────────


def test_scheduler_job_counter_exposed(client):
    """vps_scheduler_job_total 计数器应在 /metrics 端点可见。"""
    from middleware.metrics_middleware import record_scheduler_job

    record_scheduler_job("tcp_ping", "ok")
    record_scheduler_job("fetch_probes", "error")

    body = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"}).data.decode()
    assert "vps_scheduler_job_total" in body, (
        "/metrics 端点缺少 vps_scheduler_job_total 指标"
    )


def test_scheduler_job_counter_increments(client):
    """每次调用 record_scheduler_job 后计数器值应递增。"""
    from middleware.metrics_middleware import record_scheduler_job

    before = sum(
        float(line.rsplit(" ", 1)[-1])
        for line in _get_metric_lines(client, "vps_scheduler_job_total")
    )
    record_scheduler_job("test_job", "ok")
    after = sum(
        float(line.rsplit(" ", 1)[-1])
        for line in _get_metric_lines(client, "vps_scheduler_job_total")
    )
    assert after > before, "record_scheduler_job 调用后 vps_scheduler_job_total 应递增"


def test_scheduler_job_counter_all_status_values(client):
    """record_scheduler_job 支持 ok/error/missed 三种状态值。"""
    from middleware.metrics_middleware import record_scheduler_job

    # 不应抛出异常
    record_scheduler_job("cleanup", "ok")
    record_scheduler_job("cleanup", "error")
    record_scheduler_job("cleanup", "missed")


# ── P2-2: Agent 结构化日志 ────────────────────────────────────────────────────


def test_agent_push_structured_logging_does_not_raise(client, auth_headers, test_server, caplog):
    """agent push 路径应能以结构化方式记录日志，不抛出 TypeError/KeyError。"""
    import logging

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
    payload = {
        "uuid": agent_uuid,
        "cpu_use": 20.0,
        "ram_use": 30.0,
        "status": "online",
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="log-push")

    with caplog.at_level(logging.INFO, logger="api.agent"):
        resp = client.post(
            "/api/v1/agent/push",
            data=raw,
            headers={**headers, "Content-Type": "application/json"},
        )
    assert resp.status_code == 202, f"push 应返回 202，实际 {resp.status_code}"


def test_agent_poll_structured_logging_does_not_raise(client, auth_headers, test_server, caplog):
    """agent poll 路径应能以结构化方式记录日志，不抛出 TypeError/KeyError。"""
    import logging

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
    raw = b""
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="log-poll")

    with caplog.at_level(logging.INFO, logger="api.agent"):
        resp = client.get("/api/v1/agent/poll", headers=headers)
    assert resp.status_code == 200


def test_agent_ack_structured_logging_does_not_raise(client, auth_headers, test_server, caplog):
    """agent ack 路径应能以结构化方式记录日志，不抛出 TypeError/KeyError。"""
    import logging

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
    body = json.dumps(
        {"uuid": agent_uuid, "command_ids": []}, separators=(",", ":")
    ).encode()
    headers = _agent_headers(agent_key, body, agent_uuid, nonce="log-ack")

    with caplog.at_level(logging.INFO, logger="api.agent"):
        resp = client.post(
            "/api/v1/agent/ack",
            data=body,
            headers={**headers, "Content-Type": "application/json"},
        )
    assert resp.status_code == 200


# ── P2-3: ProbeResult 保留天数可配置 ──────────────────────────────────────────


def test_probe_result_retention_days_config_default(client):
    """默认 PROBE_RESULT_RETENTION_DAYS 应为 30。"""
    assert client.application.config.get("PROBE_RESULT_RETENTION_DAYS") == 30, (
        "默认保留天数应为 30"
    )


def test_probe_result_cleanup_respects_retention_days(client, test_server):
    """_job_cleanup 应只删除超过 PROBE_RESULT_RETENTION_DAYS 天的记录。"""
    from extensions import db as _db
    from models.models import ProbeResult
    from services.scheduler import _job_cleanup

    app = client.application

    with app.app_context():
        old_cutoff = datetime.now(timezone.utc) - timedelta(days=31)
        recent_cutoff = datetime.now(timezone.utc) - timedelta(days=1)

        old_probe = ProbeResult(
            server_id=test_server,
            cpu_use=10.0,
            status="online",
            created_at=old_cutoff,
        )
        recent_probe = ProbeResult(
            server_id=test_server,
            cpu_use=20.0,
            status="online",
            created_at=recent_cutoff,
        )
        _db.session.add_all([old_probe, recent_probe])
        _db.session.commit()
        old_id = old_probe.id
        recent_id = recent_probe.id

    # 使用 30 天保留（默认值）
    app.config["PROBE_RESULT_RETENTION_DAYS"] = 30
    _job_cleanup(app)

    with app.app_context():
        assert _db.session.get(ProbeResult, old_id) is None, (
            "31 天前的 ProbeResult 应已被清理"
        )
        assert _db.session.get(ProbeResult, recent_id) is not None, (
            "1 天前的 ProbeResult 不应被清理"
        )
        # 清理测试数据
        r = _db.session.get(ProbeResult, recent_id)
        if r:
            _db.session.delete(r)
            _db.session.commit()


def test_probe_result_cleanup_custom_retention(client, test_server):
    """_job_cleanup 使用自定义保留天数（60 天）时不删除 31 天前的记录。"""
    from extensions import db as _db
    from models.models import ProbeResult
    from services.scheduler import _job_cleanup

    app = client.application

    with app.app_context():
        probe = ProbeResult(
            server_id=test_server,
            cpu_use=50.0,
            status="online",
            created_at=datetime.now(timezone.utc) - timedelta(days=31),
        )
        _db.session.add(probe)
        _db.session.commit()
        probe_id = probe.id

    # 60 天保留 → 31 天前的记录不应被删除
    app.config["PROBE_RESULT_RETENTION_DAYS"] = 60
    _job_cleanup(app)

    with app.app_context():
        assert _db.session.get(ProbeResult, probe_id) is not None, (
            "使用 60 天保留时，31 天前的记录不应被删除"
        )
        # 清理
        r = _db.session.get(ProbeResult, probe_id)
        if r:
            _db.session.delete(r)
            _db.session.commit()

    # 恢复默认
    app.config["PROBE_RESULT_RETENTION_DAYS"] = 30


# ── P2-4: AgentCommand 过期清理 ───────────────────────────────────────────────


def test_agent_command_cleanup_deletes_old_records(client, auth_headers, test_server):
    """_job_agent_command_cleanup 应删除超过保留天数的 AgentCommand 记录。"""
    from extensions import db as _db
    from models.models import AgentCommand
    from services.scheduler import _job_agent_command_cleanup

    app = client.application

    with app.app_context():
        old_cmd = AgentCommand(
            server_id=test_server,
            command_type="sync",
            payload={},
            status="executed",
            created_at=datetime.now(timezone.utc) - timedelta(days=10),
        )
        _db.session.add(old_cmd)
        _db.session.commit()
        old_id = old_cmd.id

    app.config["AGENT_COMMAND_RETENTION_DAYS"] = 7
    _job_agent_command_cleanup(app)

    with app.app_context():
        assert _db.session.get(AgentCommand, old_id) is None, (
            "10 天前的 AgentCommand（retention=7）应被清理"
        )


def test_agent_command_cleanup_preserves_recent_records(client, auth_headers, test_server):
    """_job_agent_command_cleanup 不应删除保留天数内的命令。"""
    from extensions import db as _db
    from models.models import AgentCommand
    from services.scheduler import _job_agent_command_cleanup

    app = client.application

    with app.app_context():
        recent_cmd = AgentCommand(
            server_id=test_server,
            command_type="sync",
            payload={},
            status="pending",
            created_at=datetime.now(timezone.utc) - timedelta(days=3),
        )
        _db.session.add(recent_cmd)
        _db.session.commit()
        recent_id = recent_cmd.id

    app.config["AGENT_COMMAND_RETENTION_DAYS"] = 7
    _job_agent_command_cleanup(app)

    with app.app_context():
        assert _db.session.get(AgentCommand, recent_id) is not None, (
            "3 天前的 AgentCommand（retention=7）不应被清理"
        )
        cmd = _db.session.get(AgentCommand, recent_id)
        if cmd:
            _db.session.delete(cmd)
            _db.session.commit()


def test_agent_command_retention_days_config_default(client):
    """默认 AGENT_COMMAND_RETENTION_DAYS 应为 7。"""
    assert client.application.config.get("AGENT_COMMAND_RETENTION_DAYS") == 7


# ── P2-5: record_alert_fired 已挂载到 scheduler._send_alert ──────────────────


def test_record_alert_fired_in_send_alert(client):
    """_send_alert 应调用 record_alert_fired，vps_alerts_fired_total 应可见。"""
    from middleware.metrics_middleware import record_alert_fired

    # 直接调用 record_alert_fired（scheduler._send_alert 内部会调用它）
    record_alert_fired("cpu", "telegram")
    record_alert_fired("offline", "telegram")

    body = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"}).data.decode()
    assert "vps_alerts_fired_total" in body, (
        "/metrics 端点缺少 vps_alerts_fired_total 指标"
    )


def test_send_alert_calls_record_alert_fired(monkeypatch):
    """_send_alert 应在发送 Telegram 消息后调用 record_alert_fired。"""
    import services.scheduler as sched_module

    fired_calls = []

    def _mock_send_message(msg):
        pass

    def _mock_full_msg(prefix, body):
        return body

    def _mock_record_alert_fired(rule_type, channel):
        fired_calls.append((rule_type, channel))

    monkeypatch.setattr(sched_module, "record_alert_fired", _mock_record_alert_fired)

    # 构造最小 cfg/server 对象
    class FakeCfg:
        prefix = "【TEST】"

    class FakeServer:
        name = "test-server"
        location = "US"
        ip = "1.2.3.4"
        expiry = None

    import sys
    import types

    fake_api_telegram = types.ModuleType("api.telegram")
    fake_api_telegram.send_message = _mock_send_message
    fake_api_telegram._full_msg = _mock_full_msg
    monkeypatch.setitem(sys.modules, "api.telegram", fake_api_telegram)

    sched_module._send_alert(FakeCfg(), FakeServer(), "cpu", 95.0, 90.0)

    assert len(fired_calls) == 1, "_send_alert 应调用 record_alert_fired 一次"
    assert fired_calls[0] == ("cpu", "telegram")
