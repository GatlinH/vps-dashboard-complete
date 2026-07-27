"""TDD: long-range ping charts must use bounded per-target hourly rollups."""
from datetime import datetime, timedelta, timezone


def test_public_ping_history_uses_hourly_rollups_for_90_days(client, test_server):
    from extensions import db
    from models.models import PingTargetRollup

    now = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    db.session.add(PingTargetRollup(
        server_id=test_server, target_key='vps-peer', label='Peer', protocol='tcp',
        bucket_start=now - timedelta(days=45), sample_count=4, success_count=3,
        latency_sum=120.0, loss_sum=25.0,
    ))
    db.session.commit()

    response = client.get(f'/api/v1/probe/public/ping-targets/{test_server}/history?hours=2160&limit=720&source=agent')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['history_source'] == 'rollup'
    assert payload['hours'] == 2160
    peer = next(target for target in payload['targets'] if target['key'] == 'vps-peer')
    assert len(peer['points']) == 1
    assert peer['points'][0]['latency_ms'] == 40.0
    assert peer['points'][0]['loss_pct'] == 6.25


def test_hourly_ping_rollup_accumulates_samples(app, test_server):
    from extensions import db
    from models.models import PingTargetRollup
    from services.ping_rollups import record_ping_rollup

    at = datetime(2026, 7, 1, 12, 34, tzinfo=timezone.utc)
    with app.app_context():
        record_ping_rollup(test_server, {'key': 'external', 'label': 'US', 'protocol': 'icmp', 'stats': {'avg_ms': 20, 'loss_pct': 0}}, at)
        record_ping_rollup(test_server, {'key': 'external', 'label': 'US', 'protocol': 'icmp', 'stats': {'avg_ms': 40, 'loss_pct': 50}}, at + timedelta(minutes=3))
        db.session.commit()
        row = PingTargetRollup.query.filter_by(server_id=test_server, target_key='external').one()
        assert row.sample_count == 2
        assert row.success_count == 2
        assert row.latency_sum == 60.0
        assert row.loss_sum == 50.0
        assert row.bucket_start == datetime(2026, 7, 1, 12, 0)
