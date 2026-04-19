"""
utils/token_blocklist.py
JWT 令牌黑名单（吊销）机制，使用 Redis 存储。

支持类型：
  access  —— key: revoked:access:{jti}
  refresh —— key: revoked:refresh:{jti}

TTL 与令牌剩余有效期一致，过期自动从 Redis 删除，无需手动清理。
"""

import logging
import extensions

logger = logging.getLogger(__name__)

_PREFIX_ACCESS  = "revoked:access:"
_PREFIX_REFRESH = "revoked:refresh:"
_TOKEN_PREFIX_MAP = {
    "access": _PREFIX_ACCESS,
    "refresh": _PREFIX_REFRESH,
}


def _resolve_prefix(token_type: str) -> str:
    """根据 token_type 返回对应的 Redis key 前缀。"""
    normalized = (token_type or "access").strip().lower()
    prefix = _TOKEN_PREFIX_MAP.get(normalized)
    if prefix:
        return prefix
    logger.warning("未知 token_type=%s，回退为 access 黑名单前缀", token_type)
    return _PREFIX_ACCESS


# ── 吊销 ─────────────────────────────────────────────────────────────────────

def revoke_token(jti: str, expires_delta: int, token_type: str = "access") -> None:
    """将 JTI 写入 Redis 黑名单。

    Args:
        jti:           JWT 的唯一标识符（jti claim）
        expires_delta: 令牌剩余有效秒数（用作 Redis TTL），必须 > 0
        token_type:    "access"（默认）或 "refresh"
    """
    if expires_delta <= 0:
        logger.debug(f"Token 已过期，无需吊销: jti={jti}")
        return

    prefix = _resolve_prefix(token_type)
    key    = f"{prefix}{jti}"
    extensions.redis_client.setex(key, expires_delta, "1")
    logger.debug(f"Token 已吊销: type={token_type} jti={jti} ttl={expires_delta}s")


def revoke_access_token(jti: str, expires_delta: int) -> None:
    """吊销 Access Token（语义化封装）"""
    revoke_token(jti, expires_delta, token_type="access")


def revoke_refresh_token(jti: str, expires_delta: int) -> None:
    """吊销 Refresh Token（语义化封装）"""
    revoke_token(jti, expires_delta, token_type="refresh")


# ── 检查 ─────────────────────────────────────────────────────────────────────

def is_token_revoked(jti: str, token_type: str = "access") -> bool:
    """检查 JTI 是否在黑名单中。

    Args:
        jti:        JWT 的唯一标识符（jti claim）
        token_type: "access"（默认）或 "refresh"

    Returns:
        True 表示已吊销，False 表示有效。
    """
    prefix = _resolve_prefix(token_type)
    key    = f"{prefix}{jti}"
    return extensions.redis_client.exists(key) == 1


def is_access_token_revoked(jti: str) -> bool:
    """检查 Access Token 是否已吊销"""
    return is_token_revoked(jti, token_type="access")


def is_refresh_token_revoked(jti: str) -> bool:
    """检查 Refresh Token 是否已吊销"""
    return is_token_revoked(jti, token_type="refresh")


# ── 批量吊销（用于强制下线） ──────────────────────────────────────────────────

def revoke_all_user_tokens(user_id: int) -> int:
    """
    强制下线：通过扫描 Redis 前缀删除该用户相关的所有黑名单记录。
    注意：此方法无法直接删除「尚未加入黑名单的有效 token」，
    适合配合 User.token_version（递增版本号）方案使用。
    返回删除的 key 数量（仅黑名单中已有的记录）。

    推荐用法：
        User.token_version += 1  # 令所有旧 token 在验证时失效
        db.session.commit()
    """
    # 按业务场景，此处仅清理黑名单（实际强制下线通常依赖 token_version）
    count = 0
    for prefix in (_PREFIX_ACCESS, _PREFIX_REFRESH):
        pattern = f"{prefix}*"
        for key in extensions.redis_client.scan_iter(pattern):
            extensions.redis_client.delete(key)
            count += 1
    if count:
        logger.info(f"已清理黑名单 token: user_id={user_id}, count={count}")
    return count


# ── 统计（调试用） ────────────────────────────────────────────────────────────

def get_blocklist_stats() -> dict:
    """返回黑名单中 access / refresh token 的数量（用于监控/调试）"""
    access_count  = sum(1 for _ in extensions.redis_client.scan_iter(f"{_PREFIX_ACCESS}*"))
    refresh_count = sum(1 for _ in extensions.redis_client.scan_iter(f"{_PREFIX_REFRESH}*"))
    return {
        "access_revoked":  access_count,
        "refresh_revoked": refresh_count,
        "total":           access_count + refresh_count,
    }
