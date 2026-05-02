"""
P3-2  AuditMiddleware._build_new_values_payload 体积控制

测试覆盖：
  P3-2-A  小 payload 不变（未超限时语义与脱敏结果保持一致）
  P3-2-B  大 payload 截断（超限时生成合法 JSON，truncated=True，体积受控）
  P3-2-C  先脱敏后截断（敏感字段不因截断泄漏原文）
  P3-2-D  结构稳定（空 payload、深层对象、大数组场景不抛异常）
  P3-2-E  配置可覆盖（AUDIT_NEW_VALUES_MAX_BYTES 生效）
  P3-2-F  截断禁用（max_bytes=0 时不截断）
"""

import json

import pytest
from flask import Flask


# ── Helpers ──────────────────────────────────────────────────────────────────

def _make_app(max_bytes=16384):
    """Create a minimal Flask app with the given audit size limit."""
    app = Flask(__name__)
    app.config['AUDIT_NEW_VALUES_MAX_BYTES'] = max_bytes
    return app


def _audit():
    from middleware.audit import AuditMiddleware
    return AuditMiddleware()


def _serialized_bytes(obj):
    return len(json.dumps(obj, ensure_ascii=False, default=str).encode('utf-8'))


# ── P3-2-A  Small payload passes through unchanged ───────────────────────────

def test_small_payload_unchanged():
    """Payload under the size limit must be returned without truncation."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    small_payload = {
        'username': 'alice',
        'action': 'update_profile',
        'value': 'x' * 100,
    }

    with app.test_request_context('/api/v1/servers', method='POST', json=small_payload):
        from flask import g
        g.request_id = 'req-abc'

        result = audit._build_new_values_payload(role='admin')

    serialized = json.dumps(result)
    parsed = json.loads(serialized)  # must be valid JSON

    # no truncation meta
    assert '_truncation_meta' not in parsed, "Small payload must not contain _truncation_meta"
    # payload body is present
    assert parsed.get('payload', {}).get('username') == 'alice'
    assert parsed.get('payload', {}).get('action') == 'update_profile'


def test_small_payload_desensitized_but_not_truncated():
    """Sensitive fields in a small payload must be masked, but no truncation applied."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    small_payload = {
        'username': 'bob',
        'password': 'super-secret',
        'email': 'bob@example.com',
    }

    with app.test_request_context('/api/v1/auth/change-password', method='POST', json=small_payload):
        from flask import g
        g.request_id = 'req-def'

        result = audit._build_new_values_payload(role='user')

    assert '_truncation_meta' not in result
    assert result['payload']['password'] == '***'
    assert result['payload']['email'] == 'bob@example.com'


# ── P3-2-B  Large payload is truncated safely ────────────────────────────────

def test_large_payload_truncated_valid_json():
    """A payload exceeding the limit must be truncated to valid JSON with meta."""
    app = _make_app(max_bytes=512)  # tiny limit to force truncation
    audit = _audit()

    # build a body that is definitely > 512 bytes
    large_payload = {'data': 'A' * 1000, 'extra': list(range(200))}

    with app.test_request_context('/api/v1/servers', method='POST', json=large_payload):
        from flask import g
        g.request_id = 'req-big'

        result = audit._build_new_values_payload(role='admin')

    # Must be serialisable to valid JSON
    serialized = json.dumps(result, ensure_ascii=False, default=str)
    reparsed = json.loads(serialized)

    # Truncation meta must be present
    meta = reparsed.get('_truncation_meta', {})
    assert meta.get('truncated') is True, "_truncation_meta.truncated must be True"
    assert 'original_size_bytes' in meta
    assert 'stored_size_bytes' in meta

    # original must be larger than stored
    assert meta['original_size_bytes'] > meta['stored_size_bytes']

    # stored size must be under the limit (meta adds a small overhead; allow +256 for meta itself)
    assert meta['stored_size_bytes'] <= 512 + 256, (
        f"stored_size_bytes={meta['stored_size_bytes']} too large"
    )


def test_large_payload_stored_bytes_reflects_actual_size():
    """stored_size_bytes in meta must match the actual serialized size."""
    app = _make_app(max_bytes=512)
    audit = _audit()

    large_payload = {'key': 'V' * 2000}

    with app.test_request_context('/api/v1/servers', method='POST', json=large_payload):
        from flask import g
        g.request_id = 'req-size-check'

        result = audit._build_new_values_payload(role='user')

    stored_bytes_reported = result['_truncation_meta']['stored_size_bytes']
    # Remove _truncation_meta to get the payload-only size recorded
    # The stored_size_bytes is recorded BEFORE adding _truncation_meta
    payload_without_meta = {k: v for k, v in result.items() if k != '_truncation_meta'}
    actual_without_meta = _serialized_bytes(payload_without_meta)

    assert stored_bytes_reported == actual_without_meta, (
        f"stored_size_bytes={stored_bytes_reported} != actual={actual_without_meta}"
    )


# ── P3-2-C  Sanitize before truncate ─────────────────────────────────────────

def test_sanitize_before_truncate_no_secret_leakage():
    """Sensitive values must be masked even when the payload requires truncation."""
    app = _make_app(max_bytes=512)
    audit = _audit()

    # payload with a sensitive field + lots of padding
    payload = {
        'password': 'my-super-secret-password',
        'token': 'super-token-value',
        'bulk': ['item-' + str(i) for i in range(300)],
    }

    with app.test_request_context('/api/v1/auth/reset', method='POST', json=payload):
        from flask import g
        g.request_id = 'req-secret'

        result = audit._build_new_values_payload(role='user')

    serialized = json.dumps(result, ensure_ascii=False, default=str)
    # Sensitive values must not appear anywhere in the serialized output
    assert 'my-super-secret-password' not in serialized, (
        "password plaintext must not appear in truncated audit payload"
    )
    assert 'super-token-value' not in serialized, (
        "token plaintext must not appear in truncated audit payload"
    )


