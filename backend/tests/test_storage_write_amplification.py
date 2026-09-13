"""Stable inventory must not turn telemetry heartbeats into config writes."""
import hashlib
import hmac
import json
import time
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from sqlalchemy import event


T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
T1 = datetime(2026, 1, 2, tzinfo=timezone.utc)
NETWORK = {"local_ipv4": "10.0.0.8", "public_ipv4": "198.51.100.8",
           "public_ipv6": "2001:db8::8", "local_ipv6": [" 2001:db8::1 ", "", "2001:db8::2"]}


@pytest.fixture
def inventory_clock(monkeypatch):
    import api.agent as agent

    clock = [T0]
    monkeypatch.setattr(agent, "_utc_now", lambda: clock[0])
    monkeypatch.setattr(agent, "_geo_lookup_by_ip", lambda ip: {
        "country": "CN", "city": "Shanghai", "query": ip,
    } if ip == "198.51.100.8" else {})
    return clock


@pytest.fixture
def server_updates(app):
    from extensions import db

    updates = []

    def observe(_conn, _cursor, statement, _params, _context, _many):
        if statement.lstrip().upper().startswith("UPDATE SERVERS "):
            updates.append(statement)

    with app.app_context():
        event.listen(db.engine, "before_cursor_execute", observe)
        try:
            yield updates
        finally:
            event.remove(db.engine, "before_cursor_execute", observe)


def config_updates(updates):
    return [sql for sql in updates if "agent_config=" in sql.lower()]


def test_stable_inventory_real_sql_and_changes(app, test_server, inventory_clock, server_updates):
    from api.agent import _apply_agent_inventory
    from extensions import db
    from models.models import Server

    payload = {"network": NETWORK, "hardware": {"cpu_cores": 6, "ram_gb": 12, "disk_gb": 200}}
    with app.app_context():
        server = db.session.get(Server, test_server)
        _apply_agent_inventory(server, payload)
        db.session.commit()
        assert server.agent_config["network"]["updated_at"] == T0.isoformat()
        assert server.agent_config["network"] == server.agent_config["inventory_meta"]["network"]
        assert server.ip == "198.51.100.8"
        server_updates.clear()
        inventory_clock[0] = T1
        _apply_agent_inventory(server, payload)
        db.session.commit()
        assert not config_updates(server_updates), server_updates
        assert server.agent_config["network"]["updated_at"] == T0.isoformat()

        for change in ({"network": {**NETWORK, "public_ipv4": "198.51.100.9"}},
                       {"network": {**NETWORK, "public_ipv6": "2001:db8::9"}}):
            server_updates.clear()
            _apply_agent_inventory(server, change)
            db.session.commit()
            assert config_updates(server_updates), change
            assert server.agent_config["network"]["updated_at"] == T1.isoformat()
            assert server.agent_config["network"] == server.agent_config["inventory_meta"]["network"]
            server_updates.clear()
            _apply_agent_inventory(server, change)
            db.session.commit()
            assert not config_updates(server_updates), server_updates

        t2 = datetime(2026, 1, 3, tzinfo=timezone.utc)
        inventory_clock[0] = t2
        server_updates.clear()
        current_network = dict(server.agent_config["network"])
        _apply_agent_inventory(server, {"network": current_network, "hardware": {"cpu_model": "new CPU"}})
        db.session.commit()
        assert config_updates(server_updates)
        assert server.agent_config["inventory_meta"]["cpu_model"] == "new CPU"
        assert server.agent_config["network"]["updated_at"] == T1.isoformat()
        assert server.agent_config["network"] == server.agent_config["inventory_meta"]["network"]


@pytest.mark.parametrize("old,expected", [
    ("legacy timestamp exactly", "legacy timestamp exactly"),
    (None, T1.isoformat()), ("", T1.isoformat()), (123, T1.isoformat()),
])
def test_legacy_timestamp_and_mirror(app, test_server, inventory_clock, server_updates, old, expected):
    from api.agent import _apply_agent_inventory
    from extensions import db
    from models.models import Server

    with app.app_context():
        server = db.session.get(Server, test_server)
        network = {"public_ipv4": "198.51.100.8", "unknown": {"keep": True}}
        if old is not None:
            network["updated_at"] = old
        server.agent_config = {"network": network, "inventory_meta": {"network": {"stale": True}}}
        db.session.commit()
        inventory_clock[0] = T1
        _apply_agent_inventory(server, {"network": {"public_ipv4": " 198.51.100.8 "}})
        db.session.commit()
        merged = server.agent_config["network"]
        assert merged["updated_at"] == expected
        assert merged["unknown"] == {"keep": True}
        assert merged == server.agent_config["inventory_meta"]["network"]
        server_updates.clear()
        _apply_agent_inventory(server, {"network": {"public_ipv4": "198.51.100.8"}})
        db.session.commit()
        assert not config_updates(server_updates)


