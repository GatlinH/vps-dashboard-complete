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
    set_access_cookies, set_refresh_cookies, unset_jwt_cookies,
    get_csrf_token,
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

# 引入全局限流器和预设常量
from middleware.rate_limit import limiter, LOGIN_LIMIT, WRITE_LIMIT, READ_LIMIT
from middleware.rbac import admin_required, ADMIN_ROLE, VIEWER_ROLE, USER_ROLE

auth_bp = Blueprint("auth", __name__)

# 允许管理员通过 API 分配的角色集合（不包含 admin，防止越权提权）
_ASSIGNABLE_ROLES = {VIEWER_ROLE, USER_ROLE}
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
@limiter.limit(LOGIN_LIMIT)  # 严格防爆破
def login():
    """
    用户登录并签发 JWT Token。
    ---
    tags:
      - Auth
    summary: 用户登录
    description: 使用用户名和密码登录，返回 access_token、refresh_token 与用户信息。
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [username, password]
          properties:
            username:
              type: string
              example: admin
            password:
              type: string
              example: "StrongPassword!123"
    responses:
      200:
        description: 登录成功
      400:
        description: 参数缺失
      401:
        description: 用户名或密码错误
      403:
        description: 邮箱未验证
      429:
        description: 触发登录风控
    """
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

    resp = jsonify(
        access_token=access,
        refresh_token=refresh,
        user=user.to_dict(),
    )
    # Set httpOnly cookies for browser clients (P1-7).
    # Bearer header path remains supported for backward compatibility.
    set_access_cookies(resp, access)
    set_refresh_cookies(resp, refresh)
    return resp


# ── 刷新 ─────────────────────────────────────────────────────────────────────

@auth_bp.post("/refresh")
@limiter.limit(WRITE_LIMIT)  # 防止高频刷新 Token 耗尽资源
@jwt_required(refresh=True)
def refresh():
    """
    使用 refresh token 换发新的 access/refresh token。
    ---
    tags:
      - Auth
    summary: 刷新令牌
    security:
      - Bearer: []
    responses:
      200:
        description: 刷新成功
      401:
        description: refresh token 已失效或被吊销
      404:
        description: 用户不存在
    """
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

    resp = jsonify(access_token=new_access, refresh_token=new_refresh)
    # Rotate cookies alongside body tokens (P1-7).
    set_access_cookies(resp, new_access)
    set_refresh_cookies(resp, new_refresh)
    return resp


# ── 当前用户信息 ──────────────────────────────────────────────────────────────

@auth_bp.get("/me")
@limiter.limit(READ_LIMIT)  # 宽松限制，允许正常刷新的页面请求
@jwt_required()
def me():
    """
    获取当前登录用户信息。
    ---
    tags:
      - Auth
    summary: 当前用户
    security:
      - Bearer: []
    responses:
      200:
        description: 返回用户信息
      404:
        description: 用户不存在
    """
    uid  = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    return jsonify(user=user.to_dict())


# ── 修改密码 ──────────────────────────────────────────────────────────────────

