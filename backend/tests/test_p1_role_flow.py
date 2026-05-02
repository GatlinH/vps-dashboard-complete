"""
P1-1 / P1-4 回归测试 — 角色流与 RBAC 修复

P1-1: user 角色在系统中的语义已明确（无后台访问权限；须由 admin 提升为 viewer 后方可访问只读接口）
P1-4: 管理员可通过 PATCH /api/v1/auth/users/<id>/role 将用户提升为 viewer 或降级为 user

修复策略（方案 A - 保守）：
  - 注册默认角色仍为 "user"（不改变注册行为，符合现有测试预期）
  - 新增管理员专用角色分配接口，仅允许分配 viewer / user，禁止分配 admin
  - user 角色语义：待审核状态，无后台只读权限，须 admin 审核后提升

权限矩阵（不变）：
  admin  → 可访问写接口 + 所有只读后台接口
  viewer → 不可访问写接口（403） + 可访问只读后台接口
  user   → 不可访问任何受保护后台接口（403）
  未登录  → 受保护接口返回 401
"""
import pytest
from werkzeug.security import generate_password_hash
from models.models import User
from extensions import db as _db


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def plain_user(app):
    """创建普通 user 角色测试用户，测试后自动清理。"""
    with app.app_context():
        user = User(
            username="p1_plain_user",
            email="p1_plain@example.com",
            password_hash=generate_password_hash("PlainPass@123456"),
            role="user",
            email_verified=True,
        )
        _db.session.add(user)
        _db.session.commit()
        _db.session.refresh(user)
        uid = user.id
    yield uid
    with app.app_context():
        u = _db.session.get(User, uid)
        if u:
            _db.session.delete(u)
            _db.session.commit()


@pytest.fixture
def viewer_user(app):
    """创建 viewer 角色测试用户，测试后自动清理。"""
    with app.app_context():
        user = User(
            username="p1_viewer_user",
            email="p1_viewer@example.com",
            password_hash=generate_password_hash("ViewerPass@123456"),
            role="viewer",
            email_verified=True,
        )
        _db.session.add(user)
        _db.session.commit()
        _db.session.refresh(user)
        uid = user.id
    yield uid
    with app.app_context():
        u = _db.session.get(User, uid)
        if u:
            _db.session.delete(u)
            _db.session.commit()


def _login(client, username, password):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, f"登录失败: {resp.get_json()}"
    return {"Authorization": f"Bearer {resp.get_json()['access_token']}"}


@pytest.fixture
def admin_headers(client):
    return _login(client, "admin", "TestAdmin@123456")


@pytest.fixture
def plain_headers(client, plain_user):
    return _login(client, "p1_plain_user", "PlainPass@123456")


# ═══════════════════════════════════════════════════════════════════════════════
# 1. 注册用户角色行为
# ═══════════════════════════════════════════════════════════════════════════════

class TestRegisteredUserRoleBehavior:
    """注册后用户角色为 user，无后台访问权限（P1-1 明确语义）。"""

    def test_signup_default_role_is_user(self, app, client, monkeypatch):
        """注册接口产生的用户角色应为 user，不受客户端 payload 中 role 字段影响。"""
        monkeypatch.setattr("api.auth.send_verification_email", lambda *a, **kw: True)
        resp = client.post(
            "/api/v1/auth/signup",
            json={
                "username": "p1_signup_role_test",
                "email": "p1_signup_role@example.com",
                "password": "StrongPass1@RoleTest!",
            },
        )
        assert resp.status_code == 201

        with app.app_context():
            u = User.query.filter_by(username="p1_signup_role_test").first()
            assert u is not None
            assert u.role == "user", (
                f"注册用户角色应为 'user'，实际为 '{u.role}'"
            )
            _db.session.delete(u)
            _db.session.commit()

    def test_user_role_cannot_access_viewer_endpoints(self, client, plain_headers):
        """user 角色不可访问 viewer_or_admin_required 端点（应返回 403）。"""
        resp = client.get("/api/v1/audit/", headers=plain_headers)
        assert resp.status_code == 403, (
            f"user 角色访问 /audit/ 应被拒绝（403），实际: {resp.status_code}"
        )

    def test_user_role_cannot_access_admin_endpoints(self, client, plain_headers):
        """user 角色不可访问 admin_required 端点（应返回 403）。"""
        resp = client.post(
            "/api/v1/servers/",
            json={"name": "P1 Test Server", "ip": "10.0.0.1"},
            headers=plain_headers,
        )
        assert resp.status_code == 403, (
            f"user 角色访问写接口应被拒绝（403），实际: {resp.status_code}"
        )

    def test_unauthenticated_user_list_returns_401(self, client):
        """未认证时访问用户列表接口应返回 401。"""
        resp = client.get("/api/v1/auth/users")
        assert resp.status_code == 401


