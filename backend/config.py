"""
配置文件 — 支持 .env 覆盖

生产环境必须通过环境变量覆盖所有带 *WEAK_DEFAULT* 标记的值。
应用启动时会检查关键密钥，若仍为弱默认值则打印明确警告，
在 FLASK_ENV=production 时直接拒绝启动。
"""
import os
import sys
import logging
from datetime import timedelta
from dotenv import load_dotenv
from urllib.parse import quote as _url_quote

load_dotenv()

logger = logging.getLogger(__name__)

# ── 生产配置缺失 sentinel（绝不提供可用的静态生产 secret） ────────────────
# 仅用于产生清晰错误：正常生产部署由 install.sh 写入随机值到 secrets.env。
_MISSING_SECRET_KEY = "__VPS_DASHBOARD_SECRET_KEY_MISSING__"
_MISSING_JWT_SECRET_KEY = "__VPS_DASHBOARD_JWT_SECRET_KEY_MISSING__"
_LEGACY_WEAK_SECRET_KEYS = {
    "change-me-in-production",
    "change-me-in-production-32chars!",
    "change-me-jwt-secret",
}
_LEGACY_WEAK_MYSQL_PASSWORDS = {"vps_pass", "password", "root"}


def _is_strong_password(value: str) -> bool:
    """用于生产配置校验的最小强密码规则。

    安装器用 ``openssl rand -hex`` 生成 32+ 字符随机 hex，虽不含符号/大写，
    但熵远高于人工复杂口令，必须作为安全值接受。
    """
    if not value or len(value) < 12:
        return False
    if len(value) >= 32 and all(ch in "0123456789abcdefABCDEF" for ch in value):
        return True
    has_upper = any(ch.isupper() for ch in value)
    has_lower = any(ch.islower() for ch in value)
    has_digit = any(ch.isdigit() for ch in value)
    has_symbol = any(not ch.isalnum() for ch in value)
    return has_upper and has_lower and has_digit and has_symbol


def _parse_cors_origins(raw: str) -> list[str]:
    """解析并清洗 CORS 白名单。"""
    origins = []
    for item in (raw or '').split(','):
        origin = item.strip().rstrip('/')
        if not origin:
            continue
        if origin.startswith('http://') or origin.startswith('https://'):
            origins.append(origin)
    # 去重并保持顺序
    return list(dict.fromkeys(origins))


def _parse_csv(raw: str) -> list[str]:
    """解析逗号分隔配置并去重。"""
    items = []
    for item in (raw or "").split(","):
        val = item.strip()
        if val:
            items.append(val)
    return list(dict.fromkeys(items))


