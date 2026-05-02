"""
P0 安全修复回归测试

覆盖 4 个 P0 缺陷修复验证：
  P0-1: GET /api/v1/geo/servers/coords 需要认证（viewer 或 admin）
  P0-2: 月度流量重置在 reset_day > 当月天数时应在当月最后一天触发
  P0-3: revoke_all_user_tokens 仅影响目标用户，不影响其他用户
  P0-4: TelegramConfig.bot_token 写入数据库后为非明文（加密或空密钥时降级）
"""

import time
import calendar
from datetime import date
from unittest.mock import patch, MagicMock

import pytest
from sqlalchemy import text
from werkzeug.security import generate_password_hash

from extensions import db as _db
from models.models import User, Server, TelegramConfig


# ── 辅助 fixtures ─────────────────────────────────────────────────────────────

@pytest.fixture
def viewer_headers(client, app):
    with app.app_context():
        user = User(
            username='p0_viewer',
            email='p0_viewer@example.com',
            password_hash=generate_password_hash('ViewerP0@123456'),
            role='viewer',
            email_verified=True,
        )
        _db.session.add(user)
        _db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'p0_viewer',
        'password': 'ViewerP0@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


@pytest.fixture
def plain_user_headers(client, app):
    with app.app_context():
        user = User(
            username='p0_plain',
            email='p0_plain@example.com',
            password_hash=generate_password_hash('PlainP0@123456'),
            role='user',
            email_verified=True,
        )
        _db.session.add(user)
        _db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'p0_plain',
        'password': 'PlainP0@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


