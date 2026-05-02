"""Telegram API 测试"""
from unittest.mock import patch, MagicMock


def test_get_config_requires_auth(client):
    """GET /api/telegram/config 未认证返回 401"""
    resp = client.get('/api/v1/telegram/config')
    assert resp.status_code == 401


def test_get_config_with_auth(client, auth_headers):
    """GET /api/telegram/config 认证后返回配置"""
    resp = client.get('/api/v1/telegram/config', headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'config' in data


def test_post_config_requires_auth(client):
    """POST /api/telegram/config 未认证返回 401"""
    resp = client.post('/api/v1/telegram/config', json={
        'chat_id': '12345',
        'enabled': False,
    })
    assert resp.status_code == 401


def test_post_config_saves_with_admin(client, auth_headers):
    """POST /api/telegram/config admin 权限可保存配置"""
    resp = client.post('/api/v1/telegram/config', json={
        'chat_id': '99999',
        'prefix': '【测试】',
        'enabled': False,
    }, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get('config', {}).get('chat_id') == '99999'
    assert data.get('config', {}).get('prefix') == '【测试】'


def test_post_config_saves_bot_token(client, auth_headers):
    """POST /api/telegram/config 可保存 bot_token"""
    resp = client.post('/api/v1/telegram/config', json={
        'bot_token': 'test-bot-token-123',
        'chat_id': '11111',
        'enabled': False,
    }, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    # has_token 应为 True
    assert data.get('config', {}).get('has_token') is True


def test_test_send_requires_auth(client):
    """POST /api/telegram/test 未认证返回 401"""
    resp = client.post('/api/v1/telegram/test')
    assert resp.status_code == 401


def test_test_send_with_admin_mock(client, auth_headers):
    """POST /api/telegram/test admin 权限，mock 外部请求"""
    # 先配置一个有效的 bot_token 和 chat_id
    client.post('/api/v1/telegram/config', json={
        'bot_token': 'fake-bot-token',
        'chat_id': '12345',
        'enabled': True,
    }, headers=auth_headers)

    mock_resp = MagicMock()
    mock_resp.json.return_value = {'ok': True, 'result': {'message_id': 1}}

    with patch('requests.post', return_value=mock_resp):
        resp = client.post('/api/v1/telegram/test', headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'msg' in data


def test_test_send_fails_gracefully_without_config(client, auth_headers):
    """POST /api/telegram/test 无配置时返回 502"""
    from models.models import TelegramConfig
    from extensions import db
    import extensions

    # 清空 telegram config
    with client.application.app_context():
        TelegramConfig.query.delete()
        db.session.commit()

    mock_resp = MagicMock()
    mock_resp.json.return_value = {'ok': False, 'error': 'no token'}

    with patch('requests.post', return_value=mock_resp):
        resp = client.post('/api/v1/telegram/test', headers=auth_headers)
    # 无配置时 send_message 返回 ok=False，接口返回 502
    assert resp.status_code == 502


def test_config_returns_masked_token(client, auth_headers):
    """GET /api/telegram/config 返回脱敏 token"""
    client.post('/api/v1/telegram/config', json={
        'bot_token': '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        'chat_id': '-1001234567890',
        'enabled': True,
    }, headers=auth_headers)
    resp = client.get('/api/v1/telegram/config', headers=auth_headers)
    assert resp.status_code == 200
    cfg = resp.get_json().get('config', {})
    assert cfg.get('bot_token')
    assert '****' in cfg.get('bot_token')
    assert cfg.get('bot_token') != '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345'


def test_test_send_returns_error_type_for_invalid_token(client, auth_headers):
    """POST /api/telegram/test 失败时返回 error_type 便于前端细分提示"""
    client.post('/api/v1/telegram/config', json={
        'bot_token': '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        'chat_id': '-1001234567890',
        'enabled': True,
    }, headers=auth_headers)
    mock_resp = MagicMock()
    mock_resp.status_code = 401
    mock_resp.json.return_value = {'ok': False, 'description': 'Unauthorized'}
    with patch('requests.post', return_value=mock_resp):
        resp = client.post('/api/v1/telegram/test', headers=auth_headers)
    assert resp.status_code == 502
    assert resp.get_json().get('error_type') == 'TG_TOKEN_INVALID'


def test_export_telegram_bundle(client, auth_headers):
    """GET /api/telegram/export 可导出配置和规则"""
    client.post('/api/v1/telegram/config', json={
        'bot_token': '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        'chat_id': '-1001234567890',
        'enabled': True,
    }, headers=auth_headers)
    resp = client.get('/api/v1/telegram/export', headers=auth_headers)
    assert resp.status_code == 200
    assert 'attachment;' in (resp.headers.get('Content-Disposition') or '')
    payload = resp.get_json()
    assert 'config' in payload
    assert 'rules' in payload


def test_bot_token_encrypted_in_db_when_secret_set(app):
    """ORM 路径：bot_token 写入 DB 时应为 Fernet 密文，ORM 读取时应透明解密还原明文"""
    from sqlalchemy import text
    from models.models import TelegramConfig
    from extensions import db

    with app.app_context():
        plaintext = "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ_secret"
        cfg = TelegramConfig(chat_id="orm-enc-test")
        cfg.bot_token = plaintext
        db.session.add(cfg)
        db.session.commit()
        cfg_id = cfg.id

        try:
            # 原始 SQL 读取列值，断言落盘值为 Fernet 密文而非明文
            row = db.session.execute(
                text("SELECT bot_token FROM telegram_config WHERE id = :id"),
                {"id": cfg_id},
            ).fetchone()
            raw_value = row[0]
            assert raw_value != plaintext, "落盘值不应为明文"
            assert raw_value.startswith("gAAAAA"), (
                f"落盘值应为 Fernet 密文（gAAAAA…），实际前缀: {raw_value[:20]!r}"
            )

            # 通过 ORM 读取，确认透明解密可还原明文
            db.session.expire(cfg)
            assert cfg.bot_token == plaintext, "ORM 读取应透明解密还原明文"
        finally:
            db.session.delete(cfg)
            db.session.commit()


def test_write_rejected_when_no_encryption_key(app):
    """未配置 TELEGRAM_TOKEN_SECRET 时写入非空 bot_token 应抛异常（fail-closed）。

    SQLAlchemy 将 TypeDecorator 中的 RuntimeError 包装为 StatementError；
    断言 __cause__ 为 RuntimeError 且消息包含 TELEGRAM_TOKEN_SECRET。
    """
    import pytest
    from sqlalchemy.exc import StatementError
    from models.models import TelegramConfig
    from extensions import db

    with app.app_context():
        original = app.config.get("TELEGRAM_TOKEN_SECRET")
        app.config["TELEGRAM_TOKEN_SECRET"] = ""
        try:
            cfg = TelegramConfig(chat_id="fail-closed-test")
            cfg.bot_token = "should-not-be-stored"
            db.session.add(cfg)
            with pytest.raises(StatementError) as exc_info:
                db.session.flush()
            cause = exc_info.value.__cause__
            assert isinstance(cause, RuntimeError)
            assert "TELEGRAM_TOKEN_SECRET" in str(cause)
        finally:
            db.session.rollback()
            app.config["TELEGRAM_TOKEN_SECRET"] = original


def test_empty_token_clears_without_key(app):
    """空 token 写入无需密钥（用于清空 token 操作），不应触发 fail-closed"""
    from models.models import TelegramConfig
    from extensions import db

    with app.app_context():
        original = app.config.get("TELEGRAM_TOKEN_SECRET")
        app.config["TELEGRAM_TOKEN_SECRET"] = ""
        try:
            cfg = TelegramConfig(chat_id="empty-tok-test")
            cfg.bot_token = ""
            db.session.add(cfg)
            db.session.flush()  # should not raise
            db.session.rollback()
        finally:
            db.session.rollback()
            app.config["TELEGRAM_TOKEN_SECRET"] = original


def test_test_send_rate_limit(client, auth_headers):
    """POST /api/telegram/test 增加限流，防止短时间防刷"""
    client.application.config['RATELIMIT_ENABLED'] = True
    client.application.limiter.enabled = True

    client.post('/api/v1/telegram/config', json={
        'bot_token': '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        'chat_id': '-1001234567890',
        'enabled': True,
    }, headers=auth_headers)
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {'ok': True}
    with patch('requests.post', return_value=mock_resp):
        for _ in range(3):
            ok_resp = client.post('/api/v1/telegram/test', headers=auth_headers)
            assert ok_resp.status_code == 200
        limited_resp = client.post('/api/v1/telegram/test', headers=auth_headers)
    assert limited_resp.status_code == 429
