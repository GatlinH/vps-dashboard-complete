"""
/api/auth  —  登录 / 刷新 / 登出 / 修改密码 / 注册 / 邮箱验证 / 密码重置
"""
import logging
import os
import base64
import hashlib
import hmac
import struct
from urllib.parse import quote

from authlib.integrations.flask_client import OAuth
import re
import secrets
import string
import time
import json
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app, redirect
from flask_jwt_extended import (
    create_access_token, create_refresh_token,
    jwt_required, get_jwt_identity, get_jwt,
    set_access_cookies, set_refresh_cookies, unset_jwt_cookies,
    get_csrf_token, decode_token,
)
from werkzeug.security import generate_password_hash, check_password_hash
from extensions import db
import extensions
from models.models import User, record_ops_event
from sqlalchemy import text
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
from middleware.rbac import admin_required, owner_required, ADMIN_ROLE, VIEWER_ROLE, USER_ROLE
from services.app_settings import get_admin_settings

auth_bp = Blueprint("auth", __name__)


# 允许管理员通过 API 分配的角色集合（不包含 admin，防止越权提权）
_ASSIGNABLE_ROLES = {VIEWER_ROLE, USER_ROLE}
logger  = logging.getLogger(__name__)

# ── 正则 ──────────────────────────────────────────────────────────────────────
_EMAIL_RE    = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_USERNAME_RE = re.compile(r"^[a-zA-Z0-9_\-]{3,32}$")


# ── 当前账户资料 / TOTP / 外部账户绑定工具 ─────────────────────────────────────

def _normalize_username(value: str) -> str:
    return (value or '').strip()

def _ensure_totp_secret() -> str:
    return base64.b32encode(os.urandom(20)).decode('ascii').rstrip('=')