@pytest.mark.parametrize("report", [None, {}, "invalid"])
def test_absent_network_keeps_both_existing_shapes(app, test_server, inventory_clock, report):
    from api.agent import _apply_agent_inventory
    from extensions import db
    from models.models import Server

    with app.app_context():
        server = db.session.get(Server, test_server)
        server.agent_config = {"inventory_meta": {"network": {"legacy": 1}}}
        db.session.commit()
        _apply_agent_inventory(server, {"network": report})
        db.session.commit()
        assert "network" not in server.agent_config
        assert server.agent_config["inventory_meta"]["network"] == {"legacy": 1}


@pytest.mark.parametrize("entry", ["consumer", "push"])
def test_repeated_entries_preserve_raw_probe_samples(
    app, client, auth_headers, test_server, monkeypatch, inventory_clock, server_updates, entry
):
    import extensions
    from extensions import db
    from models.models import ProbeResult, Server
    from workers.agent_consumer import _handle_message

    samples = [{"cpu_use": 21.5, "ram_use": 31.5, "disk_use": 41.5, "process_count": 3,
                "net_up": 51.5, "net_down": 61.5, "latency_ms": 7.5,
                "network": NETWORK},
               {"cpu_use": 22.5, "ram_use": 32.5, "disk_use": 42.5, "process_count": 5,
                "net_up": 52.5, "net_down": 62.5, "latency_ms": 8.5,
                "network": NETWORK}]
    if entry == "push":
        key = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers).get_json()["agent_key"]
        agent_uuid = str(uuid.uuid4())
        assert client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers).status_code == 200

        class SyncRedis:
            def set(self, *args, **kwargs):
                return extensions_fake.set(*args, **kwargs)

        extensions_fake = extensions.redis_client
        monkeypatch.setattr(extensions, "redis_client", SyncRedis())

    wall_before = []
    wall_after = []
    network_timestamps = []
    with app.app_context():
        for index, sample in enumerate(samples):
            inventory_clock[0] = datetime.now(timezone.utc) if entry == "push" else [T0, T1][index]
            if index:
                server_updates.clear()
            wall_before.append(datetime.now(timezone.utc))
            if entry == "consumer":
                _handle_message(json.dumps({"server_id": test_server, "metrics": sample}))
            else:
                raw = json.dumps({"uuid": agent_uuid, **sample}).encode()
                ts, nonce = str(int(time.time())), uuid.uuid4().hex
                signature = hmac.new(key.encode(), f"{ts}.{nonce}.".encode() + raw, hashlib.sha256).hexdigest()
                response = client.post("/api/v1/agent/push", data=raw, headers={
                    "X-Agent-UUID": agent_uuid, "X-Agent-Key": key, "X-Agent-Timestamp": ts,
                    "X-Agent-Nonce": nonce, "X-Agent-Signature": signature,
                    "Content-Type": "application/json",
                })
                assert response.status_code == 202, response.get_json()
            wall_after.append(datetime.now(timezone.utc))
            server = db.session.get(Server, test_server)
            network_timestamps.append(server.agent_config["network"]["updated_at"])
            if index:
                assert not config_updates(server_updates), server_updates
        rows = ProbeResult.query.filter_by(server_id=test_server).order_by(ProbeResult.id).all()
        assert len(rows) == 2
        for row, sample in zip(rows, samples):
            for field in ("cpu_use", "ram_use", "disk_use", "process_count", "net_up", "net_down", "latency_ms"):
                assert getattr(row, field) == sample[field]
            assert row.created_at is not None
            created = row.created_at.replace(tzinfo=timezone.utc) if row.created_at.tzinfo is None else row.created_at
            assert wall_before[rows.index(row)] <= created <= wall_after[rows.index(row)]
        assert rows[0].created_at <= rows[1].created_at
        server = db.session.get(Server, test_server)
        if entry == "consumer":
            assert network_timestamps == [T0.isoformat(), T0.isoformat()]
        else:
            assert network_timestamps[0]
            assert network_timestamps[0] == network_timestamps[1]
            assert network_timestamps[0] == server.agent_config["inventory_meta"]["network"]["updated_at"]


