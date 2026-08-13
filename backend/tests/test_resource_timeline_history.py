"""CPU/RAM detail history must retain a full chronological raw hour.

ProbeResult also stores scheduler/network-probe rows. Those rows have no host
resource values; ordering raw rows DESC then applying a generic limit can consume
most of the budget with these null rows. The UI receives only the last few real
CPU/RAM samples and draws a short trace at the right edge of a one-hour chart.
"""
from datetime import datetime, timedelta, timezone

from extensions import db
from models.models import ProbeResult


def test_resource_history_filters_null_rows_before_limit_and_returns_ascending(client, test_server):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    # More non-resource rows than the requested limit simulate scheduler/probe
    # noise arriving after the host telemetry rows.
    db.session.add_all([
        ProbeResult(
            server_id=test_server,
            created_at=now - timedelta(minutes=58 - index),
            cpu_use=10.0 + index,
            ram_use=50.0 + index,
            disk_use=70.0,
            status="online",
        )
        for index in range(3)
    ] + [
        ProbeResult(
            server_id=test_server,
            created_at=now - timedelta(seconds=index),
            latency_ms=12.0,
            status="online",
        )
        for index in range(12)
    ])
    db.session.commit()

    response = client.get(
        f"/api/v1/servers/public/{test_server}/history"
        "?days=1&limit=3&metric=resource_timeline"
    )
    assert response.status_code == 200
    payload = response.get_json()

    assert payload["metric"] == "resource_timeline"
    assert payload["bucketed"] is False
    assert [row["cpu_use"] for row in payload["data"]] == [10.0, 11.0, 12.0]
    assert [row["ram_use"] for row in payload["data"]] == [50.0, 51.0, 52.0]
    times = [row["created_at"] for row in payload["data"]]
    assert times == sorted(times), "chart data contract is old-to-new"


def test_network_timeline_filters_null_network_rows_and_returns_bounded_6h_buckets(client, test_server):
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    db.session.add_all([
        ProbeResult(server_id=test_server, created_at=now - timedelta(minutes=8), net_up=10.0, net_down=20.0, status="online"),
        ProbeResult(server_id=test_server, created_at=now - timedelta(minutes=7), net_up=14.0, net_down=24.0, status="online"),
    ] + [
        ProbeResult(server_id=test_server, created_at=now - timedelta(seconds=index), cpu_use=8.0, ram_use=54.0, status="online")
        for index in range(10)
    ])
    db.session.commit()

    payload = client.get(
        f"/api/v1/servers/public/{test_server}/history"
        "?days=1&limit=120&metric=network_timeline"
    ).get_json()
    assert payload["metric"] == "network_timeline"
    assert payload["bucketed"] is True
    assert payload["bucket_minutes"] == 3
    # The timestamps can straddle a three-minute boundary; either way the API
    # must preserve chronological non-null network-only buckets.
    assert 1 <= len(payload["data"]) <= 2
    assert all(row["net_up"] is not None and row["net_down"] is not None for row in payload["data"])
    assert [row["created_at"] for row in payload["data"]] == sorted(row["created_at"] for row in payload["data"])


def test_resource_history_requires_actual_cpu_or_memory_sample(client, test_server):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    db.session.add_all([
        ProbeResult(server_id=test_server, created_at=now - timedelta(seconds=5), latency_ms=8.0, status="online"),
        ProbeResult(server_id=test_server, created_at=now - timedelta(seconds=10), process_count=100, status="online"),
        ProbeResult(server_id=test_server, created_at=now - timedelta(seconds=15), cpu_use=7.0, ram_use=54.0, status="online"),
    ])
    db.session.commit()

    payload = client.get(
        f"/api/v1/servers/public/{test_server}/history"
        "?days=1&limit=10&metric=resource_timeline"
    ).get_json()
    assert len(payload["data"]) == 1
    assert payload["data"][0]["cpu_use"] == 7.0
    assert payload["data"][0]["ram_use"] == 54.0
