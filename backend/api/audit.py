# backend/api/auth.py - 修改

"""
/api/auth  —  登录 / 刷新 / 登出 / 修改密码
"""
from datetime import datetime
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import (
    create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity, get_jwt,
)
from werkzeug.security import generate_password_hash, check_password_hash
from extensions import db
from models.models import User
from middleware.login_guard import LoginGuard  # ✅ 新增
from utils.errors import AuthenticationError    # ✅ 新增

auth_bp = Blueprint("auth", __name__)

# ... 保持现有代码 ...

@auth_bp.post("/login")
def login():
    """登录端点 - 添加安全加固"""
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    
    ip_address = request.remote_addr or 'unknown'
    user_agent = request.user_agent.string or 'unknown'

    if not username or not password:
        return jsonify(msg="用户名和密码不能为空"), 400

    # ✅ 检查账户是否被锁定
    try:
        LoginGuard.check_login_allowed(username)
    except AuthenticationError as e:
        LoginGuard.record_login_attempt(username, False, ip_address, user_agent, request)
        return jsonify(msg=str(e)), 429  # 429 = Too Many Requests
    
    _get_or_create_default_admin()
    user = User.query.filter_by(username=username).first()

    # 判断认证失败
    if not user or not check_password_hash(user.password_hash, password):
        # ✅ 记录失败尝试
        LoginGuard.record_login_attempt(username, False, ip_address, user_agent, request)
        return jsonify(msg="用户名或密码错误"), 401

    # ✅ 记录成功登录
    LoginGuard.record_login_attempt(username, True, ip_address, user_agent, request)
    
    user.last_login = datetime.utcnow()
    db.session.commit()

    access = create_access_token(
        identity=str(user.id),
        additional_claims={"role": user.role}
    )
    refresh = create_refresh_token(identity=str(user.id))

    return jsonify(
        access_token=access,
        refresh_token=refresh,
        user=user.to_dict(),
    ), 200  # ✅ 明确返回 200

# ... 保持现有代码 ...
