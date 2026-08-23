from datetime import datetime, timedelta, timezone
import time

from werkzeug.security import generate_password_hash

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
        assert (OpsEvent.query.filter_by(event_type='agent_register_failed').first().payload or {})['sample_uuid']


def test_missing_uuid_is_diagnostic_event_and_aggregate(client, app):
    response = client.post('/api/v1/agent/push', json={'cpu_use': 1},
                           headers={'X-Forwarded-For': '198.51.100.66'},
                           environ_overrides={'REMOTE_ADDR': '203.0.113.11'})
    assert response.status_code == 401
    with app.app_context():
        from models.models import OpsEvent
        event = OpsEvent.query.filter_by(event_type='agent_auth_failed').one()
        assert event.classification == 'diagnostic_agent_auth'
        assert event.payload['reason'] == 'missing_uuid'
        assert event.payload['remote_addr'] == '203.0.113.11'
        aggregate = AgentSecurityAggregate.query.filter_by(reason='missing_uuid').one()
        assert aggregate.request_count == 1


def test_aggregate_helper_does_not_commit_independently(app):
    from unittest.mock import patch
    from api.agent import _security_aggregate
    with app.test_request_context('/api/v1/agent/push', environ_base={'REMOTE_ADDR': '203.0.113.9'}):
        with patch('api.agent.db.session.commit') as commit:
            _security_aggregate('missing_uuid', 401)
        commit.assert_not_called()


def test_known_uuid_invalid_key_retains_event_and_aggregate(client, app):
    from models.models import OpsEvent, Server
    with app.app_context():
        server = Server(name='known-agent', uuid='known-uuid', agent_key_hash=generate_password_hash('right-key'))
        db.session.add(server)
        db.session.commit()
        server_id = server.id
    response = client.post('/api/v1/agent/push', json={'uuid': 'known-uuid'}, headers={
        'X-Agent-Key': 'wrong-key',
        'X-Agent-Timestamp': str(int(time.time())),
        'X-Agent-Nonce': 'invalid-key-test',
        'X-Agent-Signature': '0' * 64,
    })
    assert response.status_code == 401
    with app.app_context():
        event = OpsEvent.query.filter_by(event_type='agent_auth_failed', classification='known_agent_auth').one()
        assert event.payload['reason'] == 'invalid_key'
        aggregate = AgentSecurityAggregate.query.filter_by(reason='invalid_key').one()
        assert aggregate.known_agent is True
        assert aggregate.server_id == server_id
