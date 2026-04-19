"""
/api/auth  —  登录 / 刷新 / 登出 / 修改密码 / 注册 / 邮箱验证 / 密码重置
"""
import logging
import re
import secrets
import string
import time
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import (
    create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity, get_jwt,
)
from werkzeug.security import generate_password_hash, check_password_hash
from extensions import db
from models.models import User
from models.auth_tokens import EmailVerification, PasswordResetToken
from middleware.login_guard import LoginGuard
from services.email_service import (
    send_verification_email,
    send_password_reset_email,
    send_welcome_email,
)
from utils.errors import AuthenticationError
from utils.token_blocklist import (
    revoke_access_token,
    revoke_refresh_token,
    is_refresh_token_revoked,
)

auth_bp = Blueprint("auth", __name__)
logger  = logging.getLogger(__name__)

# ── 正则 ──────────────────────────────────────────────────────────────────────
_EMAIL_RE    = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{3,32}$")


# ── 内部工具 ──────────────────────────────────────────────────────────────────

def _revoke_current_access_token() -> None:
    """吊销当前请求的 access token"""
    claims = get_jwt()
    jti    = claims.get("jti")
    exp    = claims.get("exp")
    if jti and exp:
        delta = int(exp - time.time())
        if delta > 0:
            try:
                revoke_access_token(jti, delta)
            except Exception as e:
                logger.warning(f"⚠️ 吊销 access token 失败: {e}")


def _generate_random_password(length: int = 20) -> str:
    """生成随机强密码（包含大小写/数字/特殊字符各至少一位）"""
    lower  = secrets.choice(string.ascii_lowercase)
    upper  = secrets.choice(string.ascii_uppercase)
    digit  = secrets.choice(string.digits)
    punct  = secrets.choice(string.punctuation)
    rest   = [secrets.choice(string.ascii_letters + string.digits + string.punctuation)
               for _ in range(length - 4)]
    pool   = list(lower + upper + digit + punct) + rest
    secrets.SystemRandom().shuffle(pool)
    return "".join(pool)


def _get_or_create_default_admin():
    """首次启动自动创建 admin 账户"""
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
            username      = "admin",
            password_hash = generate_password_hash(default_password),
            role          = "admin",
            email_verified= True,   # admin 默认跳过邮箱验证
        )
        db.session.add(u)
        db.session.commit()
    return u


# ── 登录 ─────────────────────────────────────────────────────────────────────

@auth_bp.post("/login")
def login():
    data     = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")

    if not username or not password:
        return jsonify(msg="用户名和密码不能为空"), 400

    ip_address = request.remote_addr or ""
    user_agent = request.user_agent.string or ""

    try:
        LoginGuard.check_login_allowed(username, ip_address)
    except AuthenticationError as e:
        retry_after = getattr(e, "retry_after", None)
        return jsonify(msg=e.message, retry_after=retry_after), 429
    except Exception as e:
        logger.warning(f"⚠️ LoginGuard 检查失败 (Redis 不可用?): {e}")

    _get_or_create_default_admin()
    user = User.query.filter_by(username=username).first()

    if not user or not check_password_hash(user.password_hash, password):
        try:
            LoginGuard.record_login_attempt(
                username, success=False,
                ip_address=ip_address, user_agent=user_agent,
                request_obj=request,
            )
        except Exception as e:
            logger.warning(f"⚠️ LoginGuard 记录失败: {e}")
        return jsonify(msg="用户名或密码错误"), 401

    # 邮箱验证检查（admin 豁免）
    if user.role != "admin" and not getattr(user, "email_verified", True):
        return jsonify(msg="请先验证您的邮箱后再登录"), 403

    user.last_login = datetime.now(timezone.utc)
    db.session.commit()

    try:
        LoginGuard.record_login_attempt(
            username, success=True,
            ip_address=ip_address, user_agent=user_agent,
            request_obj=request,
        )
    except Exception as e:
        logger.warning(f"⚠️ LoginGuard 记录失败: {e}")

    access  = create_access_token(
        identity=str(user.id),
        additional_claims={"role": user.role, "username": user.username},
    )
    refresh = create_refresh_token(identity=str(user.id))

    return jsonify(
        access_token=access,
        refresh_token=refresh,
        user=user.to_dict(),
    )


# ── 刷新 ─────────────────────────────────────────────────────────────────────

