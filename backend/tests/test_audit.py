"""审计中间件分类与脱敏逻辑测试（含支付路径覆盖）。"""

from flask import Flask

from middleware.audit import AuditMiddleware


def test_audit_action_and_resource_type_for_payment_path():
    audit = AuditMiddleware()

    action = audit._get_action('/api/v1/billing/invoice', 'POST', role='user')
    resource = audit._get_resource_type('/api/v1/payment/orders/123')

    assert action == 'PAYMENT_CREATE'
    assert resource == 'Payment'


def test_audit_action_prefers_auth_prefix_over_admin_role():
    audit = AuditMiddleware()
    action = audit._get_action('/api/v1/auth/change-password', 'POST', role='admin')
    assert action == 'USER_CREATE'


def test_audit_should_ignore_metrics_even_for_write_method():
    app = Flask(__name__)
    audit = AuditMiddleware()

    with app.test_request_context('/metrics', method='POST'):
        assert audit._should_audit() is False


def test_audit_sanitizes_nested_sensitive_payload_values():
    audit = AuditMiddleware()

    payload = {
        'username': 'alice',
        'password': 'plain-text',
        'profile': {
            'token': 'abc',
            'nested': [{'secret_key': 'k1'}, {'safe': 'ok'}],
        },
    }

    sanitized = audit._sanitize_value(payload)
    assert sanitized['password'] == '***'
    assert sanitized['profile']['token'] == '***'
    assert sanitized['profile']['nested'][0]['secret_key'] == '***'
    assert sanitized['profile']['nested'][1]['safe'] == 'ok'
