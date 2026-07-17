import ast
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


def test_install_script_embeds_defined_startup_constants(client):
    response = client.get("/api/v1/agent/install.sh")

    assert response.status_code == 200
    embedded_agent = response.get_data(as_text=True).split("<<'PY2'\n", 1)[1].split("\nPY2", 1)[0]
    module = ast.parse(embedded_agent)
    assignments = {
        target.id
        for node in module.body
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }
    references = {
        node.id
        for node in ast.walk(module)
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load)
    }
    startup_constants = {"API_ROOT", "AGENT_UUID", "AGENT_KEY", "SERVER_ID", "INTERVAL", "PROBE_INTERVAL", "STATE_PATH"}

    assert references & startup_constants <= assignments


def test_agent_claim_push_poll(client, auth_headers, test_server):
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())

    claim = client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers)
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
    assert "tasks" in data


def test_agent_overview_and_command_enqueue(client, auth_headers, test_server):
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    assert key_resp.status_code == 200

    overview = client.get(f"/api/v1/servers/{test_server}/agent-overview", headers=auth_headers)
    assert overview.status_code == 200
    overview_data = overview.get_json()
    assert overview_data["server_id"] == test_server
    assert "agent_key_created_at" in overview_data
    assert "pending_commands" in overview_data

    enqueue = client.post(
        f"/api/v1/servers/{test_server}/agent-commands",
        headers=auth_headers,
        json={"kind": "collect_inventory", "params": {}, "ttl_seconds": 120},
    )
    assert enqueue.status_code == 201
    body = enqueue.get_json()
    assert body["ok"] is True
    assert body["task"]["kind"] == "collect_inventory"
    assert body["task"]["schema_version"] == 1
