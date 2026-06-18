"""
共享扩展实例 — 避免循环导入
"""
import redis
from flask_sqlalchemy import SQLAlchemy
from flask_jwt_extended import JWTManager

db           = SQLAlchemy()
jwt          = JWTManager()
redis_client: redis.Redis = None   # 由 create_app 注入


def init_redis(app):
    """在 app 上下文中初始化 Redis 客户端"""
    global redis_client
    redis_client = redis.from_url(
        app.config["REDIS_URL"],
        decode_responses=True,
        socket_timeout=10,
        socket_connect_timeout=5,
        health_check_interval=30,
        retry_on_timeout=True,
    )
    return redis_client
