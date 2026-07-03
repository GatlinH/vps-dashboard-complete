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


