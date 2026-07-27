"""Regressions for per-second peer sampling + ping_target_results partitioning.

Covers:
  1. probe_partition public API is table-parameterized and guards the table name
     against injection via an explicit allowlist.
  2. The agent /probe-results endpoint accepts a batch of samples and honors each
     sample's own created_at timestamp (per-second density), falling back to
     server receive time only when created_at is absent.
"""
import hashlib
import hmac
import json
import time
import uuid

import pytest


# ── 1. probe_partition table parameterization + allowlist ────────────────────

def test_probe_partition_rejects_non_allowlisted_table():
    from services.probe_partition import _safe_table

    # Allowed tables pass through unchanged.
    assert _safe_table("probe_results") == "probe_results"
    assert _safe_table("ping_target_results") == "ping_target_results"

    # Anything else (including injection attempts) is rejected before DDL.
    with pytest.raises(ValueError):
        _safe_table("ping_target_results; DROP TABLE users")
    with pytest.raises(ValueError):
        _safe_table("secrets")


def test_probe_partition_functions_accept_table_name_on_sqlite():
    # On SQLite (test DB) these are safe no-ops, but they must accept the
    # table_name kwarg without error so the scheduler can target either table.
    from services.probe_partition import (
        drop_expired_partitions,
        ensure_future_partitions,
        is_partitioned,
        list_partitions,
    )
    from extensions import db

    engine = db.engine
    assert list_partitions(engine, "ping_target_results") == []
    assert ensure_future_partitions(engine, table_name="ping_target_results") == []
    assert drop_expired_partitions(engine, retention_days=7, table_name="ping_target_results") == []
    assert is_partitioned(engine, "ping_target_results") is False


# ── 2. batch probe-results honor per-sample created_at ───────────────────────

def _agent_headers(agent_key, raw, agent_uuid, nonce="nonce-batch"):
    ts = str(int(time.time()))
    msg = f"{ts}.{nonce}.".encode("utf-8") + raw
    sig = hmac.new(agent_key.encode("utf-8"), msg, hashlib.sha256).hexdigest()
    return {
        "X-Agent-UUID": agent_uuid,
        "X-Agent-Key": agent_key,
        "X-Agent-Timestamp": ts,
        "X-Agent-Nonce": nonce,
        "X-Agent-Signature": sig,
        "Content-Type": "application/json",
    }


def test_probe_results_batch_preserves_per_sample_timestamps(client, auth_headers, test_server):
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    claim = client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers)
    assert claim.status_code == 200

    t1 = "2026-07-25T10:00:01"
    t2 = "2026-07-25T10:00:02"
    t3 = "2026-07-25T10:00:03"
    batch = {
        "agent_uuid": agent_uuid,
        "results": [
            {"key": "vps-9", "host": "10.0.0.9", "port": 22, "protocol": "tcp", "latency_ms": 12.0, "success": True, "loss_pct": 0, "created_at": t1},
            {"key": "vps-9", "host": "10.0.0.9", "port": 22, "protocol": "tcp", "latency_ms": 13.0, "success": True, "loss_pct": 0, "created_at": t2},
            {"key": "vps-9", "host": "10.0.0.9", "port": 22, "protocol": "tcp", "latency_ms": 14.0, "success": True, "loss_pct": 0, "created_at": t3},
        ],
    }
    raw = json.dumps(batch, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    resp = client.post("/api/v1/agent/probe-results", data=raw, headers=_agent_headers(agent_key, raw, agent_uuid))
    assert resp.status_code == 202
    assert resp.get_json()["stored"] == 3

    from extensions import db
    rows = db.session.execute(db.text(
        "SELECT latency_ms, created_at FROM ping_target_results "
        "WHERE server_id = :sid AND target_key = 'vps-9' ORDER BY created_at ASC"
    ), {"sid": test_server}).mappings().all()
    assert len(rows) == 3
    # Three distinct per-second timestamps must be preserved, not collapsed to one.
    stamps = {str(r["created_at"])[:19] for r in rows}
    assert len(stamps) == 3


# ── 3. M-2: batch probe-results enforces a per-request item cap ───────────────

def test_probe_results_batch_rejects_oversized_batch(client, auth_headers, test_server, app):
    """A compromised/rogue agent must not be able to submit an unbounded batch
    that would block the DB connection pool in a single transaction."""
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    claim = client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers)
    assert claim.status_code == 200

    max_items = int(app.config.get("AGENT_PROBE_RESULTS_MAX_ITEMS", 500))
    over = max_items + 1
    batch = {
        "agent_uuid": agent_uuid,
        "results": [
            {"key": "vps-9", "host": "10.0.0.9", "port": 22, "protocol": "tcp",
             "latency_ms": 12.0, "success": True, "loss_pct": 0}
            for _ in range(over)
        ],
    }
    raw = json.dumps(batch, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    resp = client.post("/api/v1/agent/probe-results", data=raw, headers=_agent_headers(agent_key, raw, agent_uuid, nonce="nonce-oversized"))
    assert resp.status_code == 400
    assert resp.get_json()["accepted"] is False

    # A batch exactly at the cap is still accepted.
    at_cap = {
        "agent_uuid": agent_uuid,
        "results": [
            {"key": "vps-9", "host": "10.0.0.9", "port": 22, "protocol": "tcp",
             "latency_ms": 12.0, "success": True, "loss_pct": 0}
            for _ in range(max_items)
        ],
    }
    raw2 = json.dumps(at_cap, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    resp2 = client.post("/api/v1/agent/probe-results", data=raw2, headers=_agent_headers(agent_key, raw2, agent_uuid, nonce="nonce-atcap"))
    assert resp2.status_code == 202


# ── 4. batch probe-results must also update hourly ping rollups ──────────────

def test_probe_results_batch_updates_hourly_ping_rollups(client, auth_headers, test_server):
    """The agent batch INSERT path must maintain ping_target_rollups so 30/90-day
    charts and rollup-lag monitoring stay accurate; otherwise rollup lag grows
    unbounded while raw rows keep arriving."""
    key_resp = client.post(f"/api/v1/servers/{test_server}/agent-key/generate", headers=auth_headers)
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    claim = client.post("/api/v1/agent/claim", json={"server_id": test_server, "uuid": agent_uuid}, headers=auth_headers)
    assert claim.status_code == 200

    batch = {
        "agent_uuid": agent_uuid,
        "results": [
            {"key": "vps-7", "host": "10.0.0.7", "port": 22, "protocol": "tcp", "latency_ms": 10.0, "success": True, "loss_pct": 0, "created_at": "2026-07-25T10:00:01"},
            {"key": "vps-7", "host": "10.0.0.7", "port": 22, "protocol": "tcp", "latency_ms": 20.0, "success": True, "loss_pct": 0, "created_at": "2026-07-25T10:00:02"},
        ],
    }
    raw = json.dumps(batch, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    resp = client.post("/api/v1/agent/probe-results", data=raw, headers=_agent_headers(agent_key, raw, agent_uuid, nonce="nonce-rollup"))
    assert resp.status_code == 202

    from models.models import PingTargetRollup
    row = PingTargetRollup.query.filter_by(server_id=test_server, target_key="vps-7").one()
    assert row.sample_count == 2
    assert row.success_count == 2
    assert row.latency_sum == 30.0