def _validate_production_secrets():
    """在非开发环境中检查关键密钥，若仍为弱默认值则终止启动。"""
    flask_env = os.getenv("FLASK_ENV", "").lower()
    if flask_env in ("development", "testing"):
        return  # 开发 / 测试环境放行

    errors = []

    secret_key = os.getenv("SECRET_KEY", _MISSING_SECRET_KEY)
    if secret_key in (_MISSING_SECRET_KEY, "") or secret_key in _LEGACY_WEAK_SECRET_KEYS:
        errors.append(
            "SECRET_KEY 仍为弱默认值。请在 .env 中设置长度 ≥ 32 的随机字符串。"
        )

    jwt_secret = os.getenv("JWT_SECRET_KEY", _MISSING_JWT_SECRET_KEY)
    if jwt_secret in (_MISSING_JWT_SECRET_KEY, "") or jwt_secret in _LEGACY_WEAK_SECRET_KEYS:
        errors.append(
            "JWT_SECRET_KEY 未设置或仍为弱默认值。请在 .env 中设置长度 ≥ 32 的随机字符串。"
        )

    mysql_password = os.getenv("MYSQL_PASSWORD", "")
    if mysql_password in _LEGACY_WEAK_MYSQL_PASSWORDS or not _is_strong_password(mysql_password):
        errors.append(
            "MYSQL_PASSWORD 缺失或强度不足。请通过安装器自动生成，或在 .env 中设置强随机密码。"
        )

    admin_default_password = os.getenv("ADMIN_DEFAULT_PASSWORD", "")
    if admin_default_password and not _is_strong_password(admin_default_password):
        errors.append(
            "ADMIN_DEFAULT_PASSWORD 强度不足。请使用长度 >= 12 且包含大小写/数字/符号的强密码，"
            "或留空以便首次启动自动生成随机强密码。"
        )

    cors_origins = _parse_cors_origins(os.getenv('CORS_ORIGINS', ''))
    if not cors_origins:
        errors.append("CORS_ORIGINS 未配置有效白名单（必须为 http(s) 源列表）。")
    if '*' in os.getenv('CORS_ORIGINS', ''):
        errors.append("生产环境禁止在 CORS_ORIGINS 使用通配符 *。")

    # FRONTEND_URL is required in production when email sending is enabled.
    smtp_mode = os.getenv("SMTP_MODE", "log").strip().lower()
    frontend_url = os.getenv("FRONTEND_URL", "").strip()
    if smtp_mode == "smtp":
        if not frontend_url:
            errors.append(
                "FRONTEND_URL 未设置。SMTP_MODE=smtp 时必须配置前端域名（如 https://panel.example.com），"
                " 否则邮件中的验证/重置链接将指向无效地址。"
            )
        elif "localhost" in frontend_url or "127.0.0.1" in frontend_url:
            errors.append(
                f"FRONTEND_URL={frontend_url!r} 包含 localhost/127.0.0.1。"
                " SMTP_MODE=smtp 时必须使用真实可访问的生产域名。"
            )

    # CSRF cookie protect must never be disabled in production (P1-7).
    if os.getenv("JWT_COOKIE_CSRF_PROTECT", "1").lower() in ("0", "false", "no"):
        errors.append(
            "JWT_COOKIE_CSRF_PROTECT 不得在生产环境中关闭。"
            " CSRF 防护是 httpOnly cookie 认证的必要安全层。"
        )

    # M-5: if Telegram is configured, its DB-stored bot_token must be encrypted.
    # An empty TELEGRAM_TOKEN_SECRET degrades EncryptedString to plaintext storage.
    if os.getenv("TELEGRAM_BOT_TOKEN", "").strip() and not os.getenv("TELEGRAM_TOKEN_SECRET", "").strip():
        errors.append(
            "TELEGRAM_TOKEN_SECRET 未设置。已配置 Telegram bot token 时必须设置该密钥，"
            " 否则 bot_token 将以明文存储在数据库中（拖库即泄露）。"
        )

    # JWT_COOKIE_SECURE must not be explicitly disabled in production.
    # Compute the actual value as Config does to catch all cases.
    _force_https = os.getenv("FORCE_HTTPS", "1")
    _jwt_secure_default = "0" if (_force_https == "0" or os.getenv("FLASK_ENV") == "development") else "1"
    _jwt_secure_raw = os.getenv(
        "JWT_COOKIE_SECURE",
        _jwt_secure_default,
    )
    if _force_https != "0" and _jwt_secure_raw.lower() not in ("1", "true", "yes"):
        errors.append(
            "JWT_COOKIE_SECURE 未启用。生产环境的认证 cookie 必须通过 HTTPS 传输（Secure 属性）。"
            " 请将 JWT_COOKIE_SECURE=1 写入 .env，或设置 FORCE_HTTPS=0 以明确运行在 HTTP 模式。"
        )

    if errors:
        for msg in errors:
            # 使用 print 而非 logger，确保在日志系统初始化前也能输出
            print(f"[FATAL] 生产环境安全校验失败: {msg}", file=sys.stderr)
        print(
            "[FATAL] 因安全配置不合规，应用拒绝在生产模式下启动。"
            " 请修改 .env 文件后重试。",
            file=sys.stderr,
        )
        sys.exit(1)


