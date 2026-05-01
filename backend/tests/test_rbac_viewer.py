"""
RBAC viewer 角色测试 — 覆盖 P2 "多用户权限体系" 中 viewer 只读角色的权限边界。

权限矩阵：
  admin  → 可访问写接口 + 所有只读后台接口
  viewer → 不可访问写接口（403） + 可访问只读后台接口
  user   → 不可访问任何受保护后台接口（403）
  未登录  → 受保护接口返回 401
"""
import pytest
from werkzeug.security import generate_password_hash
from models.models import User, Server
from extensions import db as _db


# ── fixtures ──────────────────────────────────────────────────────────────────


@pytest.fixture
def viewer_user(app):
    """创建 viewer 角色用户，每次测试后自动清理。"""
    with app.app_context():
        user = User(
            username="rbac_viewer",
            email="rbac_viewer@example.com",
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


@pytest.fixture
def plain_user(app):
    """创建普通 user 角色用户（非 admin / 非 viewer）。"""
    with app.app_context():
        user = User(
            username="rbac_plain",
            email="rbac_plain@example.com",
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


def _login(client, username, password):
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, f"登录失败: {resp.get_json()}"
    return {"Authorization": f"Bearer {resp.get_json()['access_token']}"}


@pytest.fixture
def viewer_headers(client, viewer_user):
    return _login(client, "rbac_viewer", "ViewerPass@123456")


@pytest.fixture
def plain_headers(client, plain_user):
    return _login(client, "rbac_plain", "PlainPass@123456")


@pytest.fixture
def admin_headers(client):
    """使用 conftest 创建的全局 admin 用户。"""
    return _login(client, "admin", "TestAdmin@123456")


@pytest.fixture
def sample_server(app):
    """创建用于测试的服务器，返回其 ID。"""
    with app.app_context():
        s = Server(
            name="RBAC Test Server",
            group_name="Test",
            ip="10.10.10.1",
            cpu_cores=2,
            ram_gb=4.0,
            disk_gb=50,
            status="online",
        )
        _db.session.add(s)
        _db.session.commit()
        sid = s.id
    yield sid
    with app.app_context():
        server = _db.session.get(Server, sid)
        if server:
            _db.session.delete(server)
            _db.session.commit()


# ── 1. admin 可访问写接口 ──────────────────────────────────────────────────────


class TestAdminWriteAccess:
    """admin 角色对写接口的访问应始终返回 2xx（不含业务逻辑错误）。"""

    def test_admin_can_create_server(self, client, admin_headers):
        resp = client.post(
            "/api/v1/servers/",
            json={
                "name": "Admin Write Test",
                "ip": "192.0.2.1",
            },
            headers=admin_headers,
        )
        assert resp.status_code in (200, 201), (
            f"admin 应能创建服务器，实际状态码: {resp.status_code}"
        )

    def test_admin_can_access_audit_logs(self, client, admin_headers):
        resp = client.get("/api/v1/audit/", headers=admin_headers)
        assert resp.status_code == 200

    def test_admin_can_access_server_history(self, client, admin_headers, sample_server):
        resp = client.get(
            f"/api/v1/servers/{sample_server}/history", headers=admin_headers
        )
        assert resp.status_code == 200

    def test_admin_can_access_telegram_alerts(self, client, admin_headers):
        resp = client.get("/api/v1/telegram/alerts", headers=admin_headers)
        assert resp.status_code == 200


# ── 2. viewer 不可访问写接口 ──────────────────────────────────────────────────


class TestViewerWriteDenied:
    """viewer 角色尝试访问写接口应得到 403。"""

    def test_viewer_cannot_create_server(self, client, viewer_headers):
        resp = client.post(
            "/api/v1/servers/",
            json={"name": "Viewer Write Attempt", "ip": "192.0.2.2"},
            headers=viewer_headers,
        )
        assert resp.status_code == 403, (
            f"viewer 不应能创建服务器，实际状态码: {resp.status_code}"
        )

    def test_viewer_cannot_update_server(self, client, viewer_headers, sample_server):
        resp = client.put(
            f"/api/v1/servers/{sample_server}",
            json={"name": "Viewer Update Attempt"},
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_delete_server(self, client, viewer_headers, sample_server):
        resp = client.delete(
            f"/api/v1/servers/{sample_server}",
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_push_metrics(self, client, viewer_headers, sample_server):
        resp = client.post(
            f"/api/v1/servers/{sample_server}/metrics",
            json={"cpu_use": 50.0},
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_save_telegram_config(self, client, viewer_headers):
        resp = client.post(
            "/api/v1/telegram/config",
            json={"bot_token": "fake", "chat_id": "123"},
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_trigger_alert(self, client, viewer_headers):
        resp = client.post(
            "/api/v1/telegram/alert/fire",
            json={"server_id": 1, "rule_type": "cpu"},
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_save_alert_rules(self, client, viewer_headers):
        resp = client.post(
            "/api/v1/telegram/alerts",
            json={"rules": []},
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_generate_agent_key(self, client, viewer_headers, sample_server):
        resp = client.post(
            f"/api/v1/servers/{sample_server}/agent-key/generate",
            headers=viewer_headers,
        )
        assert resp.status_code == 403

    def test_viewer_cannot_probe_ping(self, client, viewer_headers):
        resp = client.post(
            "/api/v1/probe/ping",
            json={"host": "127.0.0.1", "port": 80, "count": 1},
            headers=viewer_headers,
        )
        assert resp.status_code == 403


# ── 3. viewer 可访问只读后台接口 ──────────────────────────────────────────────


class TestViewerReadAccess:
    """viewer 角色对允许的只读后台接口应返回 200。"""

    def test_viewer_can_access_audit_logs(self, client, viewer_headers):
        resp = client.get("/api/v1/audit/", headers=viewer_headers)
        assert resp.status_code == 200, (
            f"viewer 应能访问审计日志列表，实际状态码: {resp.status_code}"
        )

    def test_viewer_can_access_server_history(self, client, viewer_headers, sample_server):
        resp = client.get(
            f"/api/v1/servers/{sample_server}/history", headers=viewer_headers
        )
        assert resp.status_code == 200, (
            f"viewer 应能访问服务器历史数据，实际状态码: {resp.status_code}"
        )

    def test_viewer_can_list_telegram_alerts(self, client, viewer_headers):
        resp = client.get("/api/v1/telegram/alerts", headers=viewer_headers)
        assert resp.status_code == 200, (
            f"viewer 应能查看告警规则列表，实际状态码: {resp.status_code}"
        )

    def test_viewer_can_list_servers(self, client, viewer_headers):
        resp = client.get("/api/v1/servers/", headers=viewer_headers)
        assert resp.status_code == 200

    def test_viewer_can_get_traffic_summary(self, client, viewer_headers):
        resp = client.get("/api/v1/traffic/", headers=viewer_headers)
        assert resp.status_code == 200

    def test_viewer_can_list_traffic_servers(self, client, viewer_headers):
        resp = client.get("/api/v1/traffic/servers", headers=viewer_headers)
        assert resp.status_code == 200


# ── 4. 未登录用户仍按原有规则处理（401）────────────────────────────────────────


class TestUnauthenticatedAccess:
    """未携带 JWT 的请求在受保护接口上应收到 401。"""

    def test_no_token_denied_audit(self, client):
        resp = client.get("/api/v1/audit/")
        assert resp.status_code == 401

    def test_no_token_denied_server_history(self, client, sample_server):
        resp = client.get(f"/api/v1/servers/{sample_server}/history")
        assert resp.status_code == 401

    def test_no_token_denied_telegram_alerts(self, client):
        resp = client.get("/api/v1/telegram/alerts")
        assert resp.status_code == 401

    def test_no_token_denied_create_server(self, client):
        resp = client.post(
            "/api/v1/servers/", json={"name": "x", "ip": "1.2.3.4"}
        )
        assert resp.status_code == 401


# ── 5. plain user（role=user）对受保护后台接口应得到 403 ──────────────────────


class TestPlainUserDenied:
    """普通 user 角色对 viewer_or_admin_required 接口应得到 403。"""

    def test_user_denied_audit_logs(self, client, plain_headers):
        resp = client.get("/api/v1/audit/", headers=plain_headers)
        assert resp.status_code == 403

    def test_user_denied_server_history(self, client, plain_headers, sample_server):
        resp = client.get(
            f"/api/v1/servers/{sample_server}/history", headers=plain_headers
        )
        assert resp.status_code == 403

    def test_user_denied_telegram_alerts(self, client, plain_headers):
        resp = client.get("/api/v1/telegram/alerts", headers=plain_headers)
        assert resp.status_code == 403


# ── 6. /api/auth/me 返回正确角色 ─────────────────────────────────────────────


class TestMeEndpointRole:
    """GET /api/auth/me 应在 role 字段返回用户的实际角色。"""

    def test_admin_me_returns_admin_role(self, client, admin_headers):
        resp = client.get("/api/v1/auth/me", headers=admin_headers)
        assert resp.status_code == 200
        assert resp.get_json()["user"]["role"] == "admin"

    def test_viewer_me_returns_viewer_role(self, client, viewer_headers):
        resp = client.get("/api/v1/auth/me", headers=viewer_headers)
        assert resp.status_code == 200
        assert resp.get_json()["user"]["role"] == "viewer", (
            "viewer 用户 /me 接口 role 字段应为 'viewer'"
        )

    def test_signup_does_not_create_viewer_role(self, app, client, monkeypatch):
        """signup 接口不应允许客户端直接指定 viewer 角色（与 P0 保持一致）。"""
        monkeypatch.setattr("api.auth.send_verification_email", lambda *a, **kw: True)
        resp = client.post(
            "/api/v1/auth/signup",
            json={
                "username": "rbac_viewer_inject",
                "email": "rbac_viewer_inject@example.com",
                "password": "StrongPass1@Viewer!",
                "role": "viewer",
            },
        )
        assert resp.status_code == 201
        with app.app_context():
            u = User.query.filter_by(username="rbac_viewer_inject").first()
            assert u is not None
            assert u.role == "user", (
                f"signup 不应接受客户端注入的 viewer 角色，注册后应为 'user'，实际为 '{u.role}'"
            )
