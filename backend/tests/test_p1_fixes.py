"""
P1 回归测试 — 覆盖审计报告中全部 P1 修复点。

P1-1: /admin/log-level 必须要求 admin 角色（此前仅 @jwt_required()，任何登录用户可改 log level）
P1-2: /health 必须探测 DB 和 Redis 连通性
P1-3: /agent/ack 端点：agent 可确认命令已执行
P1-4: _record_metrics 的输入校验（越界/非法类型值应被静默丢弃）
P1-5: agent push/poll/ack 触发 Prometheus 计数器（冒烟验证）
"""

import hashlib
import hmac
import json
import time
import uuid


# ── helpers ──────────────────────────────────────────────────────────────────

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


# ── P1-1: /admin/log-level 必须要求 admin 角色 ────────────────────────────────

def test_log_level_requires_auth(client):
    """未登录时 /admin/log-level 应返回 401。"""
    resp = client.get("/admin/log-level")
    assert resp.status_code == 401, (
        f"/admin/log-level 应拒绝未认证请求，实际返回 {resp.status_code}"
    )


def test_log_level_requires_admin_role(client):
    """普通用户（role=user）不应能访问 /admin/log-level。"""
    from flask_jwt_extended import create_access_token

    with client.application.app_context():
        non_admin_token = create_access_token(
            identity="9999",
            additional_claims={"role": "user", "username": "regular_user"},
        )
    headers = {"Authorization": f"Bearer {non_admin_token}"}

    get_resp = client.get("/admin/log-level", headers=headers)
    assert get_resp.status_code == 403, (
        f"普通用户 GET /admin/log-level 应返回 403，实际 {get_resp.status_code}"
    )

    post_resp = client.post(
        "/admin/log-level", json={"level": "DEBUG"}, headers=headers
    )
    assert post_resp.status_code == 403, (
        f"普通用户 POST /admin/log-level 应返回 403，实际 {post_resp.status_code}"
    )


