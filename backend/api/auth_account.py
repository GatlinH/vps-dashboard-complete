"""/auth 账户与密码流程"""
import logging
import time
import json
from datetime import datetime, timezone
from flask import Blueprint, jsonify, request, current_app
from flask_jwt_extended import jwt_required, get_jwt_identity, get_jwt, set_access_cookies, set_refresh_cookies, unset_jwt_cookies, create_access_token, create_refresh_token, decode_token
from werkzeug.security import generate_password_hash, check_password_hash

from extensions import db
from models.models import User
from models.auth_tokens import EmailVerification, PasswordResetToken
from middleware.login_guard import LoginGuard
from middleware.rate_limit import limiter, LOGIN_LIMIT, WRITE_LIMIT, READ_LIMIT
from middleware.rbac import admin_required, ADMIN_ROLE, VIEWER_ROLE, USER_ROLE
from services.email_service import send_verification_email, send_password_reset_email, send_welcome_email
from utils.errors import AuthenticationError
from utils.token_blocklist import is_refresh_token_revoked, revoke_refresh_token, revoke_access_token
import extensions
from utils.validators import validate_password_strength

account_bp = Blueprint("account", __name__)
logger = logging.getLogger(__name__)


def _session_key(jti: str) -> str:
    return f"auth:session:{jti}"

def _fmt_ua(ua) -> str:
    try:
        browser = ua.browser or "Browser"
        platform = ua.platform or "OS"
        return f"{browser} / {platform}"
    except Exception:
        return "未知浏览器"

