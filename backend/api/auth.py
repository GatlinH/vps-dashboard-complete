"""
/api/auth  —  登录 / 刷新 / 登出 / 修改密码
"""
import logging
import re
import secrets
import string
import time
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
from utils.token_blocklist import revoke_token

auth_bp = Blueprint("auth", __name__)
logger = logging.getLogger(__name__)


def _revoke_current_token() -> None:
    """吊销当前请求中的 access token（写入 Redis 黑名单）。"""
    claims = get_jwt()
    jti = claims.get("jti")
    exp = claims.get("exp")
    if jti and exp:
        expires_delta = int(exp - time.time())
        if expires_delta > 0:
            try:
                revoke_token(jti, expires_delta)
            except Exception as e:
                logger.warning(f"⚠️ 吊销 token 失败: {e}")


def _generate_random_password(length=20):
    """生成随机强密码（确保包含大写、小写、数字、特殊字符各至少一位）"""
    lower = secrets.choice(string.ascii_lowercase)
    upper = secrets.choice(string.ascii_uppercase)
    digit = secrets.choice(string.digits)
    punct = secrets.choice(string.punctuation)
    alphabet = string.ascii_letters + string.digits + string.punctuation
    rest = [secrets.choice(alphabet) for _ in range(length - 4)]
    pool = list(lower + upper + digit + punct) + rest
    secrets.SystemRandom().shuffle(pool)
    return ''.join(pool)


def _get_or_create_default_admin():
    """首次启动自动创建 admin 账户，密码从环境变量读取，未设置时随机生成"""
    u = User.query.filter_by(username="admin").first()
    if not u:
        default_password = current_app.config.get("ADMIN_DEFAULT_PASSWORD", "")
        if not default_password:
            default_password = _generate_random_password()
            print(
                "\n" + "=" * 60 + "\n"
                "⚠️  ADMIN_DEFAULT_PASSWORD 未设置，已自动生成随机密码。\n"
                f"   admin 初始密码: {default_password}\n"
                "   请登录后立即修改密码！\n"
                + "=" * 60 + "\n",
                flush=True,
            )
        u = User(
            username="admin",
            password_hash=generate_password_hash(default_password),
            role="admin",
        )
        db.session.add(u)
        db.session.commit()
    return u


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

    access = create_access_token(identity=str(user.id),
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
    uid = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    access = create_access_token(identity=uid,
                                  additional_claims={"role": user.role})
    return jsonify(access_token=access)


@auth_bp.get("/me")
@jwt_required()
def me():
    uid = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    return jsonify(user=user.to_dict())


@auth_bp.post("/change-password")
@jwt_required()
def change_password():
    uid = get_jwt_identity()
    user = db.session.get(User, int(uid))
    data = request.get_json(silent=True) or {}
    old = data.get("old_password", "")
    new = data.get("new_password", "")

    if not check_password_hash(user.password_hash, old):
        return jsonify(msg="原密码错误"), 400
    if len(new) < 8:
        return jsonify(msg="新密码至少 8 位"), 400
    if not re.search(r'[A-Za-z]', new) or not re.search(r'[0-9]', new):
        return jsonify(msg="新密码需同时包含字母和数字"), 400

    user.password_hash = generate_password_hash(new)
    db.session.commit()

    # 吊销当前 access token，强制重新登录
    _revoke_current_token()

    return jsonify(msg="密码已更新")


@auth_bp.post("/logout")
@jwt_required()
def logout():
    """注销：吊销当前 access token"""
    _revoke_current_token()
    return jsonify(msg="已登出")
