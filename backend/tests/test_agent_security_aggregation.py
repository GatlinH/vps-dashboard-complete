from datetime import datetime, timedelta, timezone

from extensions import db
from models.models import AgentSecurityAggregate, record_agent_security_aggregate


def test_hourly_aggregate_is_bounded_isolated_and_hmac_only(app):
    hour = datetime(2026, 1, 1, 10, tzinfo=timezone.utc)
    with app.app_context():
        for i in range(100):
            record_agent_security_aggregate(source='203.0.113.9', endpoint='/api/v1/agent/push',
                reason='unknown_agent', status=401, uuid=f'rotating-{i}', now=hour)
        record_agent_security_aggregate(source='203.0.113.10', endpoint='/api/v1/agent/push',
            reason='unknown_agent', status=401, uuid='other', now=hour)
        record_agent_security_aggregate(source='203.0.113.9', endpoint='/api/v1/agent/push',
            reason='unknown_agent', status=401, uuid='later', now=hour + timedelta(hours=1))
        db.session.commit()
        rows = AgentSecurityAggregate.query.order_by(AgentSecurityAggregate.id).all()
        assert len(rows) == 3
        assert rows[0].request_count == 100
        assert 1 < rows[0].unique_uuid_count <= 63
        assert rows[0].source_hash != '203.0.113.9'
        assert all('203.0.113.' not in row.source_hash for row in rows)


def test_unknown_requests_create_one_sparse_raw_and_one_aggregate(client, app):
    app.config['AGENT_PUSH_RATE_LIMIT'] = '1000 per minute'
    for i in range(100):
        response = client.post('/api/v1/agent/push', json={'uuid': f'unknown-{i}'},
                               environ_base={'REMOTE_ADDR': '198.51.100.7'})
        assert response.status_code == 401
    with app.app_context():
        from models.models import OpsEvent
        row = AgentSecurityAggregate.query.filter_by(reason='unknown_agent').one()
        assert row.request_count == 100
        assert OpsEvent.query.filter_by(event_type='agent_register_failed').count() <= 1
        assert OpsEvent.query.filter_by(event_type='security_http_anomaly').count() == 0
