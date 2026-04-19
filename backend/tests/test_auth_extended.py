"""认证额外测试：重发验证与重置 token 一次性消费。"""

from extensions import db
from models.auth_tokens import EmailVerification, PasswordResetToken
from models.models import User


def test_resend_verification_is_idempotent_for_unknown_email(client):
    res = client.post('/api/v1/auth/resend-verification', json={'email': 'missing@example.com'})
    assert res.status_code == 200


def test_resend_verification_creates_new_token_for_unverified_user(app, client, monkeypatch):
    with app.app_context():
        user = User(
            username='resend_verify_user',
            email='resend_verify@example.com',
            password_hash='hashed-placeholder',
            role='user',
            email_verified=False,
        )
        db.session.add(user)
        db.session.flush()
        old_token = EmailVerification.create_for(user.id, user.email).token
        db.session.commit()

    monkeypatch.setattr('api.auth.send_verification_email', lambda *args, **kwargs: True)
    res = client.post('/api/v1/auth/resend-verification', json={'email': 'resend_verify@example.com'})
    assert res.status_code == 200

    with app.app_context():
        tokens = EmailVerification.query.filter_by(email='resend_verify@example.com').all()
        assert len(tokens) >= 2
        assert any(t.token != old_token for t in tokens)


def test_reset_password_token_cannot_be_reused(app, client):
    from werkzeug.security import generate_password_hash

    with app.app_context():
        user = User(
            username='reuse_reset_user',
            email='reuse_reset@example.com',
            password_hash=generate_password_hash('OldStrongPass@1234!'),
            role='user',
            email_verified=True,
        )
        db.session.add(user)
        db.session.flush()
        token = PasswordResetToken.create_for(user.id, ttl_hours=1).token
        db.session.commit()

    first = client.post('/api/v1/auth/reset-password', json={
        'token': token,
        'new_password': 'NewStrongPass@5678!',
    })
    assert first.status_code == 200

    second = client.post('/api/v1/auth/reset-password', json={
        'token': token,
        'new_password': 'AnotherStrongPass@91011!',
    })
    assert second.status_code == 400
