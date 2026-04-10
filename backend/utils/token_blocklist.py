"""
utils/token_blocklist.py
JWT 令牌黑名单（吊销）机制，使用 Redis 存储。

key 格式：revoked:{jti}，TTL 与令牌剩余有效期一致。
"""
import logging
import extensions

logger = logging.getLogger(__name__)

_REVOKE_PREFIX = "revoked:"


def revoke_token(jti: str, expires_delta: int) -> None:
    """将 JTI 写入 Redis 黑名单，TTL 与令牌剩余有效期一致。

    Args:
        jti: JWT 的唯一标识符（jti claim）
        expires_delta: 令牌剩余有效秒数（用作 Redis TTL）
    """
    key = f"{_REVOKE_PREFIX}{jti}"
    extensions.redis_client.setex(key, expires_delta, "1")
    logger.debug(f"Token 已吊销: jti={jti}, ttl={expires_delta}s")


def is_token_revoked(jti: str) -> bool:
    """检查 JTI 是否在黑名单中。

    Args:
        jti: JWT 的唯一标识符（jti claim）

    Returns:
        True 表示已吊销，False 表示有效。
    """
    key = f"{_REVOKE_PREFIX}{jti}"
    return extensions.redis_client.exists(key) == 1