# 在模块加载时执行校验
_validate_production_secrets()


class Config:
    # ── 基本 ────────────────────────────────────────────────────────────────
    SECRET_KEY              = os.getenv("SECRET_KEY", _MISSING_SECRET_KEY)
    DEBUG                   = os.getenv("FLASK_DEBUG", "0") == "1"
    ADMIN_DEFAULT_PASSWORD  = os.getenv("ADMIN_DEFAULT_PASSWORD", "")

    # ── MySQL (SQLAlchemy) ───────────────────────────────────────────────────
    MYSQL_HOST         = os.getenv("MYSQL_HOST",     "127.0.0.1")
    MYSQL_PORT         = int(os.getenv("MYSQL_PORT", "3306"))
    MYSQL_USER         = os.getenv("MYSQL_USER",     "vps_user")
    MYSQL_PASSWORD     = os.getenv("MYSQL_PASSWORD", "")
    MYSQL_DB           = os.getenv("MYSQL_DB",       "vps_dashboard")
    SQLALCHEMY_DATABASE_URI = (
        f"mysql+pymysql://{MYSQL_USER}:{MYSQL_PASSWORD}"
        f"@{MYSQL_HOST}:{MYSQL_PORT}/{MYSQL_DB}?charset=utf8mb4"
    )
    SQLALCHEMY_TRACK_MODIFICATIONS = False
    SQLALCHEMY_POOL_RECYCLE        = 280   # 防止 MySQL 8h 断连

    # ── Redis ────────────────────────────────────────────────────────────────
    REDIS_HOST         = os.getenv("REDIS_HOST", "127.0.0.1")
    REDIS_PORT         = int(os.getenv("REDIS_PORT", "6379"))
    REDIS_PASSWORD     = os.getenv("REDIS_PASSWORD", "")
    REDIS_DB           = int(os.getenv("REDIS_DB",   "0"))
    # REDIS_URL is auto-assembled from REDIS_HOST/PORT/PASSWORD/DB above.
    # The REDIS_URL env var is intentionally NOT read; set the component vars instead.
    REDIS_URL          = (
        f"redis://:{_url_quote(REDIS_PASSWORD, safe='')}@{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
    if REDIS_PASSWORD
    else f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
)

    # ── Request body size limit (M-1: DoS via unbounded body) ────────────────
    # Global cap on request body size. Endpoints that legitimately need larger
    # payloads (e.g. site backup restore) validate/read their own bounds.
    # 4MB leaves headroom for the multipart envelope of the 2MB backup-restore
    # upload (form fields + boundaries) while still bounding JSON-body DoS.
    MAX_CONTENT_LENGTH = int(os.getenv("MAX_CONTENT_LENGTH", str(4 * 1024 * 1024)))

    # ── JWT ──────────────────────────────────────────────────────────────────
    JWT_SECRET_KEY            = os.getenv("JWT_SECRET_KEY", SECRET_KEY)
    JWT_ACCESS_TOKEN_EXPIRES  = timedelta(hours=8)
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=30)
    # Redis 异常时 JWT 黑名单检查是否放行（1=放行，0=拒绝）
    JWT_BLOCKLIST_FAIL_OPEN   = os.getenv("JWT_BLOCKLIST_FAIL_OPEN", "0") == "1"

    # ── JWT Cookie-based Auth (P1-7) ─────────────────────────────────────────
    # Accept tokens from both Authorization header (higher priority, backward compat)
    # and httpOnly cookies (browser clients). Header-first order means Bearer-header
    # requests are never subject to cookie CSRF checks.
    JWT_TOKEN_LOCATION      = ["headers", "cookies"]
    # Secure flag: True by default (HTTPS); explicitly set to False only in development.
    # Override via JWT_COOKIE_SECURE env var (1=True, 0=False).
    # Note: the cookie 'secure' attribute means the browser only sends it over HTTPS.
    force_https_env = os.getenv("FORCE_HTTPS")
    jwt_cookie_secure_default = "1"
    if force_https_env == "0":
        jwt_cookie_secure_default = "0"
    elif os.getenv("FLASK_ENV") == "development":
        jwt_cookie_secure_default = "0"
    JWT_COOKIE_SECURE       = os.getenv(
        "JWT_COOKIE_SECURE",
        jwt_cookie_secure_default,
    ) == "1"
    # CSRF protection for cookie-based tokens (double-submit pattern via flask-jwt-extended).
    # Always enabled; do NOT set to False in production.
    JWT_COOKIE_CSRF_PROTECT = True
    # SameSite attribute for JWT cookies. "Lax" is a safe default.
    JWT_COOKIE_SAMESITE     = os.getenv("JWT_COOKIE_SAMESITE", "Lax")
    # Access token cookie path covers all API routes.
    JWT_ACCESS_COOKIE_PATH  = "/"
    # Refresh token cookie is scoped to the refresh endpoint to minimise exposure.
    JWT_REFRESH_COOKIE_PATH = "/api/v1/auth/refresh"
    # Persistent cookies (not session-only): survive browser restarts within token TTL.
    JWT_SESSION_COOKIE      = False
    # Header name that the frontend must send with the CSRF token value.
    JWT_ACCESS_CSRF_HEADER_NAME  = "X-CSRF-Token"
    JWT_REFRESH_CSRF_HEADER_NAME = "X-CSRF-Token"
    # Domain attribute for JWT cookies (None = current domain only).
    # Set JWT_COOKIE_DOMAIN=.example.com to share auth cookies across sub-domains.
    JWT_COOKIE_DOMAIN       = os.getenv("JWT_COOKIE_DOMAIN") or None

    # ── CORS ─────────────────────────────────────────────────────────────────
    CORS_ORIGINS = _parse_cors_origins(
        os.getenv('CORS_ORIGINS', 'http://localhost:3000,http://localhost:5173')
    )
    # X-CSRF-Token is required for write requests when using httpOnly cookie auth.
    CORS_ALLOW_HEADERS = ['Content-Type', 'Authorization', 'X-Request-ID', 'X-CSRF-Token']
    CORS_EXPOSE_HEADERS = ['X-Total-Count', 'X-Page-Number', 'X-Request-ID']
    CORS_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
    CORS_SUPPORTS_CREDENTIALS = True
    CORS_MAX_AGE = int(os.getenv('CORS_MAX_AGE', '3600'))

    # ── Talisman / 安全头 ───────────────────────────────────────────────────
    FORCE_HTTPS = os.getenv('FORCE_HTTPS', '0') == '1'
    HSTS_ENABLED = os.getenv('HSTS_ENABLED', '0') == '1'
    HSTS_MAX_AGE = int(os.getenv('HSTS_MAX_AGE', '31536000'))
    HSTS_INCLUDE_SUBDOMAINS = os.getenv('HSTS_INCLUDE_SUBDOMAINS', '1') == '1'
    HSTS_PRELOAD = os.getenv('HSTS_PRELOAD', '1') == '1'
    AGENT_REQUIRE_TLS = os.getenv('AGENT_REQUIRE_TLS', '1') == '1'
    # Empty by default deliberately disables automatic public enrollment.
    # Operators may set a long random value to enable first-install registration.
    AGENT_ENROLLMENT_KEY = os.getenv('AGENT_ENROLLMENT_KEY', '').strip()
    AGENT_PUSH_RATE_LIMIT = os.getenv('AGENT_PUSH_RATE_LIMIT', '60 per minute')
    AGENT_POLL_RATE_LIMIT = os.getenv('AGENT_POLL_RATE_LIMIT', '120 per minute')
    AGENT_ACK_RATE_LIMIT = os.getenv('AGENT_ACK_RATE_LIMIT', '120 per minute')
    # AGENT_FALLBACK_DB_CONCURRENCY: Redis 不可用时，允许同时进行同步 DB 写入的最大并发数。
    # 超过此上限的请求将直接接受（202）但丢弃数据，避免数据库连接被高并发请求打爆。
    AGENT_FALLBACK_DB_CONCURRENCY = int(os.getenv('AGENT_FALLBACK_DB_CONCURRENCY', '5'))
    TRUST_PROXY = os.getenv('TRUST_PROXY', '0') == '1'
    PROXY_FIX_X_FOR = int(os.getenv('PROXY_FIX_X_FOR', '2'))
    PROXY_FIX_X_PROTO = int(os.getenv('PROXY_FIX_X_PROTO', '1'))
    PROXY_FIX_X_HOST = int(os.getenv('PROXY_FIX_X_HOST', '1'))
    PROXY_FIX_X_PORT = int(os.getenv('PROXY_FIX_X_PORT', '1'))
    PROXY_FIX_X_PREFIX = int(os.getenv('PROXY_FIX_X_PREFIX', '1'))

    SECURITY_CSP = {
        'default-src': "'self'",
        'script-src': [
            "'self'",
            # M-6: 'unsafe-eval' is REQUIRED by the WebGL stack bundled in the
            # frontend (CesiumJS / three.js / pixi.js / deck.gl use `new Function`
            # for runtime shader/template code generation — confirmed 8 call sites
            # in the built components-*.js chunk). Removing it white-screens the
            # globe/starship. Scripts are otherwise nonce-governed (see
            # SECURITY_CSP_NONCE_IN) and 'self'-restricted, so injected inline
            # scripts still cannot execute. Revisit only if the WebGL deps drop
            # their eval dependency.
            "'unsafe-eval'",
        ],
        'style-src': [
            "'self'",
            'https://fonts.googleapis.com',
        ],
        # Progress-bar fills render via inline `style="width:X%"`. Because
        # style-src carries a nonce, style-src-attr would otherwise inherit it
        # and strip every inline style attribute, saturating all meters to
        # 100%. Allow inline style attributes explicitly while <style>/<link>
        # elements stay nonce-governed through style-src above.
        'style-src-attr': [
            "'unsafe-inline'",
        ],
        'img-src': [
            "'self'",
            'data:',
            'https:',
        ],
        'font-src': [
            "'self'",
            'https://fonts.gstatic.com',
        ],
        'connect-src': [
            "'self'",
            'https://api.telegram.org',
            'https://ip-api.com',
            'https://cdn.jsdelivr.net',
            'https://services.arcgisonline.com',
        ],
        'frame-ancestors': "'none'",
        'base-uri': "'self'",
        'form-action': "'self'",
        'object-src': "'none'",
    }
    SECURITY_CSP_NONCE_IN = ['script-src', 'style-src']

    # ── Email (SMTP) ─────────────────────────────────────────────────────────
    SMTP_MODE     = os.getenv("SMTP_MODE",     "log")      # "smtp" | "log"
    SMTP_HOST     = os.getenv("SMTP_HOST",     "localhost")
    SMTP_PORT     = int(os.getenv("SMTP_PORT", "465"))
    SMTP_USE_TLS  = os.getenv("SMTP_USE_TLS",  "true").lower() == "true"
    SMTP_USER     = os.getenv("SMTP_USER",     "")
    SMTP_PASSWORD = os.getenv("SMTP_PASSWORD", "")
    SMTP_FROM     = os.getenv("SMTP_FROM",     "")
    # FRONTEND_URL: used to build links in verification/reset emails.
    # Default is localhost (development only). Production requires a real HTTPS URL
    # when SMTP_MODE=smtp (enforced by _validate_production_secrets).
    FRONTEND_URL  = os.getenv("FRONTEND_URL",  "http://localhost:5173")
    # Public origin agents use for install/push (include port for plain HTTP :4500).
    # Falls back to FRONTEND_URL in install-command builder when empty.
    PUBLIC_API_ROOT = os.getenv("PUBLIC_API_ROOT", "").strip()

    # ── Telegram ─────────────────────────────────────────────────────────────
    TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
    TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID",   "")
    # 用于对数据库中存储的 bot_token 进行对称加密，留空则退化为明文存储（不推荐生产使用）
    TELEGRAM_TOKEN_SECRET = os.getenv("TELEGRAM_TOKEN_SECRET", "")

    # ── Probe ────────────────────────────────────────────────────────────────
    PROBE_TIMEOUT_S    = int(os.getenv("PROBE_TIMEOUT_S", "5"))
    PROBE_CACHE_TTL    = int(os.getenv("PROBE_CACHE_TTL", "15"))   # seconds
    PROBE_BATCH_MAX_ITEMS = int(os.getenv("PROBE_BATCH_MAX_ITEMS", "50"))
    PROBE_BATCH_MIN_INTERVAL_S = float(os.getenv("PROBE_BATCH_MIN_INTERVAL_S", "3"))
    PROBE_BATCH_RATE_LIMIT = os.getenv("PROBE_BATCH_RATE_LIMIT", "6 per minute")
    PROBE_FETCH_RATE_LIMIT = os.getenv("PROBE_FETCH_RATE_LIMIT", "6 per minute")

    # ── Public IP 查询 ───────────────────────────────────────────────────────
    IP_INFO_RATE_LIMIT = os.getenv("IP_INFO_RATE_LIMIT", "60 per minute")
    # Anonymous scanner-path anomaly reporter: cap per-source writes so it cannot
    # be abused to flood the ops event table.
    SECURITY_SCAN_LOG_RATE_LIMIT = os.getenv("SECURITY_SCAN_LOG_RATE_LIMIT", "20 per minute")
    IP_INFO_CACHE_TTL = int(os.getenv("IP_INFO_CACHE_TTL", "3600"))

    # ── API Schema 版本同步 ──────────────────────────────────────────────────
    API_SCHEMA_VERSION = os.getenv("API_SCHEMA_VERSION", "2026-04-23")

    # ── AFF 外链域名安全策略 ─────────────────────────────────────────────────
    AFF_TRUSTED_DOMAINS = _parse_csv(
        os.getenv(
            "AFF_TRUSTED_DOMAINS",
            "racknerd.com,bandwagonhost.com,vultr.com,hetzner.com,dmit.io",
        )
    )
    # strict: 非白名单直接拒绝保存；warn: 允许保存但前端/接口会给强警告
    AFF_DOMAIN_POLICY = os.getenv("AFF_DOMAIN_POLICY", "strict").strip().lower()

    # ── Scheduler ────────────────────────────────────────────────────────────
    # SCHEDULER_TIMEZONE: 调度器时区，影响 cron 任务触发时间（如月度流量重置 00:05）。
    # 默认保持与历史行为兼容的 Asia/Shanghai。部署到其他时区时务必按需修改。
    SCHEDULER_TIMEZONE = os.getenv("SCHEDULER_TIMEZONE", "Asia/Shanghai")
    SCHEDULER_ALERT_ON_FAILURE = os.getenv("SCHEDULER_ALERT_ON_FAILURE", "1") == "1"
    SCHEDULER_FAILURE_ALERT_THRESHOLD = int(os.getenv("SCHEDULER_FAILURE_ALERT_THRESHOLD", "3"))
    # Raw telemetry is a short-window diagnostic source only. 30/90-day charts
    # read bounded hourly telemetry_rollups / ping_target_rollups instead, so the
    # raw window can stay short to keep disk usage bounded. Operators can raise
    # this via env if they need a longer raw diagnostic window.
    PROBE_RESULT_RETENTION_DAYS = int(os.getenv("PROBE_RESULT_RETENTION_DAYS", "7"))
    TELEMETRY_ROLLUP_RETENTION_DAYS = int(os.getenv("TELEMETRY_ROLLUP_RETENTION_DAYS", "180"))
    PING_ROLLUP_RETENTION_DAYS = int(os.getenv("PING_ROLLUP_RETENTION_DAYS", "180"))
    # ping_target_results (PING/peer latency samples) can grow fast when agents
    # sample every second. Keep a shorter, independently configurable window and
    # rely on daily partitioning + DROP PARTITION for bounded, cheap cleanup.
    PING_TARGET_RESULT_RETENTION_DAYS = int(os.getenv("PING_TARGET_RESULT_RETENTION_DAYS", "7"))
    # Number of future daily partitions to pre-create during the daily maintenance job.
    # Pre-creating partitions ensures data never falls into the pmax catchall partition,
    # which would prevent precise per-partition cleanup.  Only applies to MySQL.
    PROBE_RESULT_PARTITION_DAYS_AHEAD = int(os.getenv("PROBE_RESULT_PARTITION_DAYS_AHEAD", "30"))
    # Batch size for the ProbeResult cleanup loop inside delete_server and the
    # fallback batched DELETE in _job_cleanup.  Tune via .env if row density changes.
    PROBE_RESULT_DELETE_BATCH = int(os.getenv("PROBE_RESULT_DELETE_BATCH", "1000"))
    AGENT_COMMAND_RETENTION_DAYS = int(os.getenv("AGENT_COMMAND_RETENTION_DAYS", "7"))

    # ── Alert Cooldown (P3-8) ────────────────────────────────────────────────
    # ALERT_COOLDOWN_BACKEND: "redis" (default) or "db" (legacy fallback).
    #   redis — cooldown enforced via atomic SET NX EX in Redis (no DB write per check).
    #   db    — legacy: reads/writes AlertRule.last_fired in MySQL (original behaviour).
    # ALERT_COOLDOWN_FAIL_OPEN: when backend=redis and Redis is unreachable:
    #   True  (default, fail-open)  — allow the alert to fire (availability-first).
    #   False (fail-closed)         — suppress the alert (noise-reduction-first).
    # WARNING: fail-open may produce duplicate alerts during Redis outage.
    # WARNING: fail-closed may miss alerts during Redis outage.
    ALERT_COOLDOWN_BACKEND  = os.getenv("ALERT_COOLDOWN_BACKEND",  "redis").strip().lower()
    ALERT_COOLDOWN_FAIL_OPEN = os.getenv("ALERT_COOLDOWN_FAIL_OPEN", "1") == "1"

    # ── Audit payload size control ───────────────────────────────────────────
    # Maximum serialized size (bytes) of the new_values JSON column.
    # Payloads exceeding this limit are truncated with a _truncation_meta field.
    # Default 16 KB; set to 0 to disable truncation (not recommended).
    AUDIT_NEW_VALUES_MAX_BYTES = int(os.getenv("AUDIT_NEW_VALUES_MAX_BYTES", "16384"))

    # ── Geo tile proxy ───────────────────────────────────────────────────────
    TILE_CACHE_TTL     = int(os.getenv("TILE_CACHE_TTL",  "86400")) # 24h
    TILE_BURST_LIMIT   = int(os.getenv("TILE_BURST_LIMIT", "120"))
    TILE_BURST_WINDOW_S = int(os.getenv("TILE_BURST_WINDOW_S", "10"))
    COUNTRIES_CACHE_TTL = int(os.getenv("COUNTRIES_CACHE_TTL", str(7 * 86400)))


class DevelopmentConfig(Config):
    DEBUG = True


class ProductionConfig(Config):
    DEBUG = False
    SQLALCHEMY_POOL_SIZE    = 20
    SQLALCHEMY_MAX_OVERFLOW = 10


def get_config():
    """根据 FLASK_ENV 环境变量返回对应的配置类"""
    env = os.getenv("FLASK_ENV", "development")
    if env == "production":
        return ProductionConfig
    return DevelopmentConfig
