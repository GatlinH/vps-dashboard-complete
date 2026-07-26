"""M-4 regression: DELETE /api/v1/auth/sessions/<jti> must enforce ownership.

Before the fix, delete_session() removed the Redis session record for any jti
without checking that it belonged to the caller, letting any authenticated user
force-logout another user's session (IDOR / DoS). This test proves a cross-user
delete is rejected while a self delete still works.
"""
import time

from werkzeug.security import generate_password_hash

import extensions
from extensions import db as _db
from models.models import User


def _make_user(username: str) -> int:
    user = User(
        username=username,
        password_hash=generate_password_hash("Password@123456"),
        role="admin",
    )
    _db.session.add(user)
    _db.session.commit()
    return user.id


def _login(client, username: str) -> str:
    resp = client.post("/api/v1/auth/login", json={
        "username": username,
        "password": "Password@123456",
    })
    data = resp.get_json()
    assert "access_token" in data, f"login failed: {data}"
    return data["access_token"]


def _find_session_jti(app, user_id: int) -> str:
    """Return the jti of a stored session belonging to user_id."""
    import json
    with app.app_context():
        for key in extensions.redis_client.scan_iter("auth:session:*"):
            raw = extensions.redis_client.get(key)
            if not raw:
                continue
            item = json.loads(raw)
            if str(item.get("user_id")) == str(user_id):
                return item.get("id") or str(key).rsplit(":", 1)[-1]
    return ""


def test_cross_user_session_delete_is_rejected(app, client):
    with app.app_context():
        uid_a = _make_user("victim_a")
        uid_b = _make_user("attacker_b")

    # Victim A logs in -> a session is stored for A.
    token_a = _login(client, "victim_a")
    jti_a = _find_session_jti(app, uid_a)
    assert jti_a, "victim A session was not stored"

    # Attacker B logs in and tries to delete A's session by jti.
    token_b = _login(client, "attacker_b")
    resp = client.delete(
        f"/api/v1/auth/sessions/{jti_a}",
        headers={"Authorization": f"Bearer {token_b}"},
    )
    assert resp.status_code == 404, (
        f"cross-user session delete must be rejected with 404, got {resp.status_code}"
    )

    # A's session must still exist (was not deleted by B).
    assert _find_session_jti(app, uid_a) == jti_a, (
        "victim A's session was deleted by another user (IDOR not fixed)"
    )


def test_self_session_delete_still_works(app, client):
    """A user can delete their OWN non-current session."""
    import json
    with app.app_context():
        uid = _make_user("selfdel_user")

    # First login creates session 1 (this will be the "other" session).
    token1 = _login(client, "selfdel_user")
    jti1 = _find_session_jti(app, uid)
    assert jti1

    # Second login creates session 2 (current for token2).
    time.sleep(1)  # ensure distinct iat/jti
    token2 = _login(client, "selfdel_user")

    # Using token2, delete session 1 (owned, not current) -> should succeed.
    resp = client.delete(
        f"/api/v1/auth/sessions/{jti1}",
        headers={"Authorization": f"Bearer {token2}"},
    )
    assert resp.status_code == 200, (
        f"self session delete should return 200, got {resp.status_code}: {resp.get_json()}"
    )
