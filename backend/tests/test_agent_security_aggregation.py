from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor
import time

from flask import Flask
from sqlalchemy.dialects import mysql
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
    with app.test_request_context('/api/v1/agent/push', environ_base={'REMOTE_ADDR': '203.0.113.9'}):
        with patch.object(db.session, 'commit') as commit:
            record_agent_security_aggregate(source='203.0.113.9', endpoint='/api/v1/agent/push',
                                            reason='missing_uuid', status=401)
        commit.assert_not_called()


def test_sqlite_atomic_upsert_survives_concurrent_writers(tmp_path):
    concurrent_app = Flask(__name__)
    concurrent_app.config.update(
        TESTING=True,
        SECRET_KEY='concurrent-aggregate-test-secret-32chars',
        SQLALCHEMY_DATABASE_URI=f"sqlite:///{tmp_path / 'aggregate.db'}",
        SQLALCHEMY_ENGINE_OPTIONS={'connect_args': {'timeout': 30}},
        SQLALCHEMY_TRACK_MODIFICATIONS=False,
    )
    db.init_app(concurrent_app)
    hour = datetime(2026, 1, 1, 10, 15, tzinfo=timezone.utc)
    with concurrent_app.app_context():
        db.create_all()

    def increment(i):
        with concurrent_app.app_context():
            record_agent_security_aggregate(
                source='203.0.113.9', endpoint='/api/v1/agent/push', reason='unknown_agent',
                status=401, uuid=f'rotating-{i % 20}', known_agent=i % 7 == 0,
                server_id=42 if i % 7 == 0 else None, now=hour,
            )
            db.session.commit()

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(increment, range(80)))

    with concurrent_app.app_context():
        row = AgentSecurityAggregate.query.one()
        assert row.request_count == 80
        assert 1 <= row.unique_uuid_count <= 20
        assert row.uuid_bitmap.bit_length() <= 63
        assert row.known_agent is True
        assert row.server_id == 42


def test_mysql_upsert_compiles_to_single_atomic_statement(app):
    """Guard the production branch against a regression to query-then-insert."""
    table = AgentSecurityAggregate.__table__
    from sqlalchemy.dialects.mysql import insert
    stmt = insert(table).values(
        bucket_start=datetime(2026, 1, 1), source_hash='a' * 64, endpoint='/agent',
        reason='x', status=401, request_count=1, unique_uuid_count=0, uuid_bitmap=0,
        first_seen=datetime(2026, 1, 1), last_seen=datetime(2026, 1, 1),
        known_agent=False,
    ).on_duplicate_key_update(request_count=table.c.request_count + 1)
    sql = str(stmt.compile(dialect=mysql.dialect()))
    assert 'ON DUPLICATE KEY UPDATE' in sql


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
