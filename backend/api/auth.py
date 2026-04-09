"""
/api/auth  —  登录 / 刷新 / 登出 / 修改密码
"""
import logging
import secrets
import string
from datetime import datetime
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import (
    create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity, get_jwt,
)
from werkzeug.security import generate_password_hash, check_password_hash
from extensions import db
from models.models import User
from middleware.login_guard import LoginGuard
from utils.errors import AuthenticationError

auth_bp = Blueprint("auth", __name__)

logger = logging.getLogger(__name__)

# ── 辅助 ────────────────────────────────────────────────────────────────────

def _generate_random_password(length=20):
    """生成随机强密码"""
    alphabet = string.ascii_letters + string.digits + string.punctuation
    # Ensure at least one of each character type
    while True:
        pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
        if (any(c.islower() for c in pwd)
                and any(c.isupper() for c in pwd)
                and any(c.isdigit() for c in pwd)
                and any(c in string.punctuation for c in pwd)):
            return pwd


def _get_or_create_default_admin():
    """首次启动自动创建 admin 账户，密码从环境变量读取，未设置时随机生成"""
    u = User.query.filter_by(username="admin").first()
    if not u:
        default_password = current_app.config.get("ADMIN_DEFAULT_PASSWORD", "")
        if not default_password:
            default_password = _generate_random_password()
            logger.warning(
                "⚠️  未设置 ADMIN_DEFAULT_PASSWORD 环境变量，已自动生成随机密码。"
                f"  admin 初始密码: {default_password}"
                "  请立即登录并修改密码！"
            )
        u = User(
            username="admin",
            password_hash=generate_password_hash(default_password),
            role="admin",
        )
        db.session.add(u)
        db.session.commit()
    return u


# ── 路由 ────────────────────────────────────────────────────────────────────

@auth_bp.post("/login")
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        return jsonify(msg="用户名和密码不能为空"), 400

    # ── 暴力破解防护 ──────────────────────────────────────────────────────
    try:
        LoginGuard.check_login_allowed(username)
    except AuthenticationError as e:
        return jsonify(msg=e.message), 429
    except Exception as e:
        logger.warning(f"⚠️ LoginGuard 检查失败 (Redis 不可用?): {e}")

    ip_address = request.remote_addr or ""
    user_agent = request.user_agent.string or ""

    _get_or_create_default_admin()
    user = User.query.filter_by(username=username).first()

    if not user or not check_password_hash(user.password_hash, password):
        try:
            LoginGuard.record_login_attempt(
                username, success=False,
                ip_address=ip_address,
                user_agent=user_agent,
                request_obj=request,
            )
        except Exception as e:
            logger.warning(f"⚠️ LoginGuard 记录失败: {e}")
        return jsonify(msg="用户名或密码错误"), 401

    user.last_login = datetime.utcnow()
    db.session.commit()

    try:
        LoginGuard.record_login_attempt(
            username, success=True,
            ip_address=ip_address,
            user_agent=user_agent,
            request_obj=request,
        )
    except Exception as e:
        logger.warning(f"⚠️ LoginGuard 记录失败: {e}")

    access  = create_access_token(identity=str(user.id),
                                   additional_claims={"role": user.role})
    refresh = create_refresh_token(identity=str(user.id))

    return jsonify(
        access_token=access,
        refresh_token=refresh,
        user=user.to_dict(),
    )


@auth_bp.post("/refresh")
@jwt_required(refresh=True)
def refresh():
    uid     = get_jwt_identity()
    user    = User.query.get(int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    access  = create_access_token(identity=uid,
                                   additional_claims={"role": user.role})
    return jsonify(access_token=access)


@auth_bp.get("/me")
@jwt_required()
def me():
    uid  = get_jwt_identity()
    user = User.query.get(int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    return jsonify(user=user.to_dict())


@auth_bp.post("/change-password")
@jwt_required()
def change_password():
    uid  = get_jwt_identity()
    user = User.query.get(int(uid))
    data = request.get_json(silent=True) or {}
    old  = data.get("old_password", "")
    new  = data.get("new_password", "")

    if not check_password_hash(user.password_hash, old):
        return jsonify(msg="原密码错误"), 400
    if len(new) < 6:
        return jsonify(msg="新密码至少 6 位"), 400

    user.password_hash = generate_password_hash(new)
    db.session.commit()
    return jsonify(msg="密码已更新")
