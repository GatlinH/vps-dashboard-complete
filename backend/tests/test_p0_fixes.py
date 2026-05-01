"""
P0 回归测试 — 覆盖审计报告中全部 P0 修复点。

P0-1: 注册用户默认 role 必须是 "user"（原模型 default="admin" 已改为 "user"）
P0-2: signup 接口禁止客户端注入 role 字段（即使提交 role=admin 也应被忽略）
"""

import pytest
from models.models import User


class TestDefaultUserRole:
    """P0-1: 注册用户默认角色为 user，而非 admin。"""

    def test_signup_creates_user_role_not_admin(self, app, client, monkeypatch):
        """正常注册流程创建的用户角色应为 user。"""
        monkeypatch.setattr("api.auth.send_verification_email", lambda *a, **kw: True)

        res = client.post(
            "/api/v1/auth/signup",
            json={
                "username": "p0_test_user",
                "email": "p0_test_user@example.com",
                "password": "StrongPass1@P0Test!",
            },
        )
        assert res.status_code == 201

        with app.app_context():
            user = User.query.filter_by(username="p0_test_user").first()
            assert user is not None
            assert user.role == "user", (
                f"注册用户角色应为 'user'，实际为 '{user.role}'"
            )

    def test_user_model_default_role_is_user(self, app):
        """User 模型的 role 列默认值应为 'user'，防止未显式指定 role 的代码路径意外创建 admin。"""
        with app.app_context():
            from extensions import db

            user = User(
                username="p0_model_default_user",
                email="p0_model_default@example.com",
                password_hash="hashed-placeholder",
                # 不显式设置 role，依赖模型默认值
            )
            db.session.add(user)
            db.session.commit()

            fetched = User.query.filter_by(username="p0_model_default_user").first()
            assert fetched.role == "user", (
                f"User 模型的 role 默认值应为 'user'，实际为 '{fetched.role}'"
            )

            # 清理
            db.session.delete(fetched)
            db.session.commit()


class TestRoleInjectionBlocked:
    """P0-2: signup 接口不接受客户端提交的 role 字段。"""

    def test_signup_ignores_role_admin_in_payload(self, app, client, monkeypatch):
        """即使请求体包含 role=admin，注册后的用户角色应仍为 user。"""
        monkeypatch.setattr("api.auth.send_verification_email", lambda *a, **kw: True)

        res = client.post(
            "/api/v1/auth/signup",
            json={
                "username": "p0_role_inject_user",
                "email": "p0_role_inject@example.com",
                "password": "StrongPass1@Inject!",
                "role": "admin",  # 尝试注入 admin 角色
            },
        )
        assert res.status_code == 201

        with app.app_context():
            user = User.query.filter_by(username="p0_role_inject_user").first()
            assert user is not None
            assert user.role == "user", (
                f"signup 接口不应接受客户端的 role 字段，注册后角色应为 'user'，实际为 '{user.role}'"
            )

    def test_signup_ignores_arbitrary_role_values(self, app, client, monkeypatch):
        """尝试注入任意 role 值（如 superuser）也应被忽略，角色应为 user。"""
        monkeypatch.setattr("api.auth.send_verification_email", lambda *a, **kw: True)

        res = client.post(
            "/api/v1/auth/signup",
            json={
                "username": "p0_superuser_inject",
                "email": "p0_superuser@example.com",
                "password": "StrongPass1@Super!",
                "role": "superuser",
            },
        )
        assert res.status_code == 201

        with app.app_context():
            user = User.query.filter_by(username="p0_superuser_inject").first()
            assert user is not None
            assert user.role == "user"
