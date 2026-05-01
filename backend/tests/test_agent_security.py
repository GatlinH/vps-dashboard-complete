import hashlib
import hmac
import json
import time
import uuid


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
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    claim = client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers)
    assert claim.status_code == 200
    return agent_key, agent_uuid


# ── P0 回归：/claim 必须要求管理员身份验证 ───────────────────────────────────

def test_claim_requires_admin_auth(client, test_server):
    """P0 回归：未携带 JWT 时，/claim 必须返回 401，防止 UUID 劫持。"""
    resp = client.post(
        "/api/v1/agent/claim",
        json={"server_id": test_server, "uuid": str(uuid.uuid4())},
    )
    assert resp.status_code == 401, (
        f"/claim 应拒绝未认证请求，实际返回 {resp.status_code}"
    )


def test_claim_requires_admin_role(client, test_server):
    """P0 回归：普通用户 JWT 不应能调用 /claim（仅 admin 角色）。"""
    from flask_jwt_extended import create_access_token
    # 生成一个 role=user 的 token（与 auth.py 中格式一致）
    with client.application.app_context():
        non_admin_token = create_access_token(
            identity="9999",
            additional_claims={"role": "user", "username": "regular_user"},
        )
    headers = {"Authorization": f"Bearer {non_admin_token}"}
    resp = client.post(
        "/api/v1/agent/claim",
        json={"server_id": test_server, "uuid": str(uuid.uuid4())},
        headers=headers,
    )
    assert resp.status_code == 403, (
        f"/claim 应拒绝非管理员角色，实际返回 {resp.status_code}"
    )


# ── 已有安全测试 ─────────────────────────────────────────────────────────────

def test_nonce_replay_is_rejected(client, auth_headers, test_server):
    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    payload = {"uuid": agent_uuid, "cpu_use": 12.3, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="same-nonce")

    first = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert first.status_code == 202

    second = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert second.status_code == 401
    assert "replayed request" in (second.get_json() or {}).get("message", "")


def test_agent_push_rate_limit_per_agent(client, app, auth_headers, test_server):
    app.config["RATELIMIT_ENABLED"] = True
    app.config["AGENT_PUSH_RATE_LIMIT"] = "2 per minute"

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    for i in range(2):
        payload = {"uuid": agent_uuid, "cpu_use": 10 + i, "status": "online"}
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = _agent_headers(agent_key, raw, agent_uuid, nonce=f"nonce-{i}")
        resp = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
        assert resp.status_code == 202

    payload = {"uuid": agent_uuid, "cpu_use": 99, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="nonce-over")
    blocked = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert blocked.status_code == 429


def test_agent_push_rate_limit_takes_effect_immediately_after_enable(client, app, auth_headers, test_server):
    app.config["RATELIMIT_ENABLED"] = True
    app.config["AGENT_PUSH_RATE_LIMIT"] = "1 per minute"

    # 模拟前序测试将 limiter 状态留在 disabled。
    app.limiter.enabled = False

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    payload = {"uuid": agent_uuid, "cpu_use": 30, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="enable-now-0")
    first = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert first.status_code == 202

    payload = {"uuid": agent_uuid, "cpu_use": 31, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="enable-now-1")
    blocked = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert blocked.status_code == 429
    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    payload = {"uuid": agent_uuid, "cpu_use": 12.3, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="same-nonce")

    first = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert first.status_code == 202

    second = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert second.status_code == 401
    assert "replayed request" in (second.get_json() or {}).get("message", "")


def test_agent_push_rate_limit_per_agent(client, app, auth_headers, test_server):
    app.config["RATELIMIT_ENABLED"] = True
    app.config["AGENT_PUSH_RATE_LIMIT"] = "2 per minute"

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    for i in range(2):
        payload = {"uuid": agent_uuid, "cpu_use": 10 + i, "status": "online"}
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        headers = _agent_headers(agent_key, raw, agent_uuid, nonce=f"nonce-{i}")
        resp = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
        assert resp.status_code == 202

    payload = {"uuid": agent_uuid, "cpu_use": 99, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="nonce-over")
    blocked = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert blocked.status_code == 429


def test_agent_push_rate_limit_takes_effect_immediately_after_enable(client, app, auth_headers, test_server):
    app.config["RATELIMIT_ENABLED"] = True
    app.config["AGENT_PUSH_RATE_LIMIT"] = "1 per minute"

    # 模拟前序测试将 limiter 状态留在 disabled。
    app.limiter.enabled = False

    agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

    payload = {"uuid": agent_uuid, "cpu_use": 30, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="enable-now-0")
    first = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert first.status_code == 202

    payload = {"uuid": agent_uuid, "cpu_use": 31, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="enable-now-1")
    blocked = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert blocked.status_code == 429
