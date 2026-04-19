"""认证 API 测试（登录/刷新/登出/改密/注册/邮箱验证/重置密码）。"""

from datetime import datetime, timedelta, timezone

from extensions import db
from models.auth_tokens import EmailVerification, PasswordResetToken
from models.models import User


class TestLogin:
    def test_login_success(self, client):
        res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
        assert res.status_code == 200
        body = res.get_json()
        assert 'access_token' in body
        assert 'refresh_token' in body

    def test_login_wrong_password(self, client):
        res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'wrong'})
        assert res.status_code == 401

    def test_login_missing_fields(self, client):
        res = client.post('/api/v1/auth/login', json={'username': 'admin'})
        assert res.status_code == 400


class TestRefresh:
    def test_refresh_success(self, client):
        login_res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
        refresh_token = login_res.get_json()['refresh_token']
        res = client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {refresh_token}'})
        assert res.status_code == 200
        assert 'access_token' in res.get_json()

    def test_refresh_old_token_rejected_after_rotation(self, client):
        login_res = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
        old_refresh = login_res.get_json()['refresh_token']
        assert client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {old_refresh}'}).status_code == 200
        assert client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {old_refresh}'}).status_code == 401


class TestLogoutAndPassword:
    def test_logout_revokes_access_token(self, client, auth_headers):
        assert client.post('/api/v1/auth/logout', headers=auth_headers).status_code == 200
        assert client.get('/api/v1/servers/', headers=auth_headers).status_code == 401

    def test_change_password_success(self, client, auth_headers):
        new_password = 'NewPass@789xyz!'
        res = client.post('/api/v1/auth/change-password', headers=auth_headers, json={
            'old_password': 'Password@123456',
            'new_password': new_password,
        })
        assert res.status_code == 200

        login_res = client.post('/api/v1/auth/login', json={'username': 'testuser', 'password': new_password})
        assert login_res.status_code == 200

    def test_change_password_wrong_old_password(self, client, auth_headers):
        res = client.post('/api/v1/auth/change-password', headers=auth_headers, json={
            'old_password': 'bad-old',
            'new_password': 'StrongPass@1234!'
        })
        assert res.status_code == 400


class TestSignupAndVerification:
    def test_signup_success_and_create_verification_token(self, app, client, monkeypatch):
        monkeypatch.setattr('api.auth.send_verification_email', lambda *args, **kwargs: True)

        res = client.post('/api/v1/auth/signup', json={
            'username': 'new_user',
            'email': 'new_user@example.com',
            'password': 'StrongPass@1234!',
        })
        assert res.status_code == 201

        with app.app_context():
            user = User.query.filter_by(username='new_user').first()
            assert user is not None
            assert user.email == 'new_user@example.com'
            assert user.email_verified is False

            token_obj = EmailVerification.query.filter_by(user_id=user.id, verified=False).first()
            assert token_obj is not None
            assert token_obj.email == 'new_user@example.com'

    def test_verify_email_success(self, app, client, monkeypatch):
        with app.app_context():
            user = User(
                username='verify_user',
                email='verify@example.com',
                password_hash='hashed-placeholder',
                role='user',
                email_verified=False,
            )
            db.session.add(user)
            db.session.flush()
            ev = EmailVerification.create_for(user.id, user.email, ttl_hours=24)
            db.session.commit()
            token = ev.token

        monkeypatch.setattr('api.auth.send_welcome_email', lambda *args, **kwargs: True)
        res = client.get(f'/api/v1/auth/verify-email?token={token}')
        assert res.status_code == 200

        with app.app_context():
            user = User.query.filter_by(username='verify_user').first()
            ev = EmailVerification.query.filter_by(user_id=user.id).first()
            assert user.email_verified is True
            assert ev.verified is True

    def test_verify_email_expired_token(self, app, client):
        with app.app_context():
            user = User(
                username='expired_verify_user',
                email='expired_verify@example.com',
                password_hash='hashed-placeholder',
                role='user',
                email_verified=False,
            )
            db.session.add(user)
            db.session.flush()
            ev = EmailVerification.create_for(user.id, user.email, ttl_hours=24)
            ev.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
            db.session.commit()
            token = ev.token

        res = client.get(f'/api/v1/auth/verify-email?token={token}')
        assert res.status_code == 400


class TestPasswordReset:
    def test_request_password_reset_success_with_new_path(self, app, client, monkeypatch):
        with app.app_context():
            user = User(
                username='reset_user',
                email='reset@example.com',
                password_hash='hashed-placeholder',
                role='user',
                email_verified=True,
            )
            db.session.add(user)
            db.session.commit()
            user_id = user.id

        monkeypatch.setattr('api.auth.send_password_reset_email', lambda *args, **kwargs: True)
        res = client.post('/api/v1/auth/request-password-reset', json={'email': 'reset@example.com'})
        assert res.status_code == 200

        with app.app_context():
            token_obj = PasswordResetToken.query.filter_by(user_id=user_id, used=False).first()
            assert token_obj is not None

    def test_request_password_reset_success_with_legacy_path(self, app, client, monkeypatch):
        with app.app_context():
            user = User(
                username='legacy_reset_user',
                email='legacy_reset@example.com',
                password_hash='hashed-placeholder',
                role='user',
                email_verified=True,
            )
            db.session.add(user)
            db.session.commit()

        monkeypatch.setattr('api.auth.send_password_reset_email', lambda *args, **kwargs: True)
        res = client.post('/api/v1/auth/forgot-password', json={'email': 'legacy_reset@example.com'})
        assert res.status_code == 200

    def test_reset_password_success_and_token_consumed(self, app, client):
        from werkzeug.security import generate_password_hash, check_password_hash

        with app.app_context():
            user = User(
                username='do_reset_user',
                email='do_reset@example.com',
                password_hash=generate_password_hash('OldStrongPass@1234!'),
                role='user',
                email_verified=True,
            )
            db.session.add(user)
            db.session.flush()
            token_obj = PasswordResetToken.create_for(user.id, ttl_hours=1)
            db.session.commit()
            token = token_obj.token

        res = client.post('/api/v1/auth/reset-password', json={
            'token': token,
            'new_password': 'NewStrongPass@5678!',
        })
        assert res.status_code == 200

        with app.app_context():
            user = User.query.filter_by(username='do_reset_user').first()
            token_obj = PasswordResetToken.query.filter_by(user_id=user.id).first()
            assert token_obj.used is True
            assert check_password_hash(user.password_hash, 'NewStrongPass@5678!')
