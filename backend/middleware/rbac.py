"""
backend/middleware/rbac.py  —  基于角色的访问控制
"""
from functools import wraps
from flask import jsonify
from flask_jwt_extended import get_jwt, verify_jwt_in_request

# 角色常量
ADMIN_ROLE = "admin"
VIEWER_ROLE = "viewer"

# 允许访问只读后台接口的角色集合
_READ_ROLES = {ADMIN_ROLE, VIEWER_ROLE}


def admin_required(fn):
    """
    装饰器：要求有效的 JWT 且角色必须为 'admin'。

    用法::
        @bp.post("/some-protected-route")
        @admin_required
        def protected():
            ...
    """
    @wraps(fn)
    def wrapper(*args, **kwargs):
        verify_jwt_in_request()
        claims = get_jwt()
        if claims.get("role") != ADMIN_ROLE:
            return jsonify(msg="权限不足，需要管理员角色"), 403
        return fn(*args, **kwargs)
    return wrapper


def viewer_or_admin_required(fn):
    """
    装饰器：要求有效的 JWT 且角色必须为 'admin' 或 'viewer'。
    用于只读后台接口，允许只读用户（viewer）访问，写操作仍须使用 admin_required。

    用法::
        @bp.get("/some-read-only-route")
        @viewer_or_admin_required
        def read_only():
            ...
    """
    @wraps(fn)
    def wrapper(*args, **kwargs):
        verify_jwt_in_request()
        claims = get_jwt()
        if claims.get("role") not in _READ_ROLES:
            return jsonify(msg="权限不足，需要管理员或只读角色"), 403
        return fn(*args, **kwargs)
    return wrapper