def _totp_now(secret: str, interval: int = 30, digits: int = 6, for_time: int | None = None) -> str:
    secret = (secret or '').strip().replace(' ', '').upper()
    padding = '=' * ((8 - len(secret) % 8) % 8)
    key = base64.b32decode(secret + padding, casefold=True)
    counter = int((for_time if for_time is not None else time.time()) // interval)
    msg = struct.pack('>Q', counter)
    digest = hmac.new(key, msg, hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    code = struct.unpack('>I', digest[off:off+4])[0] & 0x7fffffff
    return str(code % (10 ** digits)).zfill(digits)

def _verify_totp(secret: str, code: str, window: int = 1) -> bool:
    code = ''.join(ch for ch in str(code or '') if ch.isdigit())
    if len(code) != 6 or not secret:
        return False
    now = int(time.time())
    for offset in range(-window, window + 1):
        if hmac.compare_digest(_totp_now(secret, for_time=now + offset * 30), code):
            return True
    return False

def _totp_otpauth_url(user: User, secret: str) -> str:
    issuer = 'VPS星图'
    label = f'{issuer}:{user.username}'
    from urllib.parse import quote as _q, urlencode as _urlencode
    qs = _urlencode({'secret': secret, 'issuer': issuer, 'algorithm': 'SHA1', 'digits': '6', 'period': '30'})
    return f'otpauth://totp/{_q(label)}?{qs}'

def _external_account_rows(user_id: int):
    db.session.execute(text("""CREATE TABLE IF NOT EXISTS user_oauth_accounts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        provider VARCHAR(32) NOT NULL,
        provider_user_id VARCHAR(128) DEFAULT '',
        provider_email VARCHAR(256) DEFAULT '',
        provider_name VARCHAR(256) DEFAULT '',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_user_provider (user_id, provider),
        KEY idx_user_id (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4"""))
    db.session.commit()
    rows = db.session.execute(text('SELECT provider, provider_user_id, provider_email, provider_name, created_at FROM user_oauth_accounts WHERE user_id=:uid ORDER BY provider'), {'uid': user_id}).mappings().all()
    return [dict(r) for r in rows]


# ── 内部工具 ──────────────────────────────────────────────────────────────────

def _revoke_current_access_token() -> None:
    """吊销当前请求的 access token"""
    claims = get_jwt()
    jti    = claims.get("jti")
    exp    = claims.get("exp")
    user_id = get_jwt_identity()
    if jti and exp:
        delta = int(exp - time.time())
        if delta > 0:
            try:
                revoke_access_token(jti, delta, user_id=user_id)
            except Exception as e:
                logger.warning(f"⚠️ 吊销 access token 失败: {e}")



def _session_redis_key(jti: str) -> str:
    return f"auth:session:{jti}"


def _fmt_ua(user_agent) -> str:
    try:
        platform = (user_agent.platform or '').strip().title()
        browser = (user_agent.browser or '').strip().title()
        version = (user_agent.version or '').strip()
        bits = [x for x in [platform, browser + (f"/{version}" if version else '')] if x]
        return ' '.join(bits) or (user_agent.string or '—')[:120]
    except Exception:
        return '—'


def _store_login_session(user: User, access_token: str) -> None:
    """Best-effort active-session registry for admin session management."""
    try:
        claims = decode_token(access_token)
        jti = claims.get('jti')
        exp = int(claims.get('exp') or 0)
        if not jti or not exp:
            return
        now = int(time.time())
        ttl = max(1, exp - now)
        ip = request.remote_addr or ''
        payload = {
            'id': jti,
            'user_id': str(user.id),
            'username': user.username,
            'ua': _fmt_ua(request.user_agent),
            'user_agent': request.user_agent.string or '',
            'ip': ip,
            'latest_ip': ip,
            'created_at': now,
            'last_login': now,
            'last_seen': now,
            'expires_at': exp,
        }
        extensions.redis_client.setex(_session_redis_key(jti), ttl, json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        logger.warning('记录登录会话失败: %s', exc)


def _touch_current_session() -> None:
    try:
        claims = get_jwt()
        jti = claims.get('jti')
        exp = int(claims.get('exp') or 0)
        if not jti or not exp:
            return
        key = _session_redis_key(jti)
        raw = extensions.redis_client.get(key)
        if not raw:
            return
        payload = json.loads(raw)
        payload['latest_ip'] = request.remote_addr or payload.get('latest_ip') or ''
        payload['last_seen'] = int(time.time())
        ttl = max(1, exp - int(time.time()))
        extensions.redis_client.setex(key, ttl, json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass


def _ensure_current_session_record() -> None:
    """Backfill the current JWT into Redis so old valid logins are visible in session management."""
    try:
        claims = get_jwt() or {}
        jti = claims.get('jti')
        exp = int(claims.get('exp') or 0)
        uid = get_jwt_identity()
        if not jti or not exp or not uid:
            return
        key = _session_redis_key(jti)
        raw = extensions.redis_client.get(key)
        if raw:
            _touch_current_session()
            return
        now = int(time.time())
        ttl = max(1, exp - now)
        user = db.session.get(User, int(uid)) if str(uid).isdigit() else None
        username = getattr(user, 'username', None) or claims.get('username') or str(uid)
        ip = request.remote_addr or ''
        payload = {
            'id': jti,
            'user_id': str(uid),
            'username': username,
            'ua': _fmt_ua(request.user_agent),
            'user_agent': request.user_agent.string or '',
            'ip': ip,
            'latest_ip': ip,
            'created_at': now,
            'last_login': now,
            'last_seen': now,
            'expires_at': exp,
            'backfilled': True,
        }
        extensions.redis_client.setex(key, ttl, json.dumps(payload, ensure_ascii=False))
    except Exception as exc:
        logger.warning('补登记当前会话失败: %s', exc)


def _iter_user_sessions(user_id: str):
    current_jti = None
    try:
        current_jti = (get_jwt() or {}).get('jti')
    except Exception:
        pass
    now = int(time.time())
    sessions = []
    try:
        for key in extensions.redis_client.scan_iter('auth:session:*'):
            raw = extensions.redis_client.get(key)
            if not raw:
                continue
            try:
                item = json.loads(raw)
            except Exception:
                continue
            if str(item.get('user_id')) != str(user_id):
                continue
            sid = item.get('id') or str(key).rsplit(':', 1)[-1]
            exp = int(item.get('expires_at') or 0)
            if exp and exp <= now:
                extensions.redis_client.delete(key)
                continue
            item['id'] = sid
            item['current'] = bool(current_jti and sid == current_jti)
            item['ttl'] = max(0, exp - now) if exp else 0
            sessions.append(item)
    except Exception as exc:
        logger.warning('读取会话列表失败: %s', exc)
    sessions.sort(key=lambda x: int(x.get('last_login') or x.get('created_at') or 0), reverse=True)
    return sessions

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


def _breakglass_allowed(username: str) -> bool:
    login = get_admin_settings().get("login", {})
    if not login.get("breakglass_enabled", True):
        return False
    username = (username or "").strip().lower()
    raw = str(login.get("breakglass_usernames") or os.getenv("BREAKGLASS_USERNAMES", ""))
    allowed = {x.strip().lower() for x in raw.split(",") if x.strip()}
    return bool(username and username in allowed)


def _oauth_allowed_emails() -> set[str]:
    settings = get_admin_settings().get("login", {})
    raw = str(settings.get("allowed_emails") or os.getenv("OAUTH_ADMIN_EMAILS", ""))
    return {x.strip().lower() for x in raw.split(",") if x.strip()}


def _oauth_secret(setting_key: str, env_key: str) -> str:
    settings = get_admin_settings().get("login", {})
    encrypted = str(settings.get(setting_key) or "").strip()
    if encrypted:
        from services.app_settings import _crypto
        crypto = _crypto()
        if crypto:
            try:
                return crypto.decrypt(encrypted)
            except Exception:
                logger.warning("⚠️ 解密 OAuth secret 失败: %s", setting_key)
    return os.getenv(env_key, "")


def _oauth_client_id(setting_key: str, env_key: str) -> str:
    settings = get_admin_settings().get("login", {})
    return str(settings.get(setting_key) or os.getenv(env_key, "")).strip()


def _oauth_enabled(provider: str) -> bool:
    provider = provider.lower()
    if provider == "google":
        return bool(_oauth_client_id("google_client_id", "GOOGLE_CLIENT_ID") and _oauth_secret("google_client_secret_encrypted", "GOOGLE_CLIENT_SECRET"))
    if provider == "github":
        return bool(_oauth_client_id("github_client_id", "GITHUB_CLIENT_ID") and _oauth_secret("github_client_secret_encrypted", "GITHUB_CLIENT_SECRET"))
    return False


def _issue_login_response(user: User):
    user.last_login = datetime.now(timezone.utc)
    db.session.commit()
    access = create_access_token(identity=str(user.id), additional_claims={"role": user.role, "username": user.username})
    refresh = create_refresh_token(identity=str(user.id))
    resp = redirect('/admin.html')
    set_access_cookies(resp, access)
    set_refresh_cookies(resp, refresh)
    _store_login_session(user, access)
    try:
        record_ops_event("login_success", "登录成功", message=f"{user.username} 登录成功", level="info", payload={"username": user.username, "user_id": user.id, "role": user.role, "ip": ip_address, "user_agent": user_agent[:180]})
        db.session.commit()
    except Exception as e:
        db.session.rollback(); logger.warning(f"⚠️ 登录日志记录失败: {e}")
    return resp


def _oauth_upsert_admin(provider: str, email: str, name: str | None = None) -> User:
    email = (email or '').strip().lower()
    if not email:
        raise AuthenticationError('OAuth 未返回邮箱')
    allow = _oauth_allowed_emails()
    if not allow or email not in allow:
        raise AuthenticationError('该邮箱未被授权登录管理后台')
    user = User.query.filter_by(email=email).first()
    if not user:
        base = (name or email.split('@')[0] or provider).strip()[:48] or provider
        username = base
        i = 1
        while User.query.filter_by(username=username).first():
            i += 1
            username = f'{base[:42]}-{i}'
        user = User(username=username, email=email, password_hash=generate_password_hash(os.urandom(24).hex()), role='admin', email_verified=True)
        db.session.add(user)
        db.session.commit()
    else:
        changed = False
        if user.role != 'admin':
            user.role = 'admin'
            changed = True
        if not user.email_verified:
            user.email_verified = True
            changed = True
        if changed:
            db.session.commit()
    return user


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
        try:
            record_ops_event("login_failed", "登录失败", message="用户名或密码为空", level="warn", payload={"username": username or "", "ip": request.remote_addr or ""})
            db.session.commit()
        except Exception as e:
            db.session.rollback(); logger.warning(f"⚠️ 登录日志记录失败: {e}")
        return jsonify(msg="用户名和密码不能为空"), 400

    login_settings = get_admin_settings().get("login", {})
    if login_settings.get("disable_password_login") and not _breakglass_allowed(username):
        if login_settings.get("sso_enabled") and (_oauth_enabled("github") or _oauth_enabled("google")):
            return jsonify(msg="密码登录已禁用，请使用单点登录"), 403
        return jsonify(msg="密码登录已被后台禁用"), 403

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
        try:
            record_ops_event("login_failed", "登录失败", message="用户名或密码错误", level="warn", payload={"username": username, "ip": ip_address, "user_agent": user_agent[:180]})
            db.session.commit()
        except Exception as e:
            db.session.rollback(); logger.warning(f"⚠️ 登录日志记录失败: {e}")
        return jsonify(msg="用户名或密码错误"), 401

    # 邮箱验证检查（admin 豁免）
    if user.role != "admin" and not getattr(user, "email_verified", True):
        return jsonify(msg="请先验证您的邮箱后再登录"), 403

    if bool(getattr(user, "totp_enabled", False)):
        totp_code = data.get("totp_code") or data.get("totpCode") or ""
        if not _verify_totp(getattr(user, "totp_secret", ""), totp_code):
            try:
                record_ops_event("login_failed", "登录失败", message="双因素验证码失败", level="warn", payload={"username": username, "ip": ip_address})
                db.session.commit()
            except Exception as e:
                db.session.rollback(); logger.warning(f"⚠️ 登录日志记录失败: {e}")
            return jsonify(msg="需要双因素验证码", two_factor_required=True), 401

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
    _store_login_session(user, access)
    try:
        record_ops_event("login_success", "登录成功", message=f"{user.username} 登录成功", level="info", payload={"username": user.username, "user_id": user.id, "role": user.role, "ip": ip_address, "user_agent": user_agent[:180]})
        db.session.commit()
    except Exception as e:
        db.session.rollback(); logger.warning(f"⚠️ 登录日志记录失败: {e}")
    return resp



@auth_bp.get("/oauth/providers")
def oauth_providers():
    # Avoid exposing OAuth provider configuration state by default. The login UI
    # can still use /oauth/<provider>/start, which returns an error if disabled.
    if os.getenv("PUBLIC_OAUTH_PROVIDER_DISCOVERY", "0") != "1":
        return jsonify({"google": False, "github": False})
    return jsonify({
        "google": _oauth_enabled("google"),
        "github": _oauth_enabled("github"),
    })


@auth_bp.get("/oauth/<provider>/start")
def oauth_start(provider: str):
    provider = (provider or '').lower()
    if provider not in {'google', 'github'}:
        return jsonify(msg='不支持的 OAuth 提供商'), 404
    if not _oauth_enabled(provider):
        return jsonify(msg=f'{provider} OAuth 尚未配置'), 503
    oauth_client = OAuth(current_app)
    base = request.host_url.rstrip('/')
    if provider == 'google':
        oauth_client.register(
            name='google',
            client_id=_oauth_client_id('google_client_id', 'GOOGLE_CLIENT_ID'),
            client_secret=_oauth_secret('google_client_secret_encrypted', 'GOOGLE_CLIENT_SECRET'),
            server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
            client_kwargs={'scope': 'openid email profile'},
        )
        return oauth_client.google.authorize_redirect(f'{base}/api/v1/auth/oauth/google/callback')
    oauth_client.register(
        name='github',
        client_id=_oauth_client_id('github_client_id', 'GITHUB_CLIENT_ID'),
        client_secret=_oauth_secret('github_client_secret_encrypted', 'GITHUB_CLIENT_SECRET'),
        access_token_url='https://github.com/login/oauth/access_token',
        authorize_url='https://github.com/login/oauth/authorize',
        api_base_url='https://api.github.com/',
        client_kwargs={'scope': 'read:user user:email'},
    )
    return oauth_client.github.authorize_redirect(f'{base}/api/v1/auth/oauth/github/callback')


@auth_bp.get("/oauth/google/callback")
def oauth_google_callback():
    if not _oauth_enabled('google'):
        return redirect('/admin.html?login_error=google_not_configured')
    oauth_client = OAuth(current_app)
    oauth_client.register(
        name='google',
        client_id=_oauth_client_id('google_client_id', 'GOOGLE_CLIENT_ID'),
        client_secret=_oauth_secret('google_client_secret_encrypted', 'GOOGLE_CLIENT_SECRET'),
        server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
        client_kwargs={'scope': 'openid email profile'},
    )
    try:
        token = oauth_client.google.authorize_access_token()
        userinfo = token.get('userinfo') or oauth_client.google.userinfo()
        email = (userinfo or {}).get('email')
        name = (userinfo or {}).get('name') or (userinfo or {}).get('given_name')
        user = _oauth_upsert_admin('google', email, name)
        return _issue_login_response(user)
    except Exception as e:
        logger.exception('google oauth failed: %s', e)
        return redirect('/admin.html?login_error=' + quote('Google 登录失败'))


@auth_bp.get("/oauth/github/callback")
def oauth_github_callback():
    if not _oauth_enabled('github'):
        return redirect('/admin.html?login_error=github_not_configured')
    oauth_client = OAuth(current_app)
    oauth_client.register(
        name='github',
        client_id=_oauth_client_id('github_client_id', 'GITHUB_CLIENT_ID'),
        client_secret=_oauth_secret('github_client_secret_encrypted', 'GITHUB_CLIENT_SECRET'),
        access_token_url='https://github.com/login/oauth/access_token',
        authorize_url='https://github.com/login/oauth/authorize',
        api_base_url='https://api.github.com/',
        client_kwargs={'scope': 'read:user user:email'},
    )
    try:
        oauth_client.github.authorize_access_token()
        profile = oauth_client.github.get('user').json()
        emails = oauth_client.github.get('user/emails').json()
        primary = next((e.get('email') for e in emails if e.get('primary')), None) or next((e.get('email') for e in emails if e.get('verified')), None)
        email = primary or profile.get('email')
        user = _oauth_upsert_admin('github', email, profile.get('name') or profile.get('login'))
        return _issue_login_response(user)
    except Exception as e:
        logger.exception('github oauth failed: %s', e)
        return redirect('/admin.html?login_error=' + quote('GitHub 登录失败'))



# ── 当前账户资料 / 2FA / 外部账号绑定 ───────────────────────────────────────────

@auth_bp.patch("/profile")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def update_profile():
    uid = int(get_jwt_identity())
    user = db.session.get(User, uid)
    if not user:
        return jsonify(msg="用户不存在"), 404
    data = request.get_json(silent=True) or {}
    username = _normalize_username(data.get("username", user.username))
    if not _USERNAME_RE.match(username):
        return jsonify(msg="用户名需为 3-32 位字母、数字、下划线或短横线"), 400
    exists = User.query.filter(User.username == username, User.id != user.id).first()
    if exists:
        return jsonify(msg="用户名已存在"), 409
    user.username = username
    db.session.commit()
    access = create_access_token(identity=str(user.id), additional_claims={"role": user.role, "username": user.username})
    refresh = create_refresh_token(identity=str(user.id))
    resp = jsonify(msg="用户名已更新", user=user.to_dict(), access_token=access, refresh_token=refresh)
    set_access_cookies(resp, access)
    set_refresh_cookies(resp, refresh)
    _store_login_session(user, access)
    return resp

@auth_bp.get("/2fa/status")
@limiter.limit(READ_LIMIT)
@jwt_required()
def twofa_status():
    user = db.session.get(User, int(get_jwt_identity()))
    return jsonify(enabled=bool(getattr(user, "totp_enabled", False)))

@auth_bp.post("/2fa/setup")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def twofa_setup():
    user = db.session.get(User, int(get_jwt_identity()))
    if bool(getattr(user, "totp_enabled", False)):
        return jsonify(msg="双因素认证已开启", enabled=True), 400
    secret = getattr(user, "totp_secret", None) or _ensure_totp_secret()
    user.totp_secret = secret
    db.session.commit()
    return jsonify(enabled=False, secret=secret, otpauth_url=_totp_otpauth_url(user, secret))

@auth_bp.post("/2fa/enable")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def twofa_enable():
    user = db.session.get(User, int(get_jwt_identity()))
    data = request.get_json(silent=True) or {}
    secret = getattr(user, "totp_secret", None) or data.get("secret") or _ensure_totp_secret()
    code = data.get("code") or data.get("totp_code") or ""
    if not _verify_totp(secret, code):
        return jsonify(msg="验证码错误"), 400
    user.totp_secret = secret
    user.totp_enabled = True
    if hasattr(user, 'totp_enabled_at'):
        user.totp_enabled_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify(msg="双因素认证已开启", enabled=True)

@auth_bp.post("/2fa/disable")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def twofa_disable():
    user = db.session.get(User, int(get_jwt_identity()))
    data = request.get_json(silent=True) or {}
    password = data.get("password", "")
    code = data.get("code") or data.get("totp_code") or ""
    if not check_password_hash(user.password_hash, password):
        return jsonify(msg="密码错误"), 400
    if bool(getattr(user, "totp_enabled", False)) and not _verify_totp(getattr(user, "totp_secret", ""), code):
        return jsonify(msg="验证码错误"), 400
    user.totp_enabled = False
    user.totp_secret = None
    if hasattr(user, 'totp_enabled_at'):
        user.totp_enabled_at = None
    db.session.commit()
    return jsonify(msg="双因素认证已关闭", enabled=False)

@auth_bp.get("/external-accounts")
@limiter.limit(READ_LIMIT)
@jwt_required()
def external_accounts():
    uid = int(get_jwt_identity())
    rows = _external_account_rows(uid)
    providers = {"google": None, "github": None}
    for r in rows:
        providers[r["provider"]] = r
    return jsonify(accounts=providers, oauth_providers={"google": _oauth_enabled("google"), "github": _oauth_enabled("github")})

@auth_bp.delete("/external-accounts/<provider>")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def external_account_unlink(provider: str):
    provider = (provider or '').lower()
    if provider not in {'google', 'github'}:
        return jsonify(msg='不支持的 OAuth 提供商'), 404
    uid = int(get_jwt_identity())
    _external_account_rows(uid)
    db.session.execute(text('DELETE FROM user_oauth_accounts WHERE user_id=:uid AND provider=:provider'), {'uid': uid, 'provider': provider})
    db.session.commit()
    return jsonify(msg='外部账户已解绑', accounts=_external_account_rows(uid))

@auth_bp.get("/external-accounts/<provider>/start")
@jwt_required()
def external_account_start(provider: str):
    provider = (provider or '').lower()
    if provider not in {'google', 'github'}:
        return jsonify(msg='不支持的 OAuth 提供商'), 404
    if not _oauth_enabled(provider):
        return jsonify(msg=f'{provider} OAuth 尚未配置'), 503
    return redirect(f'/api/v1/auth/oauth/{provider}/start')


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
    if jti and is_refresh_token_revoked(jti, user_id=get_jwt_identity()):
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
                revoke_refresh_token(jti, delta, user_id=uid)
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
    _store_login_session(user, new_access)
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
    _touch_current_session()
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

    new_access = create_access_token(
        identity=str(user.id),
        additional_claims={"role": user.role, "username": user.username},
    )
    new_refresh = create_refresh_token(identity=str(user.id))

    resp = jsonify(msg="密码已更新", access_token=new_access, refresh_token=new_refresh)
    set_access_cookies(resp, new_access)
    set_refresh_cookies(resp, new_refresh)
    _store_login_session(user, new_access)
    return resp


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
                uid = get_jwt_identity()
                revoke_refresh_token(rt_jti, delta, user_id=uid)
            except Exception as e:
                logger.warning(f"⚠️ 吊销 refresh token 失败: {e}")

    # Clear httpOnly auth cookies (P1-7).
    resp = jsonify(msg="已登出")
    try:
        claims = get_jwt() or {}
        if claims.get('jti'):
            extensions.redis_client.delete(_session_redis_key(claims.get('jti')))
    except Exception:
        pass
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

def _no_store_response(payload, status=200):
    resp = jsonify(payload)
    resp.status_code = status
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


def _verify_email_token(token: str):
    if not token:
        return _no_store_response({"msg": "缺少验证 token"}, 400)

    ev = EmailVerification.find_valid(token)
    if not ev:
        return _no_store_response({"msg": "验证链接无效或已过期，请重新申请"}, 400)

    user = db.session.get(User, ev.user_id)
    if not user:
        return _no_store_response({"msg": "用户不存在"}, 404)

    ev.activate()
    user.email_verified = True  # type: ignore[attr-defined]
    db.session.commit()

    try:
        send_welcome_email(ev.email, user.username)
    except Exception:
        pass

    return _no_store_response({"msg": "邮箱验证成功，现在可以登录了"})


@auth_bp.post("/verify-email")
@limiter.limit(WRITE_LIMIT)
def verify_email_post():
    """邮箱验证（推荐）：Body: { token }。邮件链接使用 #token，前端以 POST 消费。"""
    data = request.get_json(silent=True) or {}
    return _verify_email_token(data.get("token", "").strip())


@auth_bp.get("/verify-email")
@limiter.limit(WRITE_LIMIT)  # 兼容旧邮件链接；新邮件不再把 token 放入 query
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
    return _verify_email_token(request.args.get("token", "").strip())



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
        return _no_store_response({"msg": "重置链接无效或已过期，请重新申请"}, 400)

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
    return _no_store_response({"msg": "密码重置成功，请使用新密码登录"})


# ═══════════════════════════════════════════════════════════════════════════════
# 管理员用户管理（P1-1 / P1-4 修复）
# ─ 管理员可查询用户列表并将用户提升为 viewer，使其获得只读后台权限。
# ─ 仅允许分配 user / viewer 角色，admin 角色仍通过内部流程保持，避免越权风险。
# ═══════════════════════════════════════════════════════════════════════════════

@auth_bp.get("/sessions")
@limiter.limit(READ_LIMIT)
@jwt_required()
def list_sessions():
    """列出当前账户的活跃登录会话。"""
    _ensure_current_session_record()
    uid = get_jwt_identity()
    sessions = _iter_user_sessions(uid)
    return jsonify(sessions=sessions, count=len(sessions))


@auth_bp.delete("/sessions/<session_id>")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def delete_session(session_id: str):
    """删除/吊销指定会话；当前会话不可通过此接口删除。"""
    uid = get_jwt_identity()
    current_jti = (get_jwt() or {}).get('jti')
    if not session_id:
        return jsonify(msg='会话 ID 不能为空'), 400
    if session_id == current_jti:
        return jsonify(msg='当前会话不能在此删除，请使用退出登录'), 400
    key = _session_redis_key(session_id)
    raw = extensions.redis_client.get(key)
    if not raw:
        return jsonify(msg='会话不存在或已过期'), 404
    try:
        payload = json.loads(raw)
    except Exception:
        payload = {}
    if str(payload.get('user_id')) != str(uid):
        return jsonify(msg='会话不存在或无权删除'), 404
    ttl = extensions.redis_client.ttl(key)
    if ttl is None or ttl < 1:
        ttl = int(payload.get('expires_at') or time.time()) - int(time.time())
    revoke_access_token(session_id, max(1, int(ttl)), user_id=uid)
    extensions.redis_client.delete(key)
    return jsonify(msg='会话已删除', deleted=1)


@auth_bp.delete("/sessions")
@limiter.limit(WRITE_LIMIT)
@jwt_required()
def delete_other_sessions():
    """删除当前账户除当前会话外的全部活跃会话。"""
    uid = get_jwt_identity()
    current_jti = (get_jwt() or {}).get('jti')
    deleted = 0
    for item in _iter_user_sessions(uid):
        sid = item.get('id')
        if not sid or sid == current_jti:
            continue
        ttl = int(item.get('ttl') or 1)
        revoke_access_token(sid, max(1, ttl), user_id=uid)
        extensions.redis_client.delete(_session_redis_key(sid))
        deleted += 1
    return jsonify(msg='其它会话已删除', deleted=deleted)


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
