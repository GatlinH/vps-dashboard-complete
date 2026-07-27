"""TDD: long-range detail history must query bounded hourly rollups, not raw rows."""
from datetime import datetime, timedelta, timezone


def test_public_history_uses_hourly_rollups_for_ranges_over_raw_retention(client, test_server):
    # This import is intentionally the RED gate: long-range rollup storage does
    # not exist until the implementation adds it.
    from extensions import db
    from models.models import TelemetryRollup

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    db.session.add_all([
        TelemetryRollup(
            server_id=test_server,
            resolution_minutes=60,
            bucket_start=now - timedelta(days=45),
            sample_count=60,
            cpu_sum=1200.0,
            ram_sum=2400.0,
            disk_sum=1800.0,
            net_up_sum=600.0,
            net_down_sum=300.0,
        ),
        TelemetryRollup(
            server_id=test_server,
            resolution_minutes=60,
            bucket_start=now - timedelta(days=44),
            sample_count=60,
            cpu_sum=1800.0,
            ram_sum=3000.0,
            disk_sum=2100.0,
            net_up_sum=900.0,
            net_down_sum=450.0,
        ),
    ])
    db.session.commit()

    response = client.get(f'/api/v1/servers/public/{test_server}/history?days=90&bucket_minutes=60&limit=720')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['history_source'] == 'rollup'
    assert payload['bucketed'] is True
    assert payload['bucket_minutes'] == 60
    assert len(payload['data']) == 2
    assert payload['data'][0]['cpu_use'] == 20.0
    assert payload['data'][1]['net_down'] == 7.5


def test_hourly_rollup_upsert_accumulates_multiple_raw_samples(app, test_server):
    from extensions import db
    from services.telemetry_rollups import record_telemetry_rollup
    from models.models import TelemetryRollup

    bucket = datetime(2026, 7, 1, 12, 34, tzinfo=timezone.utc)
    with app.app_context():
        record_telemetry_rollup(test_server, {
            'cpu_use': 10.0, 'ram_use': 20.0, 'disk_use': 30.0,
            'net_up': 2.0, 'net_down': 1.0,
        }, bucket)
        record_telemetry_rollup(test_server, {
            'cpu_use': 30.0, 'ram_use': 40.0, 'disk_use': 50.0,
            'net_up': 6.0, 'net_down': 3.0,
        }, bucket + timedelta(minutes=5))
        db.session.commit()
        row = TelemetryRollup.query.filter_by(server_id=test_server, resolution_minutes=60).one()
        assert row.sample_count == 2
        assert row.cpu_sum == 40.0
        assert row.net_down_sum == 4.0
        assert row.bucket_start == datetime(2026, 7, 1, 12, 0)


def test_rollup_cleanup_keeps_only_configured_window(app, test_server):
    from extensions import db
    from models.models import TelemetryRollup
    from services.telemetry_rollups import compact_telemetry_rollups

    now = datetime(2026, 7, 27, 12, tzinfo=timezone.utc)
    with app.app_context():
        old = TelemetryRollup(server_id=test_server, resolution_minutes=60, bucket_start=(now - timedelta(days=181)).replace(tzinfo=None))
        keep = TelemetryRollup(server_id=test_server, resolution_minutes=60, bucket_start=(now - timedelta(days=180)).replace(tzinfo=None))
        db.session.add_all([old, keep])
        db.session.commit()
        old_id, keep_id = old.id, keep.id
        assert compact_telemetry_rollups(retention_days=180, now=now) == 1
        db.session.commit()
        assert db.session.get(TelemetryRollup, old_id) is None
        assert db.session.get(TelemetryRollup, keep_id) is not None