def test_push_inventory_failure_rolls_back_real_writes_then_retries(
    app, client, auth_headers, test_server, monkeypatch, inventory_clock
):
    import api.agent as agent
    import extensions
    from extensions import db
    from models.models import ProbeResult, Server

    key = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers).get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    assert client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers).status_code == 200
    extensions_fake = extensions.redis_client
    class SyncRedis:
        def set(self, *args, **kwargs):
            return extensions_fake.set(*args, **kwargs)
    monkeypatch.setattr(extensions, "redis_client", SyncRedis())
    with app.app_context():
        server = db.session.get(Server, test_server)
        old_config = json.loads(json.dumps(server.agent_config))
        old_count = ProbeResult.query.filter_by(server_id=test_server).count()
    original_commit = db.session.commit
    original_rollback = db.session.rollback
    failed = [False]
    sql_observations = []

    def observe_sql(_conn, _cursor, statement, _params, _context, _many):
        upper = statement.lstrip().upper()
        if upper.startswith("INSERT INTO PROBE_RESULTS") or (upper.startswith("UPDATE SERVERS") and "AGENT_CONFIG" in upper):
            sql_observations.append(statement)

    event.listen(db.engine, "before_cursor_execute", observe_sql)

    def fail_once_commit():
        if not failed[0]:
            failed[0] = True
            db.session.flush()
            raise RuntimeError("injected post-flush commit failure")
        return original_commit()

    rollbacks = []

    def observed_rollback():
        rollbacks.append(True)
        return original_rollback()

    monkeypatch.setattr(db.session, "commit", fail_once_commit)
    monkeypatch.setattr(db.session, "rollback", observed_rollback)
    sample = {"cpu_use": 11, "ram_use": 22, "disk_use": 33, "process_count": 7, "network": NETWORK}
    inventory_clock[0] = datetime.now(timezone.utc)
    raw = json.dumps({"uuid": agent_uuid, **sample}).encode()
    ts, nonce = str(int(time.time())), uuid.uuid4().hex
    signature = hmac.new(key.encode(), f"{ts}.{nonce}.".encode() + raw, hashlib.sha256).hexdigest()
    response = client.post("/api/v1/agent/push", data=raw, headers={"X-Agent-UUID": agent_uuid, "X-Agent-Key": key, "X-Agent-Timestamp": ts, "X-Agent-Nonce": nonce, "X-Agent-Signature": signature, "Content-Type": "application/json"})
    assert response.status_code >= 500
    assert rollbacks
    assert failed[0]
    assert any("INSERT INTO PROBE_RESULTS" in sql.upper() for sql in sql_observations)
    assert any("UPDATE SERVERS" in sql.upper() and "AGENT_CONFIG" in sql.upper() for sql in sql_observations)
    event.remove(db.engine, "before_cursor_execute", observe_sql)
    with app.app_context():
        db.session.expire_all()
        server = db.session.get(Server, test_server)
        assert server.agent_config == old_config
        assert ProbeResult.query.filter_by(server_id=test_server).count() == old_count
    monkeypatch.setattr(db.session, "commit", original_commit)
    monkeypatch.setattr(db.session, "rollback", original_rollback)
    ts2, nonce2 = str(int(time.time())), uuid.uuid4().hex
    signature2 = hmac.new(key.encode(), f"{ts2}.{nonce2}.".encode() + raw, hashlib.sha256).hexdigest()
    response = client.post("/api/v1/agent/push", data=raw, headers={"X-Agent-UUID": agent_uuid, "X-Agent-Key": key, "X-Agent-Timestamp": ts2, "X-Agent-Nonce": nonce2, "X-Agent-Signature": signature2, "Content-Type": "application/json"})
    assert response.status_code == 202
    with app.app_context():
        server = db.session.get(Server, test_server)
        assert server.agent_config["network"]["updated_at"] == server.agent_config["inventory_meta"]["network"]["updated_at"]
        assert ProbeResult.query.filter_by(server_id=test_server).count() == old_count + 1
        retry_timestamp = server.agent_config["network"]["updated_at"]
        server_updates = []
        def observe(_conn, _cursor, statement, _params, _context, _many):
            if statement.lstrip().upper().startswith("UPDATE SERVERS "):
                server_updates.append(statement)
        event.listen(db.engine, "before_cursor_execute", observe)
        try:
            inventory_clock[0] = inventory_clock[0] + timedelta(seconds=1)
            ts3, nonce3 = str(int(time.time())), uuid.uuid4().hex
            signature3 = hmac.new(key.encode(), f"{ts3}.{nonce3}.".encode() + raw, hashlib.sha256).hexdigest()
            response = client.post("/api/v1/agent/push", data=raw, headers={"X-Agent-UUID": agent_uuid, "X-Agent-Key": key, "X-Agent-Timestamp": ts3, "X-Agent-Nonce": nonce3, "X-Agent-Signature": signature3, "Content-Type": "application/json"})
            assert response.status_code == 202
        finally:
            event.remove(db.engine, "before_cursor_execute", observe)
        assert not config_updates(server_updates)
        assert server.agent_config["network"]["updated_at"] == retry_timestamp
        assert ProbeResult.query.filter_by(server_id=test_server).count() == old_count + 2
