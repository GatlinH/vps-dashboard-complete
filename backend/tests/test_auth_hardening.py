"""Security regressions for account profile, feature stubs, and password session revocation."""

from flask_jwt_extended import create_access_token
from werkzeug.security import generate_password_hash

from extensions import db
from models.auth_tokens import PasswordResetToken
from models.models import User
from utils.token_blocklist import is_user_force_revoked


def _headers_for(app, user_id):
    with app.app_context():
        token = create_access_token(identity=str(user_id), additional_claims={"role": "user"})
    return {"Authorization": f"Bearer {token}"}


def _create_user(app, username="hardening_user"):
    with app.app_context():
        user = User(username=username, email=f"{username}@example.test", password_hash=generate_password_hash("Password@123456"), role="user")
        db.session.add(user)
        db.session.commit()
        return user.id


def test_profile_requires_authentication(client):
    response = client.patch("/api/v1/auth/profile", json={"username": "blocked"})
    assert response.status_code == 401


def test_profile_updates_authenticated_user(app, client):
    user_id = _create_user(app, "profile_user")
    response = client.patch("/api/v1/auth/profile", headers=_headers_for(app, user_id), json={"username": "profile_renamed"})
    assert response.status_code == 200
    with app.app_context():
        assert db.session.get(User, user_id).username == "profile_renamed"


def test_unimplemented_account_security_features_require_auth_and_are_explicit(client):
    for method, path in (("get", "/api/v1/auth/2fa/status"), ("post", "/api/v1/auth/2fa/setup"), ("post", "/api/v1/auth/2fa/enable"), ("post", "/api/v1/auth/2fa/disable"), ("get", "/api/v1/auth/external-accounts"), ("delete", "/api/v1/auth/external-accounts/google")):
        response = getattr(client, method)(path, json={} if method == "post" else None)
        assert response.status_code == 401, path


def test_authenticated_unimplemented_account_security_features_return_501(app, client):
    user_id = _create_user(app, "feature_user")
    headers = _headers_for(app, user_id)
    for method, path in (("get", "/api/v1/auth/2fa/status"), ("post", "/api/v1/auth/2fa/setup"), ("post", "/api/v1/auth/2fa/enable"), ("post", "/api/v1/auth/2fa/disable"), ("get", "/api/v1/auth/external-accounts"), ("delete", "/api/v1/auth/external-accounts/google")):
        response = getattr(client, method)(path, headers=headers, json={} if method == "post" else None)
        assert response.status_code == 501, path


def test_change_password_revokes_all_existing_user_tokens(app, client):
    user_id = _create_user(app, "change_revoke_user")
    headers = _headers_for(app, user_id)
    response = client.post("/api/v1/auth/change-password", headers=headers, json={"old_password": "Password@123456", "new_password": "ChangedPassword@789!"})
    assert response.status_code == 200
    with app.app_context():
        assert is_user_force_revoked(user_id, 0) is True


def test_reset_password_revokes_all_existing_user_tokens(app, client):
    user_id = _create_user(app, "reset_revoke_user")
    with app.app_context():
        token = PasswordResetToken.create_for(user_id, ttl_hours=1).token
        db.session.commit()
    response = client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": "ResetPassword@789!"})
    assert response.status_code == 200
    with app.app_context():
        assert is_user_force_revoked(user_id, 0) is True