@auth_bp.post("/change-password")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def change_password():
    """
    修改当前用户密码并吊销当前 access token。
    ---
    tags:
      - Auth
    summary: 修改密码
    security:
      - Bearer: []
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [old_password, new_password]
          properties:
            old_password:
              type: string
            new_password:
              type: string
              example: "NewStrongPass!2026"
    responses:
      200:
        description: 密码修改成功
      400:
        description: 原密码错误或新密码强度不达标
    """
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
@limiter.limit(WRITE_LIMIT)
# optional=True: allows unauthenticated callers (e.g. double-click, expired session) to call
# /logout and still receive cookie-clearing headers (Max-Age=0) without getting 401.
# Security: when a valid access_token_cookie IS present in the request, flask-jwt-extended
# still enforces CSRF protection (JWT_COOKIE_CSRF_PROTECT=True) — a cookie-authenticated
# POST without a matching X-CSRF-Token header is rejected with 401 "Missing CSRF token".
# When NO cookie is present, there is no session to protect: the request proceeds as a no-op
# (no token to revoke), which is intentional and safe.
# SameSite=Lax further limits cross-origin cookie sending, so a cross-site attacker cannot
# trivially make the victim's browser send the auth cookie to this endpoint.
@jwt_required(optional=True)
def logout():
    """
    注销：吊销当前 access token，清除认证 cookie，可选吊销 refresh token。
    ---
    tags:
      - Auth
    summary: 用户登出
    security:
      - Bearer: []
      - Cookie: []
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: false
        schema:
          type: object
          properties:
            refresh_jti:
              type: string
            refresh_exp:
              type: integer
              description: refresh token 的 Unix 时间戳（秒）
    responses:
      200:
        description: 已登出
    """
    # Best-effort: revoke the current access token JTI in Redis.
    # _revoke_current_access_token handles its own internal exceptions;
    # the outer guard ensures any unexpected error (e.g. get_jwt() abnormality)
    # never prevents cookie clearing from completing.
    try:
        _revoke_current_access_token()
    except Exception as e:
        logger.warning("⚠️ 登出时 token 吊销遇到意外错误: %s", e)

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

    # Clear httpOnly auth cookies (P1-7).
    resp = jsonify(msg="已登出")
    unset_jwt_cookies(resp)
    return resp


# ═══════════════════════════════════════════════════════════════════════════════
# 注册
# ═══════════════════════════════════════════════════════════════════════════════

@auth_bp.post("/signup")
@limiter.limit(LOGIN_LIMIT)  # 严格防机器批量注册滥用
def signup():
    """
    用户注册
    Body: { username, email, password }
    流程：创建用户（email_verified=False）→ 发送验证邮件
    ---
    tags:
      - Auth
    summary: 用户注册
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [username, email, password]
          properties:
            username:
              type: string
              example: demo_user
            email:
              type: string
              example: demo@example.com
            password:
              type: string
              example: "StrongPassword!123"
        examples:
          application/json:
            username: demo_user
            email: demo@example.com
            password: "StrongPassword!123"
    responses:
      201:
        description: 注册成功
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 注册成功，请检查邮箱进行验证
      400:
        description: 参数校验失败
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 用户名、邮箱和密码不能为空
      409:
        description: 用户名或邮箱已存在
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 用户名已被占用
      429:
        description: 请求过于频繁（触发注册限流）
        schema:
          type: object
          properties:
            msg:
              type: string
              example: Too many requests
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
    # 注意：role 字段始终强制为 "user"，禁止客户端通过此接口提交 role 字段。
    # 管理员角色只能通过内部受控流程（_get_or_create_default_admin）创建。
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
@limiter.limit(WRITE_LIMIT)  # 验证链接防恶意高频访问
def verify_email():
    """
    邮箱验证
    Query: ?token=xxxx
    ---
    tags:
      - Auth
    summary: 邮箱验证
    parameters:
      - in: query
        name: token
        required: true
        type: string
    responses:
      200:
        description: 邮箱验证成功
      400:
        description: token 缺失、无效或过期
      404:
        description: 用户不存在
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
@limiter.limit(LOGIN_LIMIT)  # 极严格防邮件轰炸(Email Bombing)
def resend_verification():
    """
    重新发送验证邮件
    Body: { email }
    ---
    tags:
      - Auth
    summary: 重发验证邮件
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [email]
          properties:
            email:
              type: string
    responses:
      200:
        description: 已受理（始终返回 200，避免邮箱枚举）
      400:
        description: 参数缺失
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

def _request_password_reset_impl():
    """
    忘记密码：发送重置邮件
    Body: { email }
    ---
    tags:
      - Auth
    summary: 忘记密码
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [email]
          properties:
            email:
              type: string
    responses:
      200:
        description: 已受理（避免邮箱枚举）
      400:
        description: 参数缺失
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