# ═══════════════════════════════════════════════════════════════════════════════
# 2. 管理员用户列表接口
# ═══════════════════════════════════════════════════════════════════════════════

class TestAdminListUsers:
    """GET /api/v1/auth/users 用户列表接口（仅 admin）。"""

    def test_admin_can_list_users(self, client, admin_headers, plain_user):
        resp = client.get("/api/v1/auth/users", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        assert "users" in data
        assert "count" in data
        assert data["count"] >= 1

    def test_admin_can_filter_users_by_role(self, client, admin_headers, plain_user):
        resp = client.get("/api/v1/auth/users?role=user", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.get_json()
        for u in data["users"]:
            assert u["role"] == "user", (
                f"按 role=user 过滤后不应出现其他角色，实际: {u['role']}"
            )

    def test_plain_user_cannot_list_users(self, client, plain_headers):
        """user 角色不可访问用户列表接口（403）。"""
        resp = client.get("/api/v1/auth/users", headers=plain_headers)
        assert resp.status_code == 403

    def test_unauthenticated_cannot_list_users(self, client):
        resp = client.get("/api/v1/auth/users")
        assert resp.status_code == 401


# ═══════════════════════════════════════════════════════════════════════════════
# 3. 管理员角色分配接口
# ═══════════════════════════════════════════════════════════════════════════════

class TestAdminRoleAssignment:
    """PATCH /api/v1/auth/users/<id>/role 角色分配接口（P1-4 修复）。"""

    def test_admin_can_promote_user_to_viewer(self, app, client, admin_headers, plain_user):
        """admin 应能将 user 提升为 viewer。"""
        resp = client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "viewer"},
            headers=admin_headers,
        )
        assert resp.status_code == 200, f"提升 viewer 失败: {resp.get_json()}"
        data = resp.get_json()
        assert data["user"]["role"] == "viewer"

        with app.app_context():
            u = _db.session.get(User, plain_user)
            assert u.role == "viewer", "数据库中角色应已变更为 viewer"

    def test_admin_can_demote_viewer_to_user(self, app, client, admin_headers, viewer_user):
        """admin 应能将 viewer 降级回 user。"""
        resp = client.patch(
            f"/api/v1/auth/users/{viewer_user}/role",
            json={"role": "user"},
            headers=admin_headers,
        )
        assert resp.status_code == 200, f"降级 user 失败: {resp.get_json()}"
        assert resp.get_json()["user"]["role"] == "user"

    def test_admin_cannot_assign_admin_role(self, client, admin_headers, plain_user):
        """admin 不可通过此接口将用户提升为 admin（防止越权）。"""
        resp = client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "admin"},
            headers=admin_headers,
        )
        assert resp.status_code == 400, (
            f"分配 admin 角色应被拒绝（400），实际: {resp.status_code}"
        )

    def test_invalid_role_value_rejected(self, client, admin_headers, plain_user):
        """非法角色值应被拒绝（400）。"""
        resp = client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "superuser"},
            headers=admin_headers,
        )
        assert resp.status_code == 400

    def test_missing_role_field_rejected(self, client, admin_headers, plain_user):
        """缺少 role 字段时应返回 400。"""
        resp = client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={},
            headers=admin_headers,
        )
        assert resp.status_code == 400

    def test_nonexistent_user_returns_404(self, client, admin_headers):
        """目标用户不存在时应返回 404。"""
        resp = client.patch(
            "/api/v1/auth/users/999999/role",
            json={"role": "viewer"},
            headers=admin_headers,
        )
        assert resp.status_code == 404

    def test_cannot_change_admin_user_role(self, app, client, admin_headers):
        """admin 账户的角色不可通过此接口修改（防止误操作锁死管理员）。"""
        with app.app_context():
            admin_user = User.query.filter_by(username="admin").first()
            assert admin_user is not None
            admin_id = admin_user.id

        resp = client.patch(
            f"/api/v1/auth/users/{admin_id}/role",
            json={"role": "viewer"},
            headers=admin_headers,
        )
        assert resp.status_code == 403, (
            f"修改 admin 账户角色应被拒绝（403），实际: {resp.status_code}"
        )

    def test_plain_user_cannot_assign_roles(self, client, plain_headers, viewer_user):
        """普通 user 不可调用角色分配接口（403）。"""
        resp = client.patch(
            f"/api/v1/auth/users/{viewer_user}/role",
            json={"role": "user"},
            headers=plain_headers,
        )
        assert resp.status_code == 403

    def test_unauthenticated_cannot_assign_roles(self, client, plain_user):
        resp = client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "viewer"},
        )
        assert resp.status_code == 401


