"""
utils/token_blocklist.py
JWT 令牌黑名单（吊销）机制，使用 Redis 存储。

支持类型：
  access  —— key: revoked:access:{jti}
  refresh —— key: revoked:refresh:{jti}

TTL 与令牌剩余有效期一致，过期自动从 Redis 删除，无需手动清理。

用户级强制下线：
  key: revoked:user:{user_id}:forced_at  —— 记录该用户强制下线的 Unix 时间戳
  TTL: _FORCE_LOGOUT_TTL（默认 31 天，覆盖 refresh token 最长有效期）
  is_user_force_revoked(user_id, token_iat) 检查指定用户的 token 是否在强制下线之前签发。
"""

import logging
import time
import extensions

logger = logging.getLogger(__name__)

_PREFIX_ACCESS  = "revoked:access:"
_PREFIX_REFRESH = "revoked:refresh:"
_PREFIX_USER    = "revoked:user:"
_TOKEN_PREFIX_MAP = {
    "access": _PREFIX_ACCESS,
    "refresh": _PREFIX_REFRESH,
}

# 用户级强制下线标记的 TTL：覆盖 refresh token 最长有效期（30 天）加一天缓冲
_FORCE_LOGOUT_TTL = 31 * 24 * 3600


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
    强制下线指定用户：在 Redis 中记录该用户的强制下线时间戳。
    凡是严格在该时间戳之前签发的 token 均视为已失效；
    在该时间戳之后（或同一时刻）签发的 token 仍有效，确保立即重新登录的新会话不被误封。

    需在 JWT blocklist 检查处同时调用 is_user_force_revoked()（已在 app.py 配置）。

    Returns:
        1 表示已设置强制下线标记，0 表示 Redis 写入失败。
    """
    key = f"{_PREFIX_USER}{user_id}:forced_at"
    forced_at = time.time()
    try:
        extensions.redis_client.setex(key, _FORCE_LOGOUT_TTL, str(forced_at))
        logger.info(f"用户强制下线已设置: user_id={user_id}, forced_at={forced_at}")
        return 1
    except Exception as e:
        logger.error(f"设置用户强制下线标记失败: user_id={user_id}, error={e}")
        return 0


def is_user_force_revoked(user_id, token_iat: float) -> bool:
    """
    检查指定用户是否处于强制下线状态，且 token 签发时间在强制下线时间之前。

    Args:
        user_id:   用户 ID（int 或可转为字符串的类型）
        token_iat: token 的 iat（issued-at）claim，Unix 时间戳（float）

    Returns:
        True 表示该 token 被用户级强制下线覆盖，应视为已失效。
        False 表示未被强制下线或 token 在强制下线后签发（仍有效）。
    """
    try:
        key = f"{_PREFIX_USER}{user_id}:forced_at"
        val = extensions.redis_client.get(key)
        if val is None:
            return False
        forced_at = float(val)
        return float(token_iat) < forced_at
    except Exception:
        return False


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