@auth_bp.post("/refresh")
@jwt_required(refresh=True)
def refresh():
    claims = get_jwt()
    jti    = claims.get("jti")
    exp    = claims.get("exp")

    # 检查 refresh token 是否已吊销
    if jti and is_refresh_token_revoked(jti):
        return jsonify(msg="Refresh token 已失效，请重新登录"), 401

    uid  = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404

    # 旧 refresh token 单次使用：吊销后换发新 token
    if jti and exp:
        delta = int(exp - time.time())
        if delta > 0:
            try:
                revoke_refresh_token(jti, delta)
            except Exception as e:
                logger.warning(f"⚠️ 吊销旧 refresh token 失败: {e}")

    new_access  = create_access_token(
        identity=uid,
        additional_claims={"role": user.role, "username": user.username},
    )
    new_refresh = create_refresh_token(identity=uid)

    return jsonify(access_token=new_access, refresh_token=new_refresh)


# ── 当前用户信息 ──────────────────────────────────────────────────────────────

@auth_bp.get("/me")
@jwt_required()
def me():
    uid  = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    return jsonify(user=user.to_dict())


# ── 修改密码 ──────────────────────────────────────────────────────────────────

@auth_bp.post("/change-password")
@jwt_required()
def change_password():
    uid  = get_jwt_identity()
    user = db.session.get(User, int(uid))
    data = request.get_json(silent=True) or {}
    old  = data.get("old_password", "")
    new  = data.get("new_password", "")

    if not check_password_hash(user.password_hash, old):
        return jsonify(msg="原密码错误"), 400

    from utils.validators import validate_password_strength
    ok, err_msg = validate_password_strength(new)
    if not ok:
        return jsonify(msg=err_msg), 400

    user.password_hash = generate_password_hash(new)
    db.session.commit()

    # 吊销当前 access token，强制重新登录
    _revoke_current_access_token()

    return jsonify(msg="密码已更新")


# ── 登出 ─────────────────────────────────────────────────────────────────────

@auth_bp.post("/logout")
@jwt_required()
def logout():
    """注销：同时吊销 access token；refresh token 由客户端在 body 传入"""
    _revoke_current_access_token()

    # 可选：吊销 refresh token（客户端传 refresh_token 字段）
    data    = request.get_json(silent=True) or {}
    rt_jti  = data.get("refresh_jti")
    rt_exp  = data.get("refresh_exp")
    if rt_jti and rt_exp:
        delta = int(rt_exp - time.time())
        if delta > 0:
            try:
                revoke_refresh_token(rt_jti, delta)
            except Exception as e:
                logger.warning(f"⚠️ 吊销 refresh token 失败: {e}")

    return jsonify(msg="已登出")


# ═══════════════════════════════════════════════════════════════════════════════
# 注册
# ═══════════════════════════════════════════════════════════════════════════════

@auth_bp.post("/signup")
def signup():
    """
    用户注册
    Body: { username, email, password }
    流程：创建用户（email_verified=False）→ 发送验证邮件
    """
    data     = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    email    = data.get("email", "").strip().lower()
    password = data.get("password", "")

    # ── 参数校验 ──────────────────────────────────────────────────────────────
    if not username or not email or not password:
        return jsonify(msg="用户名、邮箱和密码不能为空"), 400

    if not _USERNAME_RE.match(username):
        return jsonify(msg="用户名只能包含字母、数字、下划线、连字符，长度 3-32 位"), 400

    if not _EMAIL_RE.match(email):
        return jsonify(msg="邮箱格式不正确"), 400

    from utils.validators import validate_password_strength
    ok, err_msg = validate_password_strength(password)
    if not ok:
        return jsonify(msg=err_msg), 400

    # ── 唯一性检查 ────────────────────────────────────────────────────────────
    if User.query.filter_by(username=username).first():
        return jsonify(msg="用户名已被占用"), 409

    if User.query.filter(User.email == email).first():  # type: ignore[attr-defined]
        return jsonify(msg="该邮箱已注册"), 409

    # ── 创建用户 ──────────────────────────────────────────────────────────────
    user = User(
        username       = username,
        email          = email,
        password_hash  = generate_password_hash(password),
        role           = "user",
        email_verified = False,
    )
    db.session.add(user)
    db.session.flush()  # 获取 user.id，不提交

    # ── 生成邮箱验证 token ────────────────────────────────────────────────────
    ev = EmailVerification.create_for(user.id, email)
    db.session.commit()

    # ── 发送验证邮件（失败不回滚，用户可重新请求）────────────────────────────
    sent = send_verification_email(email, username, ev.token)
    if not sent:
        logger.warning(f"⚠️ 验证邮件发送失败: user_id={user.id} email={email}")

    return jsonify(
        msg  = "注册成功，请查收验证邮件并点击链接激活账户",
        sent = sent,
    ), 201


