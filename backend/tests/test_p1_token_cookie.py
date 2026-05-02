"""
P1-7: httpOnly cookie + CSRF 认证迁移测试

覆盖范围：
- 登录后通过 Set-Cookie 建立认证（而非仅返回 JSON body token）
- access_token_cookie 为 httpOnly（JS 不可直接读取）
- csrf_access_token cookie 为非 httpOnly（JS 可读取）
- 使用 cookie 路径的写操作：无 CSRF token 被拒绝（401/422）
- 使用 cookie 路径的写操作：正确 CSRF token 可通过
- logout 后认证 cookie 被清除，后续受保护接口不可访问
- Bearer header 路径在迁移后仍然正常工作（向后兼容）
"""
import re

import pytest


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def _parse_set_cookie(response, name):
    """从响应的 Set-Cookie 头中提取指定 cookie 的属性字符串。"""
    for cookie_str in response.headers.getlist('Set-Cookie'):
        if cookie_str.split(';')[0].strip().split('=')[0] == name:
            return cookie_str
    return None


def _get_cookie_value(response, name):
    """从响应的 Set-Cookie 头中提取指定 cookie 的值。"""
    for cookie_str in response.headers.getlist('Set-Cookie'):
        parts = cookie_str.split(';')
        kv = parts[0].strip()
        if '=' in kv:
            k, v = kv.split('=', 1)
            if k.strip() == name:
                return v.strip()
    return None


# ── 登录响应 cookie 结构 ──────────────────────────────────────────────────────

class TestLoginSetsCookies:
    """登录后服务端通过 Set-Cookie 下发 JWT，不要求客户端持久化 token。"""

    def test_login_returns_200(self, client):
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert res.status_code == 200

    def test_login_sets_access_token_cookie(self, client):
        """access_token_cookie 必须存在于 Set-Cookie 中。"""
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        cookie_str = _parse_set_cookie(res, 'access_token_cookie')
        assert cookie_str is not None, "access_token_cookie 未在 Set-Cookie 中找到"

    def test_login_access_cookie_is_httponly(self, client):
        """access_token_cookie 必须携带 HttpOnly 属性，防止 XSS 读取。"""
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        cookie_str = _parse_set_cookie(res, 'access_token_cookie')
        assert cookie_str is not None
        # HttpOnly 属性大小写不敏感
        assert re.search(r'\bHttpOnly\b', cookie_str, re.IGNORECASE), (
            f"access_token_cookie 应包含 HttpOnly 属性，实际为: {cookie_str}"
        )

    def test_login_sets_csrf_access_cookie(self, client):
        """csrf_access_token cookie 必须存在，供前端 JS 读取并注入到请求头。"""
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        csrf_cookie = _parse_set_cookie(res, 'csrf_access_token')
        assert csrf_cookie is not None, "csrf_access_token 未在 Set-Cookie 中找到"

    def test_login_csrf_cookie_is_not_httponly(self, client):
        """csrf_access_token 不得携带 HttpOnly，否则前端 JS 无法读取，CSRF 防护失效。"""
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        csrf_cookie = _parse_set_cookie(res, 'csrf_access_token')
        assert csrf_cookie is not None
        assert not re.search(r'\bHttpOnly\b', csrf_cookie, re.IGNORECASE), (
            f"csrf_access_token 不应包含 HttpOnly 属性，实际为: {csrf_cookie}"
        )

    def test_login_also_returns_tokens_in_body_for_backward_compat(self, client):
        """登录响应体中仍保留 access_token 字段，保证现有 Bearer-header 客户端兼容。"""
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        body = res.get_json()
        assert 'access_token' in body
        assert 'refresh_token' in body


# ── CSRF 防护校验 ─────────────────────────────────────────────────────────────

