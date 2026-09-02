import logging

import pytest

import extensions
from utils import token_blocklist


@pytest.mark.parametrize("value", [b"corrupted", b"", b"[123]"])
def test_force_revoke_corrupt_forced_at_raises(app, value):
    with app.app_context():
        extensions.redis_client.set("revoked:user:100:forced_at", value)
        with pytest.raises((ValueError, TypeError, ConnectionError)):
            token_blocklist.is_user_force_revoked(100, 0)


def test_force_revoke_redis_error_raises(app, monkeypatch):
    with app.app_context():
        monkeypatch.setattr(extensions.redis_client, "get", lambda key: (_ for _ in ()).throw(ConnectionError("redis down")))
        with pytest.raises(ConnectionError):
            token_blocklist.is_user_force_revoked(101, 0)


def test_force_revoke_normal_boundaries(app):
    with app.app_context():
        key = "revoked:user:102:forced_at"
        extensions.redis_client.set(key, "100")
        assert token_blocklist.is_user_force_revoked(102, 99.9) is True
        assert token_blocklist.is_user_force_revoked(102, 100) is False
        assert token_blocklist.is_user_force_revoked(102, 101) is False
        extensions.redis_client.delete(key)
        assert token_blocklist.is_user_force_revoked(102, 0) is False


def _loader(app):
    from extensions import jwt
    return jwt._token_in_blocklist_callback


@pytest.mark.parametrize("fail_open, expected", [(False, True), (True, False)])
def test_loader_respects_fail_open_for_force_revoke_errors(app, monkeypatch, fail_open, expected):
    with app.app_context():
        app.config["TESTING"] = False
        app.config["JWT_BLOCKLIST_FAIL_OPEN"] = fail_open
        monkeypatch.setattr(token_blocklist, "is_token_revoked", lambda *a, **k: False)
        monkeypatch.setattr(token_blocklist, "is_user_force_revoked", lambda *a, **k: (_ for _ in ()).throw(ConnectionError("redis down")))
        result = _loader(app)({"alg": "HS256"}, {"jti": "j", "sub": "1", "iat": 0, "type": "access"})
        assert result is expected


def test_wait_logs_redis_error(app, monkeypatch, caplog):
    with app.app_context(), caplog.at_level(logging.WARNING, logger=token_blocklist.logger.name):
        monkeypatch.setattr(extensions.redis_client, "get", lambda key: (_ for _ in ()).throw(ConnectionError("redis down")))
        token_blocklist.wait_until_user_tokens_can_be_issued(103)
        assert "等待用户 token 签发边界失败" in caplog.text
