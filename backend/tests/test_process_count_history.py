"""Regression coverage for privacy-safe host process-count monitoring."""
from datetime import datetime, timedelta, timezone


def test_public_process_count_history_is_fixed_one_hour(app, test_server):
    from extensions import db
    from models.models import ProbeResult

    now = datetime.now(timezone.utc)
    with app.app_context():
        db.session.add_all([
            ProbeResult(server_id=test_server, process_count=101, created_at=now - timedelta(minutes=30)),
            # A non-Agent probe row after the real sample must not make the
            # process chart appear to stop at the prior sample.
            ProbeResult(server_id=test_server, cpu_use=25, created_at=now - timedelta(minutes=5)),
            ProbeResult(server_id=test_server, process_count=999, created_at=now - timedelta(hours=2)),
        ])
        db.session.commit()

        client = app.test_client()
        response = client.get(
            f"/api/v1/servers/public/{test_server}/history?days=90&limit=720&metric=process_count"
        )
        assert response.status_code == 200
        payload = response.get_json()
        assert payload["metric"] == "process_count"
        assert payload["hours"] == 1
        assert payload["history_source"] == "raw"
        assert [row["process_count"] for row in payload["data"]] == [101]
        assert all(set(row) <= {"server_id", "created_at", "timestamp", "process_count"} for row in payload["data"])


def test_public_raw_history_serializes_process_count(app, test_server):
    from extensions import db
    from models.models import ProbeResult

    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    with app.app_context():
        db.session.add(ProbeResult(server_id=test_server, process_count=12, created_at=now))
        db.session.commit()

        client = app.test_client()
        response = client.get(
            f"/api/v1/servers/public/{test_server}/history?days=1&limit=1"
        )
        assert response.status_code == 200
        data = response.get_json()["data"]
        assert data[0]["process_count"] == 12