# ═══════════════════════════════════════════════════════════════════════════════
# 4. 提升后的 viewer 权限闭环验证（P1-1 核心修复路径）
# ═══════════════════════════════════════════════════════════════════════════════

class TestViewerPermissionAfterPromotion:
    """admin 提升用户为 viewer 后，新 viewer 应能访问只读后台接口。"""

    def test_promoted_viewer_can_access_audit_logs(
        self, app, client, admin_headers, plain_user
    ):
        """
        完整路径：user 注册 → admin 提升为 viewer → viewer 获得新 token → 访问只读接口
        """
        # 1. 提升为 viewer
        promote_resp = client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "viewer"},
            headers=admin_headers,
        )
        assert promote_resp.status_code == 200

        # 2. 重新登录以获取携带新角色的 JWT
        new_headers = _login(client, "p1_plain_user", "PlainPass@123456")

        # 3. viewer 应能访问 viewer_or_admin_required 端点
        audit_resp = client.get("/api/v1/audit/", headers=new_headers)
        assert audit_resp.status_code == 200, (
            f"提升为 viewer 后应能访问 /audit/，实际: {audit_resp.status_code}"
        )

    def test_promoted_viewer_still_cannot_write(
        self, app, client, admin_headers, plain_user
    ):
        """提升为 viewer 后仍不能访问 admin_required 写接口（403）。"""
        # 提升为 viewer
        client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "viewer"},
            headers=admin_headers,
        )

        # 重新登录
        new_headers = _login(client, "p1_plain_user", "PlainPass@123456")

        # viewer 尝试写操作仍应被拒绝
        write_resp = client.post(
            "/api/v1/servers/",
            json={"name": "Viewer Write Attempt", "ip": "10.0.0.2"},
            headers=new_headers,
        )
        assert write_resp.status_code == 403, (
            f"viewer 访问写接口应返回 403，实际: {write_resp.status_code}"
        )

    def test_demoted_viewer_loses_access(
        self, app, client, admin_headers, plain_user
    ):
        """viewer 被降级回 user 后，重新登录获得的新 token 不再有只读权限。"""
        # 先提升为 viewer
        client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "viewer"},
            headers=admin_headers,
        )

        # 降级回 user
        client.patch(
            f"/api/v1/auth/users/{plain_user}/role",
            json={"role": "user"},
            headers=admin_headers,
        )

        # 重新登录，应获得 user 角色的 token
        new_headers = _login(client, "p1_plain_user", "PlainPass@123456")

        # user 再次无法访问只读后台接口
        audit_resp = client.get("/api/v1/audit/", headers=new_headers)
        assert audit_resp.status_code == 403, (
            f"降级后访问 /audit/ 应返回 403，实际: {audit_resp.status_code}"
        )