# ═══════════════════════════════════════════════════════════════════════════════
# 邮箱验证
# ═══════════════════════════════════════════════════════════════════════════════

@auth_bp.get("/verify-email")
def verify_email():
    """
    邮箱验证
    Query: ?token=xxxx
    """
    token = request.args.get("token", "").strip()
    if not token:
        return jsonify(msg="缺少验证 token"), 400

    ev = EmailVerification.find_valid(token)
    if not ev:
        return jsonify(msg="验证链接无效或已过期，请重新申请"), 400

    user = db.session.get(User, ev.user_id)
    if not user:
        return jsonify(msg="用户不存在"), 404

    # ── 激活 ─────────────────────────────────────────────────────────────────
    ev.activate()
    user.email_verified = True  # type: ignore[attr-defined]
    db.session.commit()

    # 发送欢迎邮件（非阻塞，失败不影响主流程）
    try:
        send_welcome_email(ev.email, user.username)
    except Exception:
        pass

    return jsonify(msg="邮箱验证成功，现在可以登录了")


@auth_bp.post("/resend-verification")
def resend_verification():
    """
    重新发送验证邮件
    Body: { email }
    """
    data  = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()

    if not email:
        return jsonify(msg="请提供邮箱地址"), 400

    user = User.query.filter(User.email == email).first()  # type: ignore[attr-defined]

    # 固定返回 200，防止枚举邮箱
    if not user or getattr(user, "email_verified", True):
        return jsonify(msg="如果该邮箱已注册且未验证，验证邮件将在几分钟内送达"), 200

    ev   = EmailVerification.create_for(user.id, email)
    db.session.commit()
    send_verification_email(email, user.username, ev.token)

    return jsonify(msg="验证邮件已重新发送，请查收"), 200


# ═══════════════════════════════════════════════════════════════════════════════
# 密码重置
# ═══════════════════════════════════════════════════════════════════════════════

@auth_bp.post("/forgot-password")
def forgot_password():
    """
    忘记密码：发送重置邮件
    Body: { email }
    """
    data  = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()

    if not email:
        return jsonify(msg="请提供邮箱地址"), 400

    # 固定返回 200，防止枚举注册邮箱
    user = User.query.filter(User.email == email).first()  # type: ignore[attr-defined]
    if user:
        prt  = PasswordResetToken.create_for(user.id, ttl_hours=1)
        db.session.commit()
        sent = send_password_reset_email(email, user.username, prt.token)
        if not sent:
            logger.warning(f"⚠️ 重置邮件发送失败: user_id={user.id} email={email}")

    return jsonify(msg="如果该邮箱已注册，重置链接将在几分钟内送达"), 200


@auth_bp.post("/reset-password")
def reset_password():
    """
    重置密码
    Body: { token, new_password }
    """
    data         = request.get_json(silent=True) or {}
    token        = data.get("token", "").strip()
    new_password = data.get("new_password", "")

    if not token or not new_password:
        return jsonify(msg="token 和新密码不能为空"), 400

    prt = PasswordResetToken.find_valid(token)
    if not prt:
        return jsonify(msg="重置链接无效或已过期，请重新申请"), 400

    from utils.validators import validate_password_strength
    ok, err_msg = validate_password_strength(new_password)
    if not ok:
        return jsonify(msg=err_msg), 400

    user = db.session.get(User, prt.user_id)
    if not user:
        return jsonify(msg="用户不存在"), 404

    # ── 更新密码 + 消费 token ─────────────────────────────────────────────────
    user.password_hash = generate_password_hash(new_password)
    prt.consume()
    db.session.commit()

    logger.info(f"✓ 密码已重置: user_id={user.id} username={user.username}")
    return jsonify(msg="密码重置成功，请使用新密码登录")
