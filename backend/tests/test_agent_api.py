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


def test_agent_key_and_config_endpoints(client, auth_headers, test_server):
    gen = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    assert gen.status_code == 200
    assert gen.get_json().get("agent_key")

    cfg = client.put(
        f"/api/v1/servers/{test_server}/agent-config",
        json={"disable_nat": True, "ip_report_period": 60},
        headers=auth_headers,
    )
    assert cfg.status_code == 200
    assert cfg.get_json()["agent_config"]["disable_nat"] is True


def test_agent_claim_push_poll(client, auth_headers, test_server):
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())

    claim = client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid})
    assert claim.status_code == 200

    payload = {"uuid": agent_uuid, "cpu_use": 12.3, "ram_use": 45.6, "status": "online"}
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    headers = _agent_headers(agent_key, raw, agent_uuid, nonce="nonce-a")
    push = client.post("/api/v1/agent/push", data=raw, headers={**headers, "Content-Type": "application/json"})
    assert push.status_code == 202

    poll_raw = b""
    poll_headers = _agent_headers(agent_key, poll_raw, agent_uuid, nonce="nonce-b")
    poll = client.get("/api/v1/agent/poll", headers=poll_headers)
    assert poll.status_code == 200
    data = poll.get_json()
    assert "commands" in data
