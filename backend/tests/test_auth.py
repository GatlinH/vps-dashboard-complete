"""
backend/tests/test_auth.py
认证 API 完整测试

覆盖范围：
  登录   / 刷新 / 登出 / 修改密码
  注册   / 邮箱验证 / 重新发送验证
  忘记密码 / 重置密码
  token 黑名单（refresh token 吊销）

运行：
  pytest backend/tests/test_auth.py -v
"""

import time
import pytest
from unittest.mock import patch, MagicMock
from flask_jwt_extended import decode_token


# ═══════════════════════════════════════════════════════════════════════════════
# 原有测试（保留）
# ═══════════════════════════════════════════════════════════════════════════════

class TestLogin:
    def test_login_success(self, client):
        """管理员登录成功"""
        res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "TestAdmin@123456",
        })
        assert res.status_code == 200
        data = res.get_json()
        assert "access_token"  in data
        assert "refresh_token" in data
        assert data["user"]["username"] == "admin"

    def test_login_wrong_password(self, client):
        """密码错误返回 401"""
        res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "wrongpassword",
        })
        assert res.status_code == 401

    def test_login_missing_fields(self, client):
        """缺少字段返回 400"""
        res = client.post("/api/v1/auth/login", json={"username": "admin"})
        assert res.status_code in (400, 422)

    def test_login_returns_user_info(self, client):
        """登录响应包含用户基本信息"""
        res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "TestAdmin@123456",
        })
        data = res.get_json()
        assert "user" in data
        assert "id"   in data["user"]
        assert "role" in data["user"]

    def test_protected_route_without_token(self, client):
        """无 token 访问受保护路由返回 401"""
        res = client.post("/api/v1/servers/", json={"name": "test"})
        assert res.status_code == 401

    def test_protected_route_with_token(self, client, auth_headers):
        """有效 token 可访问受保护路由"""
        res = client.get("/api/v1/servers/", headers=auth_headers)
        assert res.status_code == 200


class TestRefresh:
    def test_refresh_success(self, client):
        """使用有效 refresh token 换取新 access token"""
        # 先登录
        login_res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "TestAdmin@123456",
        })
        refresh_token = login_res.get_json()["refresh_token"]

        res = client.post(
            "/api/v1/auth/refresh",
            headers={"Authorization": f"Bearer {refresh_token}"},
        )
        assert res.status_code == 200
        data = res.get_json()
        assert "access_token"  in data
        assert "refresh_token" in data

    def test_refresh_with_access_token_fails(self, client, auth_headers):
        """用 access token 调用 refresh 接口应失败"""
        res = client.post("/api/v1/auth/refresh", headers=auth_headers)
        assert res.status_code in (401, 422)

    def test_refresh_token_rotation(self, client):
        """旧 refresh token 使用后应被吊销（rotation）"""
        login_res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "TestAdmin@123456",
        })
        old_refresh = login_res.get_json()["refresh_token"]

        # 第一次刷新
        res1 = client.post(
            "/api/v1/auth/refresh",
            headers={"Authorization": f"Bearer {old_refresh}"},
        )
        assert res1.status_code == 200

        # 用旧 refresh token 再次刷新，应返回 401
        res2 = client.post(
            "/api/v1/auth/refresh",
            headers={"Authorization": f"Bearer {old_refresh}"},
        )
        assert res2.status_code == 401


class TestLogout:
    def test_logout_success(self, client, auth_headers):
        """登出后 access token 应失效"""
        # 登出
        res = client.post("/api/v1/auth/logout", headers=auth_headers)
        assert res.status_code == 200

        # 旧 access token 再访问应 401
        res2 = client.get("/api/v1/servers/", headers=auth_headers)
        assert res2.status_code == 401

    def test_logout_requires_token(self, client):
        """未携带 token 登出应 401"""
        res = client.post("/api/v1/auth/logout")
        assert res.status_code == 401