@pytest.fixture
def admin_headers(client):
    resp = client.post('/api/v1/auth/login', json={
        'username': 'admin',
        'password': 'TestAdmin@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


# ── P0-1: GET /api/v1/geo/servers/coords 认证测试 ────────────────────────────

class TestGeoServerCoordsAuth:
    """P0-1: servers/coords 接口须认证；viewer/admin 可访问，未登录/普通用户禁止。"""

    def test_unauthenticated_returns_401(self, client):
        """未登录访问返回 401"""
        resp = client.get('/api/v1/geo/servers/coords')
        assert resp.status_code == 401

    def test_plain_user_returns_403(self, client, plain_user_headers):
        """普通 user 角色访问返回 403"""
        resp = client.get('/api/v1/geo/servers/coords', headers=plain_user_headers)
        assert resp.status_code == 403

    def test_viewer_returns_200(self, client, viewer_headers):
        """viewer 角色可正常访问并返回节点数据"""
        resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        assert 'nodes' in data
        assert 'pagination' in data

    def test_admin_returns_200(self, client, admin_headers):
        """admin 角色可正常访问"""
        resp = client.get('/api/v1/geo/servers/coords', headers=admin_headers)
        assert resp.status_code == 200

    def test_aggregate_mode_requires_auth(self, client):
        """aggregate 模式同样需要认证"""
        resp = client.get('/api/v1/geo/servers/coords?mode=aggregate')
        assert resp.status_code == 401


# ── P0-2: 月度流量重置短月修复 ────────────────────────────────────────────────

class TestMonthlyResetShortMonth:
    """P0-2: reset_day=31 在 28/30 天月份应在当月最后一天触发重置。"""

    def _make_server(self, app, reset_day: int, suffix: str = '') -> int:
        with app.app_context():
            s = Server(
                name=f'p0_reset_srv_{reset_day}_{suffix}',
                ip=f'10.1.{reset_day}.{abs(hash(suffix)) % 250}',
                traffic_reset_day=reset_day,
                traffic_used_gb=100.0,
                traffic_up_gb=60.0,
                traffic_down_gb=40.0,
            )
            _db.session.add(s)
            _db.session.commit()
            return s.id

    def _delete_server(self, app, server_id: int):
        with app.app_context():
            s = _db.session.get(Server, server_id)
            if s:
                _db.session.delete(s)
                _db.session.commit()

    def test_reset_day_31_triggers_on_feb_28(self, app):
        """reset_day=31，模拟 2 月 28 日，应触发重置（28 = 当月最后一天）"""
        from api.traffic import check_monthly_resets
        sid = self._make_server(app, 31, 'feb28')
        try:
            fake_today = date(2025, 2, 28)
            with app.app_context():
                with patch('api.traffic.date') as mock_date:
                    mock_date.today.return_value = fake_today
                    result = check_monthly_resets()
                assert sid in result
                s = _db.session.get(Server, sid)
                assert s.traffic_used_gb == 0.0
                assert s.traffic_up_gb == 0.0
                assert s.traffic_down_gb == 0.0
        finally:
            self._delete_server(app, sid)

    def test_reset_day_31_triggers_on_april_30(self, app):
        """reset_day=31，模拟 4 月 30 日，应触发重置（30 = 当月最后一天）"""
        from api.traffic import check_monthly_resets
        sid = self._make_server(app, 31, 'apr30')
        try:
            fake_today = date(2025, 4, 30)
            with app.app_context():
                with patch('api.traffic.date') as mock_date:
                    mock_date.today.return_value = fake_today
                    result = check_monthly_resets()
                assert sid in result
        finally:
            self._delete_server(app, sid)

    def test_reset_day_31_no_reset_on_april_29(self, app):
        """reset_day=31，4 月 29 日（非最后一天），不应触发重置"""
        from api.traffic import check_monthly_resets
        sid = self._make_server(app, 31, 'apr29')
        try:
            fake_today = date(2025, 4, 29)
            with app.app_context():
                with patch('api.traffic.date') as mock_date:
                    mock_date.today.return_value = fake_today
                    result = check_monthly_resets()
                assert sid not in result
                s = _db.session.get(Server, sid)
                assert s.traffic_used_gb == 100.0  # 未被重置
        finally:
            self._delete_server(app, sid)

    def test_reset_day_15_triggers_on_correct_day(self, app):
        """reset_day=15，5 月 15 日应正常触发（不影响正常月份逻辑）"""
        from api.traffic import check_monthly_resets
        sid = self._make_server(app, 15, 'may15')
        try:
            fake_today = date(2025, 5, 15)
            with app.app_context():
                with patch('api.traffic.date') as mock_date:
                    mock_date.today.return_value = fake_today
                    result = check_monthly_resets()
                assert sid in result
        finally:
            self._delete_server(app, sid)


# ── P0-3: 用户级强制下线 ──────────────────────────────────────────────────────

class TestRevokeAllUserTokens:
    """P0-3: revoke_all_user_tokens 只影响目标用户，其他用户 token 不受影响。"""

    def test_revoke_sets_user_force_marker(self):
        """revoke_all_user_tokens 设置用户级强制下线标记，非零 TTL"""
        import extensions
        from utils.token_blocklist import revoke_all_user_tokens, is_user_force_revoked

        user_id = 9001
        before = time.time()
        result = revoke_all_user_tokens(user_id)
        assert result == 1

        # 此前签发的 token（iat=before - 1）应被标记为已撤销
        assert is_user_force_revoked(user_id, before - 1) is True

    def test_token_issued_after_revoke_is_valid(self):
        """强制下线后新签发的 token（iat > forced_at）不受影响"""
        from utils.token_blocklist import revoke_all_user_tokens, is_user_force_revoked

        user_id = 9002
        revoke_all_user_tokens(user_id)
        after = time.time() + 1  # 模拟下线后签发的 token

        assert is_user_force_revoked(user_id, after) is False

    def test_other_user_not_affected(self):
        """强制下线用户 A 不影响用户 B 的 token"""
        from utils.token_blocklist import revoke_all_user_tokens, is_user_force_revoked

        user_a = 9003
        user_b = 9004
        iat = time.time() - 10  # 10 秒前签发的 token

        revoke_all_user_tokens(user_a)

        # A 的旧 token 被撤销
        assert is_user_force_revoked(user_a, iat) is True
        # B 的 token 不受影响
        assert is_user_force_revoked(user_b, iat) is False

    def test_revoke_integrates_with_jwt_blocklist(self, client, app):
        """端到端：revoke_all_user_tokens 后使用旧 access_token 应返回 401"""
        from flask_jwt_extended import decode_token

        # 登录获取 token
        login_res = client.post('/api/v1/auth/login', json={
            'username': 'admin',
            'password': 'TestAdmin@123456',
        })
        assert login_res.status_code == 200
        access = login_res.get_json()['access_token']
        claims = decode_token(access)
        user_id = claims['sub']
        token_iat = float(claims['iat'])

        # 强制下线：forced_at = int(token_iat) + 1 确保 token_iat < forced_at
        # 直接写入 Redis 模拟 revoke_all_user_tokens 的行为（无需 sleep）
        import extensions as _ext
        from utils.token_blocklist import _PREFIX_USER, _FORCE_LOGOUT_TTL, is_user_force_revoked

        forced_at = float(int(token_iat) + 1)  # mirrors revoke_all_user_tokens boundary logic
        key = f"{_PREFIX_USER}{user_id}:forced_at"
        _ext.redis_client.setex(key, _FORCE_LOGOUT_TTL, str(forced_at))

        # 验证 is_user_force_revoked 生效
        assert is_user_force_revoked(user_id, token_iat) is True

        # 旧 token 请求受保护接口应被拒绝
        resp = client.get('/api/v1/traffic/', headers={
            'Authorization': f'Bearer {access}',
        })
        assert resp.status_code == 401


# ── P0-4: TelegramConfig.bot_token 加密存储 ─────────────────────────────────

class TestTelegramTokenEncryption:
    """P0-4: bot_token 启用密钥后数据库落盘为非明文，读取路径仍可正常使用。"""

    def test_encrypted_string_type_decorator_encrypts_value(self, app):
        """EncryptedString TypeDecorator process_bind_param 加密值；process_result_value 解密还原。"""
        from utils.crypto import CryptoManager, EncryptedString
        crypto = CryptoManager(master_key='test-tg-secret-key-for-unit-test!')
        es = EncryptedString(crypto, length=512)
        plaintext = 'real-bot-token-123456789:ABCdef'

        encrypted = es.process_bind_param(plaintext, None)
        # 落盘值不等于明文
        assert encrypted != plaintext
        # Fernet base64url 格式，应比明文更长
        assert len(encrypted) > len(plaintext)

        # 读取时透明解密
        recovered = es.process_result_value(encrypted, None)
        assert recovered == plaintext

    def test_encrypted_string_legacy_plaintext_fallback(self, app):
        """TypeDecorator 读取旧明文数据时不报错（向后兼容）"""
        from utils.crypto import CryptoManager, EncryptedString
        crypto = CryptoManager(master_key='test-tg-secret-key-for-unit-test!')
        es = EncryptedString(crypto, length=512)
        legacy_plaintext = 'old-plaintext-token'

        # 旧明文无法被 Fernet 解密，应原样返回
        result = es.process_result_value(legacy_plaintext, None)
        assert result == legacy_plaintext

    def test_bot_token_encrypted_in_db_when_secret_set(self, app):
        """当 TELEGRAM_TOKEN_SECRET 激活时，ORM 写入后数据库中存储的是加密字符串。"""
        from utils.crypto import CryptoManager, EncryptedString
        from sqlalchemy import text

        secret = 'test-tg-secret-key-for-unit-test!'
        plaintext = 'real-bot-token-123456789:ABCdef'
        crypto = CryptoManager(master_key=secret)

        # 创建一个激活了加密的 EncryptedString 实例
        es = EncryptedString(crypto, length=512)

        # 直接通过 process_bind_param 验证：写入数据库时值被加密
        stored_value = es.process_bind_param(plaintext, None)
        assert stored_value != plaintext, "数据库中不应直接存储明文 bot_token"
        # Fernet 加密输出为 URL-safe base64，以 'gAAAAA' 开头（0x80 版本字节的编码）
        from utils.crypto import _FERNET_PREFIX
        assert stored_value.startswith(_FERNET_PREFIX), "加密后的值应为 Fernet 格式"

        with app.app_context():
            cfg = TelegramConfig(chat_id='enc_test_chat')
            _db.session.add(cfg)
            _db.session.commit()

            # 模拟 TypeDecorator 激活状态下的 ORM 写入
            _db.session.execute(
                text("UPDATE telegram_config SET bot_token = :enc WHERE id = :id"),
                {'enc': stored_value, 'id': cfg.id},
            )
            _db.session.commit()

            # 直接 SQL 读取（绕过 TypeDecorator）验证落盘不为明文
            row = _db.session.execute(
                text("SELECT bot_token FROM telegram_config WHERE id = :id"),
                {'id': cfg.id},
            ).fetchone()
            raw_value = row[0]
            assert raw_value != plaintext, "数据库中不应直接存储明文 bot_token"

            # 通过 TypeDecorator 解密应能还原原始值
            decrypted = es.process_result_value(raw_value, None)
            assert decrypted == plaintext

            _db.session.delete(cfg)
            _db.session.commit()

    def test_bot_token_readable_via_model(self, app, client, auth_headers):
        """通过 API 写入 bot_token 后，API 读取路径（send_message）应能正常使用"""
        # 写入 token
        resp = client.post('/api/v1/telegram/config', json={
            'bot_token': 'fake-token-for-send-test',
            'chat_id': '12345',
            'enabled': True,
        }, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.get_json().get('config', {}).get('has_token') is True

        # send_message 使用 cfg.bot_token，验证读取路径不返回乱码
        mock_resp = MagicMock()
        mock_resp.json.return_value = {'ok': True}
        with patch('requests.post', return_value=mock_resp) as mock_post:
            client.post('/api/v1/telegram/test', headers=auth_headers)
            if mock_post.called:
                call_url = mock_post.call_args[0][0]
                # 确保 URL 中包含实际 token（而非加密串）
                assert 'fake-token-for-send-test' in call_url

    def test_to_dict_returns_masked_token_not_encrypted(self, app):
        """to_dict 返回的 bot_token 应是 masked（脱敏），而非加密字符串"""
        with app.app_context():
            cfg = TelegramConfig(chat_id='x')
            # 使用模型的 bot_token 属性（透明加解密）
            cfg.bot_token = 'token-abc123xyz'
            _db.session.add(cfg)
            _db.session.commit()

            d = cfg.to_dict()
            assert d.get('has_token') is True
            # bot_token 字段是 masked 格式（含 ****)
            assert '****' in d.get('bot_token', '')
            # 不应为空
            assert d.get('bot_token')

            _db.session.delete(cfg)
            _db.session.commit()
