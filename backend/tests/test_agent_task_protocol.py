def test_agent_task_protocol_accepts_only_declared_task_with_schema_and_ttl(client, auth_headers, test_server):
    response = client.post(f"/api/v1/servers/{test_server}/agent-commands", headers=auth_headers, json={"kind": "collect_inventory", "params": {}, "ttl_seconds": 120})
    assert response.status_code == 201
    task = response.get_json()["task"]
    assert task["schema_version"] == 1
    assert task["kind"] == "collect_inventory"
    assert task["params"] == {}
    assert task["expires_at"]


def test_agent_task_protocol_rejects_arbitrary_execution_payload(client, auth_headers, test_server):
    response = client.post(f"/api/v1/servers/{test_server}/agent-commands", headers=auth_headers, json={"kind": "exec", "params": {"command": "whoami"}, "ttl_seconds": 120})
    assert response.status_code == 400
    assert "kind" in response.get_json()["message"]


def test_agent_task_protocol_rejects_probe_host_injection(client, auth_headers, test_server):
    response = client.post(f"/api/v1/servers/{test_server}/agent-commands", headers=auth_headers, json={"kind": "run_peer_probe", "params": {"host": "127.0.0.1; rm -rf /"}, "ttl_seconds": 120})
    assert response.status_code == 400
    assert "params" in response.get_json()["message"]


def test_agent_task_protocol_requires_ttl(client, auth_headers, test_server):
    response = client.post(f"/api/v1/servers/{test_server}/agent-commands", headers=auth_headers, json={"kind": "reload_agent_config", "params": {}})
    assert response.status_code == 400
    assert "ttl_seconds" in response.get_json()["message"]


def test_agent_poll_returns_versioned_task_not_legacy_command_shape(client, auth_headers, test_server):
    import hashlib, hmac, json, time, uuid
    key = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers).get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    assert client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers).status_code == 200
    assert client.post(f"/api/v1/servers/{test_server}/agent-commands", headers=auth_headers, json={"kind": "reload_agent_config", "params": {}, "ttl_seconds": 120}).status_code == 201
    ts, nonce = str(int(time.time())), "task-poll"
    raw = b""
    signature = hmac.new(key.encode(), f"{ts}.{nonce}.".encode()+raw, hashlib.sha256).hexdigest()
    response = client.get("/api/v1/agent/poll", headers={"X-Agent-UUID": agent_uuid, "X-Agent-Key": key, "X-Agent-Timestamp": ts, "X-Agent-Nonce": nonce, "X-Agent-Signature": signature})
    assert response.status_code == 200
    task = response.get_json()["tasks"][0]
    assert task["schema_version"] == 1
    assert task["kind"] == "reload_agent_config"
    assert "command_type" not in task