class TestChangePassword:
    def test_change_password_success(self, client, auth_headers):
        """修改密码成功"""
        res = client.post(
            "/api/v1/auth/change-password",
            headers=auth_headers,
            json={"old_password": "TestAdmin@123456", "new_password": "NewPass@789xyz"},
        )
        assert res.status_code == 200

        # 恢复密码（避免影响其他测试）
        login_res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "NewPass@789xyz",
        })
        new_headers = {"Authorization": f"Bearer {login_res.get_json()['access_token']}"}
        client.post(
            "/api/v1/auth/change-password",
            headers=new_headers,
            json={"old_password": "NewPass@789xyz", "new_password": "TestAdmin@123456"},
        )

    def test_change_password_wrong_old(self, client, auth_headers):
        """原密码错误应返回 400"""
        res = client.post(
            "/api/v1/auth/change-password",
            headers=auth_headers,
            json={"old_password": "wrong", "new_password": "NewPass@789xyz"},
        )
        assert res.status_code == 400

    def test_change_password_weak_new(self, client, auth_headers):
        """弱密码应被拒绝"""
        res = client.post(
            "/api/v1/auth/change-password",
            headers=auth_headers,
            json={"old_password": "TestAdmin@123456", "new_password": "123456"},
        )
        assert res.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════════
# 新增测试：注册
# ═══════════════════════════════════════════════════════════════════════════════

class TestSignup:
    @patch("api.auth.send_verification_email", return_value=True)
    def test_signup_success(self, mock_send, client):
        """正常注册成功，返回 201"""
        res = client.post("/api/v1/auth/signup", json={
            "username": "newuser",
            "email":    "new@example.com",
            "password": "StrongPass@123",
        })
        assert res.status_code == 201
        data = res.get_json()
        assert "注册成功" in data["msg"]
        # 验证邮件应被触发
        mock_send.assert_called_once()

    @patch("api.auth.send_verification_email", return_value=True)
    def test_signup_duplicate_username(self, mock_send, client):
        """用户名重复应返回 409"""
        # 先注册一次
        client.post("/api/v1/auth/signup", json={
            "username": "dupuser",
            "email":    "dup1@example.com",
            "password": "StrongPass@123",
        })
        # 再次注册相同用户名
        res = client.post("/api/v1/auth/signup", json={
            "username": "dupuser",
            "email":    "dup2@example.com",
            "password": "StrongPass@123",
        })
        assert res.status_code == 409
        assert "用户名" in res.get_json()["msg"]

    @patch("api.auth.send_verification_email", return_value=True)
    def test_signup_duplicate_email(self, mock_send, client):
        """邮箱重复应返回 409"""
        client.post("/api/v1/auth/signup", json={
            "username": "user_a",
            "email":    "same@example.com",
            "password": "StrongPass@123",
        })
        res = client.post("/api/v1/auth/signup", json={
            "username": "user_b",
            "email":    "same@example.com",
            "password": "StrongPass@123",
        })
        assert res.status_code == 409
        assert "邮箱" in res.get_json()["msg"]

    def test_signup_invalid_email(self, client):
        """非法邮箱格式应返回 400"""
        res = client.post("/api/v1/auth/signup", json={
            "username": "user_x",
            "email":    "not-an-email",
            "password": "StrongPass@123",
        })
        assert res.status_code == 400

    def test_signup_invalid_username(self, client):
        """用户名含非法字符应返回 400"""
        res = client.post("/api/v1/auth/signup", json={
            "username": "ab",          # 少于 3 位
            "email":    "ok@ex.com",
            "password": "StrongPass@123",
        })
        assert res.status_code == 400

    def test_signup_weak_password(self, client):
        """弱密码应被拒绝"""
        res = client.post("/api/v1/auth/signup", json={
            "username": "user_weak",
            "email":    "weak@ex.com",
            "password": "12345678",
        })
        assert res.status_code == 400

    def test_signup_missing_fields(self, client):
        """缺少必填字段应返回 400"""
        res = client.post("/api/v1/auth/signup", json={"username": "u"})
        assert res.status_code == 400

    @patch("api.auth.send_verification_email", return_value=True)
    def test_unverified_user_cannot_login(self, mock_send, client):
        """未验证邮箱的用户登录应被拒绝（403）"""
        client.post("/api/v1/auth/signup", json={
            "username": "unverified",
            "email":    "unv@example.com",
            "password": "StrongPass@123",
        })
        res = client.post("/api/v1/auth/login", json={
            "username": "unverified",
            "password": "StrongPass@123",
        })
        assert res.status_code == 403