class TestCsrfProtection:
    """使用 cookie 路径时，写操作必须附带正确的 X-CSRF-Token 头。"""

    def _login_and_get_csrf(self, client):
        """登录并从响应 Set-Cookie 中提取 csrf_access_token 值。"""
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert res.status_code == 200
        return _get_cookie_value(res, 'csrf_access_token')

    def test_write_without_csrf_token_is_rejected(self, client):
        """cookie 路径 POST 请求不携带 X-CSRF-Token 应被拒绝（401 或 422）。"""
        self._login_and_get_csrf(client)  # establishes session cookie
        # POST without CSRF header — should be rejected
        res = client.post(
            '/api/v1/auth/logout',
            # No X-CSRF-Token header; cookie jar has the auth cookie
        )
        assert res.status_code in (401, 422), (
            f"预期 401/422，实际状态码: {res.status_code}"
        )

    def test_write_with_wrong_csrf_token_is_rejected(self, client):
        """携带错误 CSRF token 的写请求应被拒绝。"""
        self._login_and_get_csrf(client)
        res = client.post(
            '/api/v1/auth/logout',
            headers={'X-CSRF-Token': 'obviously-invalid-csrf-token'},
        )
        assert res.status_code in (401, 422), (
            f"预期 401/422，实际状态码: {res.status_code}"
        )

    def test_write_with_correct_csrf_token_succeeds(self, client):
        """携带正确 CSRF token 的写请求（在已认证前提下）应成功。"""
        csrf_token = self._login_and_get_csrf(client)
        assert csrf_token, "CSRF token 不应为空"
        res = client.post(
            '/api/v1/auth/logout',
            headers={'X-CSRF-Token': csrf_token},
        )
        assert res.status_code == 200, (
            f"预期 200，实际状态码: {res.status_code}，响应: {res.get_json()}"
        )

    def test_get_request_does_not_require_csrf(self, client, auth_headers):
        """GET 等安全方法无需 CSRF token（Bearer header 路径）。"""
        res = client.get('/api/v1/auth/me', headers=auth_headers)
        assert res.status_code == 200


# ── Logout 清除 cookie ────────────────────────────────────────────────────────

class TestLogoutClearsCookies:
    """logout 后认证 cookie 失效，后续受保护接口不可访问。"""

    def _login_and_get_csrf(self, client):
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert res.status_code == 200
        return _get_cookie_value(res, 'csrf_access_token')

    def test_logout_returns_200(self, client):
        csrf_token = self._login_and_get_csrf(client)
        res = client.post('/api/v1/auth/logout', headers={'X-CSRF-Token': csrf_token})
        assert res.status_code == 200

    def test_logout_clears_access_cookie(self, client):
        """logout 响应应通过 Set-Cookie 将 access_token_cookie 清除（max-age=0 或过期）。"""
        csrf_token = self._login_and_get_csrf(client)
        res = client.post('/api/v1/auth/logout', headers={'X-CSRF-Token': csrf_token})
        assert res.status_code == 200

        cookie_str = _parse_set_cookie(res, 'access_token_cookie')
        assert cookie_str is not None, "logout 响应应包含 access_token_cookie Set-Cookie 以清除 cookie"
        # flask-jwt-extended 清除 cookie 时将 value 置空并设 Max-Age=0 或 Expires=过去
        lower = cookie_str.lower()
        cookie_value = _get_cookie_value(res, 'access_token_cookie')
        assert (cookie_value == '' or 'max-age=0' in lower or 'expires=' in lower), (
            f"logout 后 access_token_cookie 应被清除，实际为: {cookie_str}"
        )

    def test_after_logout_protected_endpoint_returns_401(self, client):
        """logout 后，使用 cookie 路径访问受保护接口应返回 401。"""
        csrf_token = self._login_and_get_csrf(client)
        logout_res = client.post('/api/v1/auth/logout', headers={'X-CSRF-Token': csrf_token})
        assert logout_res.status_code == 200

        # 此时 cookie jar 中的 access_token_cookie 已被清除（或为空值）
        res = client.get('/api/v1/auth/me')
        assert res.status_code == 401, (
            f"logout 后 /auth/me 应返回 401，实际: {res.status_code}"
        )


# ── Bearer header 向后兼容 ────────────────────────────────────────────────────

