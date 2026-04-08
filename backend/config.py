"""
配置文件 — 支持 .env 覆盖
"""
import os
from datetime import timedelta
from dotenv import load_dotenv

load_dotenv()

class Config:
    # ── 基本 ────────────────────────────────────────────────────────────────
    SECRET_KEY         = os.getenv("SECRET_KEY", "change-me-in-production-32chars!")
    DEBUG              = os.getenv("FLASK_DEBUG", "0") == "1"

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