# ═══════════════════════════════════════════════════════════════════════════════
# 新增测试：邮箱验证
# ═══════════════════════════════════════════════════════════════════════════════

class TestEmailVerification:
    @patch("api.auth.send_verification_email", return_value=True)
    @patch("api.auth.send_welcome_email",      return_value=True)
    def test_verify_email_success(self, mock_welcome, mock_send, client, app):
        """合法 token 可成功验证邮箱"""
        # 注册
        client.post("/api/v1/auth/signup", json={
            "username": "vuser",
            "email":    "vuser@example.com",
            "password": "StrongPass@123",
        })

        # 从数据库取 token
        with app.app_context():
            from models.auth_tokens import EmailVerification
            ev = EmailVerification.query.filter_by(email="vuser@example.com").first()
            token = ev.token

        res = client.get(f"/api/v1/auth/verify-email?token={token}")
        assert res.status_code == 200
        assert "成功" in res.get_json()["msg"]
        mock_welcome.assert_called_once()

    def test_verify_email_invalid_token(self, client):
        """无效 token 应返回 400"""
        res = client.get("/api/v1/auth/verify-email?token=invalid-token-xyz")
        assert res.status_code == 400

    def test_verify_email_missing_token(self, client):
        """缺少 token 参数应返回 400"""
        res = client.get("/api/v1/auth/verify-email")
        assert res.status_code == 400

    @patch("api.auth.send_verification_email", return_value=True)
    def test_resend_verification(self, mock_send, client):
        """重发验证邮件"""
        client.post("/api/v1/auth/signup", json={
            "username": "resenduser",
            "email":    "resend@example.com",
            "password": "StrongPass@123",
        })
        res = client.post("/api/v1/auth/resend-verification", json={
            "email": "resend@example.com",
        })
        assert res.status_code == 200

    def test_resend_verification_nonexistent_email(self, client):
        """不存在的邮箱也应返回 200（防枚举）"""
        res = client.post("/api/v1/auth/resend-verification", json={
            "email": "ghost@example.com",
        })
        assert res.status_code == 200


# ═══════════════════════════════════════════════════════════════════════════════
# 新增测试：密码重置
# ═══════════════════════════════════════════════════════════════════════════════