def _store_session(user, access_token: str) -> None:
    try:
        claims = decode_token(access_token)
        jti = claims.get("jti")
        exp = int(claims.get("exp") or 0)
        if not jti or not exp:
            return
        now = int(time.time())
        ip = request.remote_addr or ""
        payload = {"id": jti, "user_id": str(user.id), "username": user.username, "ua": _fmt_ua(request.user_agent), "user_agent": request.user_agent.string or "", "ip": ip, "latest_ip": ip, "created_at": now, "last_login": now, "last_seen": now, "expires_at": exp}
        extensions.redis_client.setex(_session_key(jti), max(1, exp - now), json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        logger.warning("记录登录会话失败: %s", exc)

def _ensure_current_session():
    try:
        claims = get_jwt() or {}
        jti = claims.get("jti")
        exp = int(claims.get("exp") or 0)
        uid = get_jwt_identity()
        if not jti or not exp or not uid:
            return
        key = _session_key(jti)
        raw = extensions.redis_client.get(key)
        now = int(time.time())
        if raw:
            item = json.loads(raw)
        else:
            user = db.session.get(User, int(uid)) if str(uid).isdigit() else None
            item = {"id": jti, "user_id": str(uid), "username": getattr(user, "username", None) or str(uid), "ua": _fmt_ua(request.user_agent), "user_agent": request.user_agent.string or "", "ip": request.remote_addr or "", "created_at": now, "last_login": now, "expires_at": exp, "backfilled": True}
        item["latest_ip"] = request.remote_addr or item.get("latest_ip") or item.get("ip") or ""
        item["last_seen"] = now
        extensions.redis_client.setex(key, max(1, exp - now), json.dumps(item, ensure_ascii=False))
    except Exception as exc:
        logger.warning("补登记当前会话失败: %s", exc)

def _iter_sessions(user_id: str):
    _ensure_current_session()
    current = (get_jwt() or {}).get("jti")
    now = int(time.time())
    rows = []
    try:
        for key in extensions.redis_client.scan_iter("auth:session:*"):
            raw = extensions.redis_client.get(key)
            if not raw:
                continue
            try:
                item = json.loads(raw)
            except Exception:
                continue
            if str(item.get("user_id")) != str(user_id):
                continue
            exp = int(item.get("expires_at") or 0)
            if exp and exp <= now:
                extensions.redis_client.delete(key)
                continue
            item["id"] = item.get("id") or str(key).rsplit(":", 1)[-1]
            item["current"] = bool(current and item["id"] == current)
            item["ttl"] = max(0, exp - now) if exp else 0
            rows.append(item)
    except Exception as exc:
        logger.warning("读取会话列表失败: %s", exc)
    rows.sort(key=lambda x: int(x.get("last_seen") or x.get("last_login") or x.get("created_at") or 0), reverse=True)
    return rows


def _generate_random_password(length: int = 20) -> str:
    import secrets, string
    lower = secrets.choice(string.ascii_lowercase)
    upper = secrets.choice(string.ascii_uppercase)
    digit = secrets.choice(string.digits)
    punct = secrets.choice(string.punctuation)
    rest = [secrets.choice(string.ascii_letters + string.digits + string.punctuation) for _ in range(length - 4)]
    pool = list(lower + upper + digit + punct) + rest
    secrets.SystemRandom().shuffle(pool)
    return "".join(pool)


def _get_or_create_default_admin():
    u = User.query.filter_by(username="admin").first()
    if not u:
        default_password = current_app.config.get("ADMIN_DEFAULT_PASSWORD", "") or _generate_random_password()
        u = User(username="admin", password_hash=generate_password_hash(default_password), role="admin", email_verified=True)
        db.session.add(u)
        db.session.commit()
    return u


@account_bp.post("/login")
@limiter.limit(LOGIN_LIMIT)
def login():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    password = data.get("password", "")
    if not username or not password:
        return jsonify(msg="用户名和密码不能为空"), 400
    ip_address = request.remote_addr or ""
    user_agent = request.user_agent.string or ""
    try:
        LoginGuard.check_login_allowed(username, ip_address)
    except AuthenticationError as e:
        return jsonify(msg=e.message, retry_after=getattr(e, "retry_after", None)), 429
    except Exception as e:
        logger.warning("⚠️ LoginGuard 检查失败: %s", e)
    _get_or_create_default_admin()
    user = User.query.filter_by(username=username).first()
    if not user or not check_password_hash(user.password_hash, password):
        try:
            LoginGuard.record_login_attempt(username, success=False, ip_address=ip_address, user_agent=user_agent, request_obj=request)
        except Exception as e:
            logger.warning("⚠️ LoginGuard 记录失败: %s", e)
        return jsonify(msg="用户名或密码错误"), 401
    if user.role != "admin" and not getattr(user, "email_verified", True):
        return jsonify(msg="请先验证您的邮箱后再登录"), 403
    user.last_login = datetime.now(timezone.utc)
    db.session.commit()
    try:
        LoginGuard.record_login_attempt(username, success=True, ip_address=ip_address, user_agent=user_agent, request_obj=request)
    except Exception as e:
        logger.warning("⚠️ LoginGuard 成功记录失败: %s", e)
    access = create_access_token(identity=str(user.id), additional_claims={"role": user.role, "username": user.username})
    refresh = create_refresh_token(identity=str(user.id))
    resp = jsonify(access_token=access, refresh_token=refresh, user=user.to_dict())
    set_access_cookies(resp, access)
    set_refresh_cookies(resp, refresh)
    _store_session(user, access)
    return resp


@account_bp.post("/refresh")
@limiter.limit(WRITE_LIMIT)
@jwt_required(refresh=True)
def refresh():
    claims = get_jwt()
    jti = claims.get("jti")
    exp = claims.get("exp")
    if jti and is_refresh_token_revoked(jti, user_id=get_jwt_identity()):
        return jsonify(msg="Refresh token 已失效，请重新登录"), 401
    uid = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    if jti and exp:
        delta = int(exp - time.time())
        if delta > 0:
            try:
                revoke_refresh_token(jti, delta, user_id=uid)
            except Exception as e:
                logger.warning("⚠️ 吊销旧 refresh token 失败: %s", e)
    access = create_access_token(identity=uid, additional_claims={"role": user.role, "username": user.username})
    refresh_token = create_refresh_token(identity=uid)
    resp = jsonify(access_token=access, refresh_token=refresh_token)
    set_access_cookies(resp, access)
    set_refresh_cookies(resp, refresh_token)
    return resp


@account_bp.get("/me")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def me():
    uid = get_jwt_identity()
    user = db.session.get(User, int(uid))
    if not user:
        return jsonify(msg="用户不存在"), 404
    return jsonify(user=user.to_dict())


@account_bp.post("/change-password")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def change_password():
    uid = get_jwt_identity()
    user = db.session.get(User, int(uid))
    data = request.get_json(silent=True) or {}
    old = data.get("old_password", "")
    new = data.get("new_password", "")
    if not check_password_hash(user.password_hash, old):
        return jsonify(msg="原密码错误"), 400
    ok, err_msg = validate_password_strength(new)
    if not ok:
        return jsonify(msg=err_msg), 400
    user.password_hash = generate_password_hash(new)
    db.session.commit()
    try:
        revoke_access_token(get_jwt().get("jti"), 60, user_id=uid)
    except Exception:
        pass
    return jsonify(msg="密码已更新")


@account_bp.post("/logout")
@limiter.limit(WRITE_LIMIT)
@jwt_required(optional=True)
def logout():
    try:
        claims = get_jwt()
        jti = claims.get("jti")
        exp = claims.get("exp")
        uid = get_jwt_identity()
        if jti and exp:
            delta = int(exp - time.time())
            if delta > 0:
                revoke_access_token(jti, delta, user_id=uid)
    except Exception as e:
        logger.warning("⚠️ 登出时 token 吊销遇到意外错误: %s", e)
    resp = jsonify(msg="已登出")
    unset_jwt_cookies(resp)
    return resp


@account_bp.post("/signup")
@limiter.limit(LOGIN_LIMIT)
def signup():
    data = request.get_json(silent=True) or {}
    username = data.get("username", "").strip()
    email = data.get("email", "").strip().lower()
    password = data.get("password", "")
    if not username or not email or not password:
        return jsonify(msg="用户名、邮箱和密码不能为空"), 400
    from api.auth import _EMAIL_RE, _USERNAME_RE
    if not _USERNAME_RE.match(username):
        return jsonify(msg="用户名只能包含字母、数字、下划线、连字符，长度 3-32 位"), 400
    if not _EMAIL_RE.match(email):
        return jsonify(msg="邮箱格式不正确"), 400
    ok, err_msg = validate_password_strength(password)
    if not ok:
        return jsonify(msg=err_msg), 400
    if User.query.filter_by(username=username).first():
        return jsonify(msg="用户名已被占用"), 409
    if User.query.filter(User.email == email).first():
        return jsonify(msg="该邮箱已注册"), 409
    user = User(username=username, email=email, password_hash=generate_password_hash(password), role="user", email_verified=False)
    db.session.add(user)
    db.session.flush()
    ev = EmailVerification.create_for(user.id, email)
    db.session.commit()
    sent = send_verification_email(email, username, ev.token)
    return jsonify(msg="注册成功，请查收验证邮件并点击链接激活账户", sent=sent), 201


@account_bp.route("/verify-email", methods=["GET", "POST"])
@limiter.limit(WRITE_LIMIT)
def verify_email():
    data = request.get_json(silent=True) or {}
    token = (data.get("token") or request.args.get("token", "")).strip()
    if not token:
        return jsonify(msg="缺少验证 token"), 400
    ev = EmailVerification.find_valid(token)
    if not ev:
        return jsonify(msg="验证链接无效或已过期，请重新申请"), 400
    user = db.session.get(User, ev.user_id)
    if not user:
        return jsonify(msg="用户不存在"), 404
    ev.activate()
    user.email_verified = True
    db.session.commit()
    try:
        send_welcome_email(ev.email, user.username)
    except Exception:
        pass
    return jsonify(msg="邮箱验证成功，现在可以登录了")


@account_bp.post("/resend-verification")
@limiter.limit(LOGIN_LIMIT)
def resend_verification():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    if not email:
        return jsonify(msg="请提供邮箱地址"), 400
    user = User.query.filter(User.email == email).first()
    if not user or getattr(user, "email_verified", True):
        return jsonify(msg="如果该邮箱已注册且未验证，验证邮件将在几分钟内送达"), 200
    ev = EmailVerification.create_for(user.id, email)
    db.session.commit()
    send_verification_email(email, user.username, ev.token)
    return jsonify(msg="验证邮件已重新发送，请查收"), 200


@account_bp.post("/request-password-reset")
@account_bp.post("/forgot-password")
@limiter.limit(LOGIN_LIMIT)
def request_password_reset():
    data = request.get_json(silent=True) or {}
    email = data.get("email", "").strip().lower()
    if not email:
        return jsonify(msg="请提供邮箱地址"), 400
    user = User.query.filter(User.email == email).first()
    if user:
        prt = PasswordResetToken.create_for(user.id, ttl_hours=1)
        db.session.commit()
        send_password_reset_email(email, user.username, prt.token)
    return jsonify(msg="如果该邮箱已注册，重置链接将在几分钟内送达"), 200


@account_bp.post("/reset-password")
@limiter.limit(WRITE_LIMIT)
def reset_password():
    data = request.get_json(silent=True) or {}
    token = data.get("token", "").strip()
    new_password = data.get("new_password", "")
    if not token or not new_password:
        return jsonify(msg="token 和新密码不能为空"), 400
    prt = PasswordResetToken.find_valid(token)
    if not prt:
        return jsonify(msg="重置链接无效或已过期，请重新申请"), 400
    ok, err_msg = validate_password_strength(new_password)
    if not ok:
        return jsonify(msg=err_msg), 400
    user = db.session.get(User, prt.user_id)
    if not user:
        return jsonify(msg="用户不存在"), 404
    user.password_hash = generate_password_hash(new_password)
    prt.consume()
    db.session.commit()
    return jsonify(msg="密码重置成功，请使用新密码登录")


# ── Sessions ───────────────────────────────────────────────────
@account_bp.get("/sessions")
@jwt_required()
def list_sessions():
    rows = _iter_sessions(get_jwt_identity())
    return jsonify({"sessions": rows, "count": len(rows)})

@account_bp.delete("/sessions/<session_id>")
@jwt_required()
def delete_session(session_id):
    current = (get_jwt() or {}).get("jti")
    if session_id == current:
        return jsonify(msg="当前会话不能在这里删除，请使用退出登录"), 400
    extensions.redis_client.delete(_session_key(session_id))
    try:
        revoke_access_token(session_id, 3600, user_id=get_jwt_identity())
    except Exception:
        pass
    return jsonify({"deleted": 1})

@account_bp.delete("/sessions")
@jwt_required()
def delete_other_sessions():
    uid = get_jwt_identity()
    current = (get_jwt() or {}).get("jti")
    deleted = 0
    for item in _iter_sessions(uid):
        sid = item.get("id")
        if sid and sid != current:
            extensions.redis_client.delete(_session_key(sid))
            try:
                revoke_access_token(sid, int(item.get("ttl") or 3600), user_id=uid)
            except Exception:
                pass
            deleted += 1
    return jsonify({"deleted": deleted})

# ── Users admin ────────────────────────────────────────────────
@account_bp.get("/users")
@limiter.limit(READ_LIMIT)
@admin_required
def list_users():
    role_filter = request.args.get("role", "").strip() or None
    query = User.query
    if role_filter:
        query = query.filter_by(role=role_filter)
    users = query.order_by(User.id.asc()).all()
    return jsonify({"users": [u.to_dict() for u in users], "count": len(users)})

@account_bp.patch("/users/<int:user_id>/role")
@limiter.limit(WRITE_LIMIT)
@admin_required
def update_user_role(user_id):
    data = request.get_json(silent=True) or {}
    new_role = (data.get("role") or "").strip()
    if not new_role:
        return jsonify(msg="role 字段不能为空"), 400
    if new_role not in {VIEWER_ROLE, USER_ROLE}:
        return jsonify(msg=f"非法角色值：{new_role}；可分配角色为 user, viewer"), 400
    user = db.session.get(User, user_id)
    if not user: return jsonify(msg="用户不存在"), 404
    if user.role == ADMIN_ROLE:
        return jsonify(msg="不能通过此接口修改 admin 账户角色"), 403
    user.role = new_role
    db.session.commit()
    return jsonify(msg="角色已更新", user=user.to_dict())

# ── Profile ────────────────────────────────────────────────────
@account_bp.patch("/profile")
def update_profile():
    data = request.get_json(silent=True) or {}
    uid = int(get_jwt_identity())
    user = db.session.get(User, uid)
    if not user: return jsonify({"error": "not found"}), 404
    if data.get("username"): user.username = data["username"]
    if data.get("email"): user.email = data["email"]
    db.session.commit()
    return jsonify({"updated": True})

# ── 2FA stubs ──────────────────────────────────────────────────
@account_bp.get("/2fa/status")
def twofa_status():
    return jsonify({"enabled": False})

@account_bp.post("/2fa/setup")
def twofa_setup():
    return jsonify({"secret": "", "otpauth_url": ""})

@account_bp.post("/2fa/enable")
def twofa_enable():
    return jsonify({"enabled": True})

@account_bp.post("/2fa/disable")
def twofa_disable():
    return jsonify({"disabled": True})

# ── External accounts stub ─────────────────────────────────────
@account_bp.get("/external-accounts")
def external_accounts():
    return jsonify({"accounts": {}, "oauth_providers": {"google": False, "github": False}})

@account_bp.delete("/external-accounts/<provider>")
def unlink_external_account(provider):
    return jsonify({"unlinked": True})

# ── OAuth providers stub ───────────────────────────────────────
@account_bp.get("/oauth/providers")
def oauth_providers():
    return jsonify({"google": False, "github": False})
