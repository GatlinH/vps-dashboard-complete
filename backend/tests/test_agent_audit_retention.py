import os
import re
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

import pytest
from flask import Flask, request

import extensions
from app import create_app
from extensions import db
from api.agent import _agent_rate_limit_key, _record_unknown_agent_event_once
from models.audit_log import AuditLog
from models.models import OpsEvent, ProbeResult
from middleware.audit import AuditMiddleware
from services.retention_cleanup import cleanup_audit_and_ops


def test_unknown_event_window_is_real_and_isolated(app):
    app.config['AGENT_UNKNOWN_EVENT_INTERVAL_SECONDS'] = 10
    from api.agent import _UNKNOWN_AGENT_EVENT_LAST
    _UNKNOWN_AGENT_EVENT_LAST.clear()
    with app.app_context(), patch.object(extensions, 'redis_client', None), patch('api.agent.record_ops_event') as rec, patch('api.agent.time.monotonic', side_effect=[100, 105, 111, 112]):
        with patch('api.agent.db.session.commit', return_value=None), patch('api.agent.db.session.rollback', return_value=None):
            assert _record_unknown_agent_event_once('1.2.3.4', 'bad', sample_uuid='u1') is True
            assert _record_unknown_agent_event_once('1.2.3.4', 'bad', sample_uuid='u1') is False
            assert _record_unknown_agent_event_once('1.2.3.4', 'bad', sample_uuid='u1') is True
            assert _record_unknown_agent_event_once('5.6.7.8', 'bad', sample_uuid='u2') is True
    assert rec.call_count == 3
    assert rec.call_args_list[0].kwargs['payload']['sample_uuid'] == 'u1'


def test_agent_rate_limit_key_uses_environ_ip():
    from flask import Flask
    app = Flask(__name__)
    with app.test_request_context('/', environ_base={'REMOTE_ADDR': '10.0.0.1'}):
        a = _agent_rate_limit_key()
    with app.test_request_context('/', environ_base={'REMOTE_ADDR': '10.0.0.1'}):
        b = _agent_rate_limit_key()
    with app.test_request_context('/', environ_base={'REMOTE_ADDR': '10.0.0.2'}):
        c = _agent_rate_limit_key()
    assert a == b == 'agent-ip:10.0.0.1'
    assert c != a


def test_all_agent_routes_use_trusted_agent_key():
    source = open(os.path.join(os.path.dirname(__file__), '..', 'api', 'agent.py')).read()
    assert source.count('key_func=_agent_rate_limit_key') >= 4


def test_actual_audit_after_request_agent_statuses(tmp_path):
    uri = f"sqlite:///{tmp_path / 'audit-middleware.db'}"
    app = Flask(__name__)
    app.config.update(TESTING=True, SQLALCHEMY_DATABASE_URI=uri,
                      SQLALCHEMY_TRACK_MODIFICATIONS=False,
                      SECRET_KEY='s' * 40)
    db.init_app(app)
    AuditMiddleware(app)
    app.add_url_rule('/api/v1/agent/test', 'agent_test', lambda: ('x', int(request.args.get('code', 401))), methods=['POST'])
    app.add_url_rule('/api/v1/auth/test', 'auth_test', lambda: ('x', 401), methods=['POST'])
    with app.app_context():
        db.create_all()
        before = AuditLog.query.count()
    client = app.test_client()
    for code in (401, 403, 429):
        client.post(f'/api/v1/agent/test?code={code}')
    with app.app_context():
        assert AuditLog.query.count() == before
    client.post('/api/v1/agent/test?code=202')
    with app.app_context():
        assert AuditLog.query.count() == before + 1
    client.post('/api/v1/auth/test')
    with app.app_context():
        assert AuditLog.query.count() == before + 2


def test_retention_real_sqlite_dry_run_and_batch(tmp_path):
    uri = f"sqlite:///{tmp_path / 'retention.db'}"
    app = create_app(TESTING=True, SQLALCHEMY_DATABASE_URI=uri, RATELIMIT_ENABLED=False, FORCE_HTTPS=False, AGENT_REQUIRE_TLS=False, SECRET_KEY='s'*40, JWT_SECRET_KEY='j'*40)
    old = datetime.now(timezone.utc) - timedelta(days=30)
    new = datetime.now(timezone.utc) - timedelta(days=1)
    with app.app_context():
        from models.models import Server
        server = Server(name='retention', uuid='retention-uuid')
        db.session.add(server); db.session.flush()
        db.session.add_all([AuditLog(action='x', method='POST', endpoint='/x', status_code=200, success=True, created_at=old), AuditLog(action='y', method='POST', endpoint='/y', status_code=200, success=True, created_at=new), OpsEvent(event_type='x', title='x', message='x', created_at=old), ProbeResult(server_id=server.id, created_at=old)])
        db.session.commit()
        dry = cleanup_audit_and_ops(app, retention_days=14, batch_size=1, dry_run=True)
        assert dry['audit_logs'] == 1 and dry['ops_events'] == 1
        assert AuditLog.query.count() == 2
        result = cleanup_audit_and_ops(app, retention_days=14, batch_size=1)
        assert result['audit_logs'] == 1 and result['ops_events'] == 1
        assert AuditLog.query.count() == 1 and OpsEvent.query.count() == 0 and ProbeResult.query.count() == 1