def test_sanitize_preserves_mask_in_small_payload():
    """_sanitize_value masks must survive even without any truncation."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    payload = {'secret_key': 'should-be-masked', 'name': 'test'}

    with app.test_request_context('/api/v1/servers/1', method='PUT', json=payload):
        from flask import g
        g.request_id = 'req-mask'

        result = audit._build_new_values_payload(role='admin')

    assert result['payload']['secret_key'] == '***'
    assert result['payload']['name'] == 'test'
    assert '_truncation_meta' not in result


# ── P3-2-D  Structural stability ─────────────────────────────────────────────

def test_empty_payload_no_exception():
    """Empty request body must not raise and must produce valid output."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    with app.test_request_context('/api/v1/servers', method='POST'):
        from flask import g
        g.request_id = 'req-empty'

        result = audit._build_new_values_payload(role='user')

    serialized = json.dumps(result)
    parsed = json.loads(serialized)
    assert isinstance(parsed, dict)


def test_deep_nested_object_no_exception():
    """Deeply nested objects must not raise and must produce valid output."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    def deep(n):
        return {'level': n, 'child': deep(n - 1)} if n > 0 else {'leaf': True}

    deep_payload = deep(30)

    with app.test_request_context('/api/v1/servers', method='POST', json=deep_payload):
        from flask import g
        g.request_id = 'req-deep'

        result = audit._build_new_values_payload(role='admin')

    serialized = json.dumps(result, default=str)
    assert json.loads(serialized) is not None


def test_large_array_no_exception():
    """A request body with a large array must not raise."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    large_array_payload = {'items': list(range(5000))}

    with app.test_request_context('/api/v1/servers', method='POST', json=large_array_payload):
        from flask import g
        g.request_id = 'req-arr'

        result = audit._build_new_values_payload(role='admin')

    serialized = json.dumps(result, default=str)
    assert json.loads(serialized) is not None


def test_none_values_in_payload_no_exception():
    """None / null values in request body must not cause errors."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    null_payload = {'key': None, 'nested': {'x': None}}

    with app.test_request_context('/api/v1/servers/5', method='PATCH', json=null_payload):
        from flask import g
        g.request_id = 'req-null'

        result = audit._build_new_values_payload(role='admin')

    assert isinstance(result, dict)
    assert '_truncation_meta' not in result


# ── P3-2-E  Configuration override ──────────────────────────────────────────

def test_custom_max_bytes_from_config():
    """AUDIT_NEW_VALUES_MAX_BYTES config must be respected."""
    custom_limit = 256
    app = _make_app(max_bytes=custom_limit)
    audit = _audit()

    payload = {'data': 'X' * 500}

    with app.test_request_context('/api/v1/servers', method='POST', json=payload):
        from flask import g
        g.request_id = 'req-cfg'

        result = audit._build_new_values_payload(role='user')

    assert result.get('_truncation_meta', {}).get('truncated') is True


def test_payload_within_custom_limit_not_truncated():
    """Payloads under the custom limit must not be truncated."""
    custom_limit = 16384
    app = _make_app(max_bytes=custom_limit)
    audit = _audit()

    small_payload = {'name': 'server-1', 'ip': '10.0.0.1'}

    with app.test_request_context('/api/v1/servers', method='POST', json=small_payload):
        from flask import g
        g.request_id = 'req-ok'

        result = audit._build_new_values_payload(role='admin')

    assert '_truncation_meta' not in result


# ── P3-2-F  Truncation disabled ──────────────────────────────────────────────

def test_truncation_disabled_when_max_bytes_zero():
    """When AUDIT_NEW_VALUES_MAX_BYTES=0, no truncation must be applied."""
    app = _make_app(max_bytes=0)
    audit = _audit()

    large_payload = {'data': 'Z' * 50000}

    with app.test_request_context('/api/v1/servers', method='POST', json=large_payload):
        from flask import g
        g.request_id = 'req-nodisable'

        result = audit._build_new_values_payload(role='admin')

    assert '_truncation_meta' not in result
    # Full data preserved (sanitize still applies str[:512] from _sanitize_value)
    assert result['payload']['data'].startswith('Z')


# ── P3-2 internal unit tests ─────────────────────────────────────────────────

def test_enforce_size_limit_noop_when_small():
    """_enforce_size_limit must return payload unchanged when under limit."""
    app = _make_app(max_bytes=16384)
    audit = _audit()

    small = {'a': 1, 'b': 'hello'}
    with app.app_context():
        result = audit._enforce_size_limit(small)

    assert result == small
    assert '_truncation_meta' not in result


def test_trim_values_trims_strings_and_arrays():
    """_trim_values must shorten long strings and truncate large lists."""
    from middleware.audit import AuditMiddleware

    obj = {
        'long_str': 'A' * 1000,
        'big_list': list(range(500)),
        'nested': {'deep_str': 'B' * 500},
    }
    trimmed = AuditMiddleware._trim_values(obj, str_limit=100, arr_limit=10)

    assert len(trimmed['long_str']) == 100
    assert len(trimmed['big_list']) == 10
    assert len(trimmed['nested']['deep_str']) == 100


def test_serialized_bytes_consistency():
    """_serialized_bytes must match manual json.dumps encoding size."""
    from middleware.audit import AuditMiddleware

    obj = {'key': 'value', 'num': 42}
    expected = len(json.dumps(obj, ensure_ascii=False, default=str).encode('utf-8'))
    assert AuditMiddleware._serialized_bytes(obj) == expected
