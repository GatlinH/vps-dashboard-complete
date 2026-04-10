"""
backend/middleware/rbac.py  —  基于角色的访问控制
"""
from functools import wraps
from flask import jsonify
from flask_jwt_extended import get_jwt, verify_jwt_in_request


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
        if claims.get("role") != "admin":
            return jsonify(msg="权限不足，需要管理员角色"), 403
        return fn(*args, **kwargs)
    return wrapper
