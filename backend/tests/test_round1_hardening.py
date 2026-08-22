from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from flask import Flask

from api.agent import _agent_rate_limit_key, _record_unknown_agent_event_once, _UNKNOWN_AGENT_EVENT_LAST
from middleware.audit import AuditMiddleware
from services.retention_cleanup import cleanup_audit_and_ops, _bulk_delete
from models.audit_log import AuditLog
from models.models import OpsEvent, ProbeResult
from extensions import db


def test_agent_rate_limit_key_uses_ip_only():
    app = Flask(__name__)
    with app.test_request_context('/', headers={'X-Agent-UUID': 'a'}):
        from flask import request
        request.remote_addr = '10.0.0.1'
        k1 = _agent_rate_limit_key()
    with app.test_request_context('/', headers={'X-Agent-UUID': 'b'}):
        from flask import request
        request.remote_addr = '10.0.0.1'
        k2 = _agent_rate_limit_key()
    assert k1 == k2 == 'agent-ip:10.0.0.1'


def test_agent_rate_limit_key_different_ips():
    app = Flask(__name__)
    with app.test_request_context('/'):
        from flask import request
        request.remote_addr = '10.0.0.1'; a = _agent_rate_limit_key()
    with app.test_request_context('/'):
        request.remote_addr = '10.0.0.2'; b = _agent_rate_limit_key()
    assert a != b


def test_audit_routine_semantics():
    app = Flask(__name__)
    for status, expected in [(401, True), (403, True), (429, True), (202, False)]:
        with app.test_request_context('/api/v1/agent/push', method='POST'):
            class R: status_code = status
            assert AuditMiddleware.is_routine_failed_agent_request(R()) is expected
    with app.test_request_context('/api/v1/auth/login', method='POST'):
        class R: status_code = 401
        assert not AuditMiddleware.is_routine_failed_agent_request(R())


def test_unknown_agent_event_once_payload_and_window():
    _UNKNOWN_AGENT_EVENT_LAST.clear()
    with patch('api.agent.record_ops_event') as rec, patch('api.agent.db') as mocked:
        mocked.session.commit.side_effect = Exception('x')
        assert _record_unknown_agent_event_once('1.2.3.4', 'bad', interval=10, sample_uuid='u') is False
        rec.assert_called_once()
        assert rec.call_args.kwargs['payload']['sample_uuid'] == 'u'


def test_retention_bulk_guard():
    try:
        _bulk_delete(ProbeResult, datetime.now(timezone.utc), 1)
    except ValueError:
        pass
    else:
        assert False