def test_log_level_admin_can_read(client, auth_headers):
    """admin 角色可以读取当前 log level。"""
    resp = client.get("/admin/log-level", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert "level" in data


def test_log_level_admin_can_set(client, auth_headers):
    """admin 角色可以修改 log level，并且只接受合法值。"""
    resp = client.post(
        "/admin/log-level", json={"level": "WARNING"}, headers=auth_headers
    )
    assert resp.status_code == 200
    assert resp.get_json().get("level") == "WARNING"

    bad = client.post(
        "/admin/log-level", json={"level": "INVALID"}, headers=auth_headers
    )
    assert bad.status_code == 400

    # 恢复默认 INFO
    client.post("/admin/log-level", json={"level": "INFO"}, headers=auth_headers)


# ── P1-2: /health 必须探测 DB 和 Redis ────────────────────────────────────────

def test_health_checks_dependencies(client):
    """健康检查响应必须包含 db 和 redis 的子状态。"""
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get("status") == "ok"
    checks = data.get("checks", {})
    assert checks.get("db") == "ok", f"DB 健康检查应报告 ok，实际: {checks}"
    assert checks.get("redis") == "ok", f"Redis 健康检查应报告 ok，实际: {checks}"


# ── P1-3: /agent/ack 端点 ─────────────────────────────────────────────────────

def test_agent_ack_marks_commands_executed(client, auth_headers, test_server):
    """agent ack 成功后，指定命令状态应变为 executed。"""
    # 下发一条命令
    enqueue = client.post(
        f"/api/v1/servers/{test_server}/agent-commands",
        headers=auth_headers,
        json={"command_type": "sync", "payload": {}, "ttl_seconds": 300},
    )
    assert enqueue.status_code == 201
    cmd_id = enqueue.get_json()["command"]["id"]

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    # agent 先 poll 确认命令可见
    poll_raw = b""
    poll_headers = _agent_headers(agent_key, poll_raw, agent_uuid, nonce="ack-poll")
    poll_resp = client.get("/api/v1/agent/poll", headers=poll_headers)
    assert poll_resp.status_code == 200
    commands = poll_resp.get_json().get("commands", [])
    assert any(c["id"] == cmd_id for c in commands), "命令应出现在 poll 列表中"

    # agent ack
    ack_body = json.dumps(
        {"uuid": agent_uuid, "command_ids": [cmd_id]},
        separators=(",", ":"),
    ).encode()
    ack_headers = _agent_headers(agent_key, ack_body, agent_uuid, nonce="ack-confirm")
    ack_resp = client.post(
        "/api/v1/agent/ack",
        data=ack_body,
        headers={**ack_headers, "Content-Type": "application/json"},
    )
    assert ack_resp.status_code == 200
    assert ack_resp.get_json()["updated"] == 1

    # poll 后该命令应不再出现
    poll_raw2 = b""
    poll_headers2 = _agent_headers(agent_key, poll_raw2, agent_uuid, nonce="ack-poll2")
    poll_resp2 = client.get("/api/v1/agent/poll", headers=poll_headers2)
    commands2 = poll_resp2.get_json().get("commands", [])
    assert not any(c["id"] == cmd_id for c in commands2), "已 ack 的命令不应再出现在 poll 列表"


def test_agent_ack_requires_valid_auth(client, auth_headers, test_server):
    """未认证请求 /agent/ack 应返回 401。"""
    raw = json.dumps({"command_ids": [1]}, separators=(",", ":")).encode()
    resp = client.post(
        "/api/v1/agent/ack",
        data=raw,
        headers={"Content-Type": "application/json"},
    )
    assert resp.status_code == 401


def test_agent_ack_rejects_too_many_ids(client, auth_headers, test_server):
    """command_ids 超过 50 个应返回 400。"""
    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    big_list = list(range(1, 52))  # 51 items
    body = json.dumps(
        {"uuid": agent_uuid, "command_ids": big_list}, separators=(",", ":")
    ).encode()
    headers = _agent_headers(agent_key, body, agent_uuid, nonce="big-list")
    resp = client.post(
        "/api/v1/agent/ack",
        data=body,
        headers={**headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 400


# ── P1-4: _record_metrics 输入校验 ────────────────────────────────────────────

def test_agent_push_rejects_out_of_range_metrics(client, auth_headers, test_server):
    """越界指标（cpu_use=150, ram_use=-5）应被静默丢弃，不写入数据库。"""
    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    payload = {
        "uuid": agent_uuid,
        "cpu_use": 150.0,   # 越界 (>100)
        "ram_use": -5.0,    # 越界 (<0)
        "disk_use": 50.0,   # 合法
        "status": "online",
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="bad-range")
    resp = client.post(
        "/api/v1/agent/push",
        data=raw,
        headers={**headers, "Content-Type": "application/json"},
    )
    # push 本身应成功（202），但非法值不写入
    assert resp.status_code == 202

    # 从 DB 确认 cpu_use 和 ram_use 未被更新为越界值
    from extensions import db as _db
    from models.models import Server

    with client.application.app_context():
        server = _db.session.get(Server, test_server)
        assert server.cpu_use != 150.0, "越界 cpu_use 不应写入数据库"
        assert server.ram_use != -5.0, "越界 ram_use 不应写入数据库"


def test_agent_push_rejects_non_numeric_metrics(client, auth_headers, test_server):
    """非数值指标应被静默丢弃，push 仍应返回 202。"""
    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    payload = {
        "uuid": agent_uuid,
        "cpu_use": "not-a-number",
        "ram_use": None,
        "disk_use": 30.0,
        "status": "online",
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="bad-type")
    resp = client.post(
        "/api/v1/agent/push",
        data=raw,
        headers={**headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 202


# ── P1-5: Prometheus 计数器冒烟测试 ──────────────────────────────────────────

def _get_metric_value(client, metric_name: str) -> float:
    """从 /metrics 端点解析指定指标的总值（复用 test_metrics.py 的方式）。"""
    resp = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"})
    if resp.status_code != 200:
        return 0.0
    total = 0.0
    for line in resp.data.decode().splitlines():
        if line.startswith("#"):
            continue
        if line.startswith(metric_name):
            try:
                total += float(line.rsplit(" ", 1)[-1])
            except ValueError:
                pass
    return total


def test_agent_push_increments_metric(client, auth_headers, test_server):
    """agent push 成功后 vps_agent_push_total 计数器应递增。"""
    before = _get_metric_value(client, "vps_agent_push_total")

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
    payload = {"uuid": agent_uuid, "cpu_use": 10.0, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="metric-push")
    resp = client.post(
        "/api/v1/agent/push",
        data=raw,
        headers={**headers, "Content-Type": "application/json"},
    )
    assert resp.status_code == 202

    after = _get_metric_value(client, "vps_agent_push_total")
    assert after > before, "vps_agent_push_total 应在 push 成功后递增"


def test_metrics_endpoint_exposes_agent_counters(client, auth_headers, test_server):
    """Prometheus /metrics 端点应暴露 agent 相关计数器名称。"""
    from middleware.metrics_middleware import record_agent_push, record_agent_poll, record_agent_ack

    record_agent_push("accepted")
    record_agent_poll("ok")
    record_agent_ack("ok")

    body = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"}).data.decode()
    assert "vps_agent_push_total" in body, "缺少 vps_agent_push_total 指标"
    assert "vps_agent_poll_total" in body, "缺少 vps_agent_poll_total 指标"
    assert "vps_agent_ack_total" in body, "缺少 vps_agent_ack_total 指标"
