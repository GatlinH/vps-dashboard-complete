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

load_dotenv()

logger = logging.getLogger(__name__)

# ── 弱默认值常量（用于对比检测） ────────────────────────────────────────────
_WEAK_SECRET_KEY     = "change-me-in-production-32chars!"
_WEAK_JWT_SECRET_KEY = "change-me-jwt-secret"


def _validate_production_secrets():
    """在生产环境中检查关键密钥，若仍为弱默认值则终止启动。"""
    flask_env = os.getenv("FLASK_ENV", "development")
    if flask_env != "production":
        return  # 开发 / 测试环境放行

    errors = []

    secret_key = os.getenv("SECRET_KEY", _WEAK_SECRET_KEY)
    if secret_key in (_WEAK_SECRET_KEY, "", "change-me-in-production"):
        errors.append(
            "SECRET_KEY 仍为弱默认值。请在 .env 中设置长度 ≥ 32 的随机字符串。"
        )

    jwt_secret = os.getenv("JWT_SECRET_KEY", "")
    if not jwt_secret or jwt_secret in (_WEAK_JWT_SECRET_KEY, _WEAK_SECRET_KEY, "change-me-in-production"):
        errors.append(
            "JWT_SECRET_KEY 未设置或仍为弱默认值。请在 .env 中设置长度 ≥ 32 的随机字符串。"
        )

    mysql_password = os.getenv("MYSQL_PASSWORD", "vps_pass")
    if mysql_password in ("vps_pass", "password", "root", ""):
        errors.append(
            "MYSQL_PASSWORD 仍为弱默认值 (vps_pass)。请在 .env 中设置强密码。"
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
    SECRET_KEY              = os.getenv("SECRET_KEY", _WEAK_SECRET_KEY)
    DEBUG                   = os.getenv("FLASK_DEBUG", "0") == "1"
    ADMIN_DEFAULT_PASSWORD  = os.getenv("ADMIN_DEFAULT_PASSWORD", "")

    # ── MySQL (SQLAlchemy) ───────────────────────────────────────────────────
    MYSQL_HOST         = os.getenv("MYSQL_HOST",     "127.0.0.1")
    MYSQL_PORT         = int(os.getenv("MYSQL_PORT", "3306"))
    MYSQL_USER         = os.getenv("MYSQL_USER",     "vps_user")
    MYSQL_PASSWORD     = os.getenv("MYSQL_PASSWORD", "vps_pass")
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
    REDIS_URL          = (
        f"redis://:{REDIS_PASSWORD}@{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
        if REDIS_PASSWORD
        else f"redis://{REDIS_HOST}:{REDIS_PORT}/{REDIS_DB}"
    )

    # ── JWT ──────────────────────────────────────────────────────────────────
    JWT_SECRET_KEY            = os.getenv("JWT_SECRET_KEY", SECRET_KEY)
    JWT_ACCESS_TOKEN_EXPIRES  = timedelta(hours=8)
    JWT_REFRESH_TOKEN_EXPIRES = timedelta(days=30)

    # ── CORS ─────────────────────────────────────────────────────────────────
    CORS_ORIGINS = os.getenv("CORS_ORIGINS", "http://localhost:3000,http://localhost:5173").split(",")

    # ── Telegram ─────────────────────────────────────────────────────────────
    TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
    TELEGRAM_CHAT_ID   = os.getenv("TELEGRAM_CHAT_ID",   "")

    # ── Probe ────────────────────────────────────────────────────────────────
    PROBE_TIMEOUT_S    = int(os.getenv("PROBE_TIMEOUT_S", "5"))
    PROBE_CACHE_TTL    = int(os.getenv("PROBE_CACHE_TTL", "15"))   # seconds

    # ── Geo tile proxy ───────────────────────────────────────────────────────
    TILE_CACHE_TTL     = int(os.getenv("TILE_CACHE_TTL",  "86400")) # 24h


class DevelopmentConfig(Config):
    DEBUG = True

class ProductionConfig(Config):
    DEBUG = False
    SQLALCHEMY_POOL_SIZE    = 20
    SQLALCHEMY_MAX_OVERFLOW = 10