@auth_bp.post("/request-password-reset")
@limiter.limit(LOGIN_LIMIT)  # 极严格防邮件轰炸(Email Bombing)
def request_password_reset():
    """忘记密码（推荐新路径）"""
    return _request_password_reset_impl()


@auth_bp.post("/forgot-password")
@limiter.limit(LOGIN_LIMIT)  # 兼容旧路径
def forgot_password():
    """忘记密码（兼容旧路径）"""
    return _request_password_reset_impl()


@auth_bp.post("/reset-password")
@limiter.limit(WRITE_LIMIT)  # 防恶意爆破验证 token
def reset_password():
    """
    重置密码
    Body: { token, new_password }
    ---
    tags:
      - Auth
    summary: 重置密码
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [token, new_password]
          properties:
            token:
              type: string
            new_password:
              type: string
              example: "NewStrongPass!2026"
    responses:
      200:
        description: 密码重置成功
      400:
        description: token 无效/过期，或密码不合法
      404:
        description: 用户不存在
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


# ═══════════════════════════════════════════════════════════════════════════════
# 管理员用户管理（P1-1 / P1-4 修复）
# ─ 管理员可查询用户列表并将用户提升为 viewer，使其获得只读后台权限。
# ─ 仅允许分配 user / viewer 角色，admin 角色仍通过内部流程保持，避免越权风险。
# ═══════════════════════════════════════════════════════════════════════════════

@auth_bp.get("/users")
@limiter.limit(READ_LIMIT)
@admin_required
def list_users():
    """
    列出所有用户（仅管理员）。
    ---
    tags:
      - Auth
    summary: 用户列表
    security:
      - Bearer: []
    parameters:
      - in: query
        name: role
        type: string
        description: 按角色筛选（admin/viewer/user）
    responses:
      200:
        description: 用户列表
      403:
        description: 权限不足
    """
    role_filter = request.args.get("role", "").strip() or None
    query = User.query
    if role_filter:
        query = query.filter_by(role=role_filter)
    users = query.order_by(User.id).all()
    return jsonify(users=[u.to_dict() for u in users], count=len(users))


@auth_bp.patch("/users/<int:user_id>/role")
@limiter.limit(WRITE_LIMIT)
@admin_required
def assign_user_role(user_id: int):
    """
    修改用户角色（仅管理员）。
    可分配的角色为 viewer 或 user；admin 角色不可通过此接口分配，防止越权提权。
    ---
    tags:
      - Auth
    summary: 分配用户角色
    security:
      - Bearer: []
    parameters:
      - in: path
        name: user_id
        type: integer
        required: true
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [role]
          properties:
            role:
              type: string
              enum: [viewer, user]
              example: viewer
    responses:
      200:
        description: 角色更新成功
      400:
        description: role 参数缺失或非法
      403:
        description: 权限不足，或尝试分配 admin 角色
      404:
        description: 用户不存在
    """
    data     = request.get_json(silent=True) or {}
    new_role = data.get("role", "").strip()

    if not new_role:
        return jsonify(msg="role 字段不能为空"), 400

    if new_role not in _ASSIGNABLE_ROLES:
        return jsonify(
            msg=f"非法角色值：'{new_role}'；可分配角色为 user, viewer"
        ), 400

    target = db.session.get(User, user_id)
    if not target:
        return jsonify(msg="用户不存在"), 404

    # 拒绝降级 admin 账户，防止管理员通过此接口误删自身权限
    if target.role == ADMIN_ROLE:
        return jsonify(msg="不能通过此接口修改 admin 账户角色"), 403

    old_role     = target.role
    target.role  = new_role
    db.session.commit()

    logger.info(
        f"✓ 角色变更: user_id={user_id} username={target.username} "
        f"{old_role} → {new_role}"
    )
    return jsonify(msg="角色已更新", user=target.to_dict())
