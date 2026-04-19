"""限流键解析的边界分支测试。"""

from middleware.rate_limit import _resolve_user_rate_limit_key


def test_resolve_user_rate_limit_key_prefers_supported_dict_fields_in_order():
    assert _resolve_user_rate_limit_key({'user_id': 12, 'id': 9}) == '12'
    assert _resolve_user_rate_limit_key({'id': 'abc'}) == 'abc'
    assert _resolve_user_rate_limit_key({'sub': 'subject-1'}) == 'subject-1'
    assert _resolve_user_rate_limit_key({'uid': 'u-007'}) == 'u-007'


def test_resolve_user_rate_limit_key_returns_none_for_unsupported_or_empty_identity():
    assert _resolve_user_rate_limit_key({'name': 'no-supported-field'}) is None
    assert _resolve_user_rate_limit_key(None) is None
