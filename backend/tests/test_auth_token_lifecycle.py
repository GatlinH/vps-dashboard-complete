"""认证 Token 生命周期与黑名单策略测试。"""

import time

from flask_jwt_extended import decode_token

import extensions
from utils.token_blocklist import (
    is_access_token_revoked,
    is_refresh_token_revoked,
    revoke_refresh_token,
)


class TestTokenLifecycle:
    def test_refresh_token_rotation_and_blacklist(self, client):
        login_res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert login_res.status_code == 200

        old_refresh = login_res.get_json()['refresh_token']
        old_claims = decode_token(old_refresh)
        old_refresh_jti = old_claims['jti']

        refresh_res = client.post(
            '/api/v1/auth/refresh',
            headers={'Authorization': f'Bearer {old_refresh}'},
        )
        assert refresh_res.status_code == 200

        body = refresh_res.get_json()
        assert 'access_token' in body
        assert 'refresh_token' in body

        # 旧 refresh token 应被吊销，且保留 TTL（用于自动过期）
        assert is_refresh_token_revoked(old_refresh_jti) is True
        assert is_access_token_revoked(old_refresh_jti) is False

        redis_ttl = extensions.redis_client.ttl(f'revoked:refresh:{old_refresh_jti}')
        assert redis_ttl > 0

        # 同一旧 token 不可二次换发
        replay_res = client.post(
            '/api/v1/auth/refresh',
            headers={'Authorization': f'Bearer {old_refresh}'},
        )
        assert replay_res.status_code == 401

    def test_logout_only_revokes_current_access_token(self, client):
        login_res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert login_res.status_code == 200

        access = login_res.get_json()['access_token']
        refresh = login_res.get_json()['refresh_token']

        access_jti = decode_token(access)['jti']
        refresh_jti = decode_token(refresh)['jti']

        logout_res = client.post(
            '/api/v1/auth/logout',
            headers={'Authorization': f'Bearer {access}'},
        )
        assert logout_res.status_code == 200

        assert is_access_token_revoked(access_jti) is True
        assert is_refresh_token_revoked(refresh_jti) is False

    def test_refresh_token_blocklist_entry_expires_with_ttl(self):
        jti = 'refresh-jti-expiry-check'

        revoke_refresh_token(jti, expires_delta=1)
        assert is_refresh_token_revoked(jti) is True

        time.sleep(1.1)
        assert is_refresh_token_revoked(jti) is False