class TestPasswordReset:
    @patch("api.auth.send_password_reset_email", return_value=True)
    def test_forgot_password_success(self, mock_send, client, app):
        """存在的邮箱触发重置邮件，固定返回 200"""
        # 先确认 admin 用户有邮箱（测试夹具需配置）
        with app.app_context():
            from models.models import User
            admin = User.query.filter_by(username="admin").first()
            if admin and not getattr(admin, "email", None):
                admin.email = "admin@example.com"
                from extensions import db
                db.session.commit()

        res = client.post("/api/v1/auth/forgot-password", json={
            "email": "admin@example.com",
        })
        assert res.status_code == 200

    def test_forgot_password_nonexistent_email(self, client):
        """不存在的邮箱也应返回 200（防枚举）"""
        res = client.post("/api/v1/auth/forgot-password", json={
            "email": "nobody@example.com",
        })
        assert res.status_code == 200

    def test_forgot_password_missing_email(self, client):
        """缺少 email 字段应返回 400"""
        res = client.post("/api/v1/auth/forgot-password", json={})
        assert res.status_code == 400

    @patch("api.auth.send_password_reset_email", return_value=True)
    def test_reset_password_success(self, mock_send, client, app):
        """合法 token 可重置密码"""
        # 创建重置 token
        with app.app_context():
            from models.models import User
            from models.auth_tokens import PasswordResetToken
            from extensions import db

            admin = User.query.filter_by(username="admin").first()
            prt   = PasswordResetToken.create_for(admin.id)
            db.session.commit()
            token = prt.token

        res = client.post("/api/v1/auth/reset-password", json={
            "token":        token,
            "new_password": "ResetPass@999",
        })
        assert res.status_code == 200
        assert "成功" in res.get_json()["msg"]

        # 用新密码可登录
        login_res = client.post("/api/v1/auth/login", json={
            "username": "admin",
            "password": "ResetPass@999",
        })
        assert login_res.status_code == 200

        # 恢复原密码
        new_headers = {"Authorization": f"Bearer {login_res.get_json()['access_token']}"}
        client.post(
            "/api/v1/auth/change-password",
            headers=new_headers,
            json={"old_password": "ResetPass@999", "new_password": "TestAdmin@123456"},
        )

    @patch("api.auth.send_password_reset_email", return_value=True)
    def test_reset_password_token_reuse(self, mock_send, client, app):
        """token 使用后不可重复使用"""
        with app.app_context():
            from models.models import User
            from models.auth_tokens import PasswordResetToken
            from extensions import db

            admin = User.query.filter_by(username="admin").first()
            prt   = PasswordResetToken.create_for(admin.id)
            db.session.commit()
            token = prt.token

        # 第一次重置
        client.post("/api/v1/auth/reset-password", json={
            "token":        token,
            "new_password": "ResetPass@111",
        })
        # 第二次用同一个 token
        res = client.post("/api/v1/auth/reset-password", json={
            "token":        token,
            "new_password": "ResetPass@222",
        })
        assert res.status_code == 400

    def test_reset_password_invalid_token(self, client):
        """无效 token 应返回 400"""
        res = client.post("/api/v1/auth/reset-password", json={
            "token":        "fake-token-123",
            "new_password": "ResetPass@123",
        })
        assert res.status_code == 400

    def test_reset_password_weak_password(self, client, app):
        """新密码强度不足应被拒绝"""
        with app.app_context():
            from models.models import User
            from models.auth_tokens import PasswordResetToken
            from extensions import db

            admin = User.query.filter_by(username="admin").first()
            prt   = PasswordResetToken.create_for(admin.id)
            db.session.commit()
            token = prt.token

        res = client.post("/api/v1/auth/reset-password", json={
            "token":        token,
            "new_password": "weak",
        })
        assert res.status_code == 400


# ═══════════════════════════════════════════════════════════════════════════════
# 新增测试：token 黑名单
# ═══════════════════════════════════════════════════════════════════════════════

class TestTokenBlocklist:
    def test_revoked_access_token_rejected(self, client, auth_headers):
        """已吊销的 access token 应被拒绝"""
        # 登出（吊销 access token）
        client.post("/api/v1/auth/logout", headers=auth_headers)

        # 再用同一个 token 访问
        res = client.get("/api/v1/servers/", headers=auth_headers)
        assert res.status_code == 401

    def test_blocklist_stats_accessible(self, client, auth_headers, app):
        """黑名单统计应可访问（内部调试接口）"""
        with app.app_context():
            from utils.token_blocklist import get_blocklist_stats
            stats = get_blocklist_stats()
            assert isinstance(stats["access_revoked"],  int)
            assert isinstance(stats["refresh_revoked"], int)
            assert isinstance(stats["total"],           int)

    def test_revoke_access_and_refresh_tokens(self, client, app):
        """同时吊销 access 和 refresh token"""
        with app.app_context():
            from utils.token_blocklist import (
                revoke_access_token, revoke_refresh_token,
                is_access_token_revoked, is_refresh_token_revoked,
            )
            revoke_access_token( "jti-access-001",  3600)
            revoke_refresh_token("jti-refresh-001", 86400)

            assert is_access_token_revoked("jti-access-001")   is True
            assert is_refresh_token_revoked("jti-refresh-001") is True
            # 未吊销的 token
            assert is_access_token_revoked("jti-other")        is False