class TestBearerHeaderBackwardCompat:
    """JWT_TOKEN_LOCATION 包含 headers，Bearer header 路径在迁移后仍正常工作。"""

    def test_bearer_login_and_access(self, client, auth_headers):
        """使用 Bearer header 访问 /auth/me 仍应返回 200。"""
        res = client.get('/api/v1/auth/me', headers=auth_headers)
        assert res.status_code == 200

    def test_bearer_protected_write_no_csrf_required(self, client, auth_headers):
        """Bearer header 路径不触发 CSRF 检查——无 X-CSRF-Token 头仍应成功。"""
        # logout via Bearer header, no CSRF header needed
        res = client.post('/api/v1/auth/logout', headers=auth_headers)
        assert res.status_code == 200

    def test_bearer_path_not_affected_by_cookie_changes(self, client):
        """Bearer header 认证路径不受 cookie 设置影响。"""
        login_res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        token = login_res.get_json()['access_token']
        res = client.get('/api/v1/auth/me', headers={'Authorization': f'Bearer {token}'})
        assert res.status_code == 200
        assert 'user' in res.get_json()


# ── Cookie 安全属性 ───────────────────────────────────────────────────────────

class TestCookieSecurityAttributes:
    """验证登录响应的 cookie 安全属性（HttpOnly / SameSite / Path）。"""

    def _login(self, client):
        res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert res.status_code == 200
        return res

    def test_access_cookie_has_samesite_attribute(self, client):
        """access_token_cookie 必须携带 SameSite 属性，防御跨站请求伪造。"""
        res = self._login(client)
        cookie_str = _parse_set_cookie(res, 'access_token_cookie')
        assert cookie_str is not None
        assert re.search(r'\bSameSite\b', cookie_str, re.IGNORECASE), (
            f"access_token_cookie 应包含 SameSite 属性，实际为: {cookie_str}"
        )

    def test_access_cookie_has_path_attribute(self, client):
        """access_token_cookie 必须携带 Path 属性，限制 cookie 作用范围。"""
        res = self._login(client)
        cookie_str = _parse_set_cookie(res, 'access_token_cookie')
        assert cookie_str is not None
        assert re.search(r'\bPath=', cookie_str, re.IGNORECASE), (
            f"access_token_cookie 应包含 Path 属性，实际为: {cookie_str}"
        )

    def test_get_via_cookie_does_not_require_csrf(self, client):
        """cookie 路径的 GET 请求无需 X-CSRF-Token 头（安全方法豁免）。"""
        # Establish session via cookie
        login_res = client.post(
            '/api/v1/auth/login',
            json={'username': 'admin', 'password': 'TestAdmin@123456'},
        )
        assert login_res.status_code == 200
        # GET without any CSRF header or Authorization — cookie path only
        res = client.get('/api/v1/auth/me')
        assert res.status_code == 200, (
            f"cookie 路径 GET 应返回 200（无需 CSRF），实际: {res.status_code}"
        )


# ── 前端基座源码审查 ──────────────────────────────────────────────────────────

import os as _os
import pathlib as _pathlib


class TestFrontendBaseLayer:
    """验证前端请求基座（base.js）满足 P1-7 安全要求（源码静态检查）。"""

    _BASE_JS = _pathlib.Path(
        _os.path.dirname(__file__),
        '../../frontend-vite/src/api/base.js',
    ).resolve()

    def _read_source(self):
        return self._BASE_JS.read_text(encoding='utf-8')

    def test_base_js_credentials_include(self):
        """base.js 必须包含 credentials: 'include'，使浏览器自动携带 httpOnly cookie。"""
        src = self._read_source()
        assert "credentials: 'include'" in src or 'credentials:"include"' in src, (
            "base.js 应包含 credentials: 'include' 以启用 cookie 发送"
        )

    def test_base_js_no_localstorage_get(self):
        """base.js 不得再读取 localStorage（getItem / 直接访问 authToken）。"""
        src = self._read_source()
        # These patterns indicate old localStorage-based token storage
        assert 'localStorage.getItem' not in src, (
            "base.js 不应再使用 localStorage.getItem 读取 token"
        )

    def test_base_js_no_localstorage_set(self):
        """base.js 不得再写入 localStorage（setItem / removeItem）。"""
        src = self._read_source()
        assert 'localStorage.setItem' not in src, (
            "base.js 不应再使用 localStorage.setItem 存储 token"
        )
        assert 'localStorage.removeItem' not in src, (
            "base.js 不应再使用 localStorage.removeItem 清除 token"
        )

    def test_base_js_csrf_header_on_writes(self):
        """base.js 必须在写操作中注入 X-CSRF-Token 头。"""
        src = self._read_source()
        assert 'X-CSRF-Token' in src, (
            "base.js 应在写操作请求头中携带 X-CSRF-Token"
        )
