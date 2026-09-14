import json
from datetime import datetime, timedelta, timezone

import pytest


def test_public_server_detail_aggregates_detail_payload(app, test_server, monkeypatch):
    cached = {}

    class FakeRedis:
        def get(self, key):
            return cached.get(key)

        def setex(self, key, ttl, value):
            assert ttl == 5
            cached[key] = value

    monkeypatch.setattr("extensions.redis_client", FakeRedis())

    client = app.test_client()
    response = client.get(f"/api/v1/servers/public/{test_server}/detail?days=1")

    assert response.status_code == 200
    payload = response.get_json()
    assert set(payload) == {
        "server", "live", "history", "resource_timeline", "process_history",
        "traffic", "ping_targets", "ping_history",
    }
    assert payload["server"]["id"] == test_server
    assert payload["live"]["server_id"] == test_server
    assert payload["history"]["days"] == 1
    assert payload["history"]["bucket_minutes"] == 5
    assert payload["history"]["limit"] == 288
    assert isinstance(payload["resource_timeline"], list)
    assert isinstance(payload["process_history"], list)
    assert payload["traffic"]["id"] == test_server

    cached_payload = json.loads(next(iter(cached.values())))
    assert cached_payload == payload


def test_public_server_detail_realtime_contract(app, test_server):
    response = app.test_client().get(
        f"/api/v1/servers/public/{test_server}/detail?days=0"
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["history"]["days"] == 1
    assert payload["history"]["limit"] == 3600
    assert payload["ping_history"]["hours"] == 6


@pytest.mark.parametrize("days", [0, 1])
def test_public_server_detail_process_history_covers_full_hour(
    app, test_server, monkeypatch, days
):
    from extensions import db
    from models.models import ProbeResult

    monkeypatch.setattr("extensions.redis_client.get", lambda key: None)
    monkeypatch.setattr("extensions.redis_client.setex", lambda *args: None)
    now = datetime.now(timezone.utc)
    first_at = now - timedelta(seconds=3590)
    process_rows = [
        ProbeResult(
            server_id=test_server,
            process_count=100 + index,
            created_at=first_at + timedelta(seconds=2 * index),
        )
        for index in range(1796)
    ]
    null_rows = [
        ProbeResult(
            server_id=test_server,
            cpu_use=20,
            created_at=now - timedelta(seconds=index),
        )
        for index in range(900)
    ]
    with app.app_context():
        db.session.add_all(process_rows + null_rows + [
            ProbeResult(
                server_id=test_server,
                process_count=9999,
                created_at=now - timedelta(hours=2),
            )
        ])
        db.session.commit()

        client = app.test_client()
        aggregate = client.get(
            f"/api/v1/servers/public/{test_server}/detail?days={days}"
        ).get_json()["process_history"]
        limited = client.get(
            f"/api/v1/servers/public/{test_server}/history"
            "?days=90&limit=50&metric=process_count"
        ).get_json()

    assert len(aggregate) == 1796
    assert len(aggregate) > 720
    timestamps = [datetime.fromisoformat(row["timestamp"]) for row in aggregate]
    assert timestamps == sorted(timestamps)
    assert (timestamps[-1] - timestamps[0]).total_seconds() >= 3500
    assert timestamps[0] == first_at.replace(tzinfo=None)
    assert aggregate[0]["process_count"] == 100
    assert all(isinstance(row["process_count"], int) for row in aggregate)
    assert limited["total"] == limited["count"] == 50
    assert [row["process_count"] for row in limited["data"]] == list(
        range(1846, 1896)
    )


def test_public_server_detail_matches_individual_public_payloads(app, test_server, monkeypatch):
    monkeypatch.setattr("extensions.redis_client.get", lambda key: None)
    monkeypatch.setattr("extensions.redis_client.setex", lambda *args: None)
    client = app.test_client()

    aggregate = client.get(f"/api/v1/servers/public/{test_server}/detail?days=1").get_json()
    history = client.get(f"/api/v1/servers/public/{test_server}/history?days=1&limit=288&bucket_minutes=5").get_json()
    resources = client.get(f"/api/v1/servers/public/{test_server}/history?days=1&limit=900&metric=resource_timeline").get_json()
    processes = client.get(f"/api/v1/servers/public/{test_server}/history?days=1&limit=720&metric=process_count").get_json()
    live = client.get(f"/api/v1/servers/public/{test_server}/live").get_json()["live"]
    ping_targets = client.get(f"/api/v1/probe/public/ping-targets/{test_server}?count=1").get_json()
    ping_history = client.get(f"/api/v1/probe/public/ping-targets/{test_server}/history?hours=24&limit=288").get_json()

    assert aggregate["history"] == history
    assert aggregate["resource_timeline"] == resources["data"]
    assert aggregate["process_history"] == processes["data"]
    assert aggregate["live"] == live
    assert aggregate["ping_targets"] == ping_targets
    assert aggregate["ping_history"] == ping_history
