"""
utils/token_blocklist.py
JWT 令牌黑名单（吊销）机制，使用 Redis 存储。

Key 方案（当前版本，v2）：
  access  —— key: revoked:access:{user_id}:{jti}
  refresh —— key: revoked:refresh:{user_id}:{jti}

旧 key 方案（v1，已废弃但兼容读取）：
  access  —— key: revoked:access:{jti}
  refresh —— key: revoked:refresh:{jti}

兼容迁移策略：
  - 写入：始终写 v2 key（user_id 已知时）
  - 读取：先查 v2 key（O(1)）；v2 未命中且 user_id 未知时，仍可回退查 v1 key
  - 迁移窗口：旧 v1 key 随 TTL 自然过期，无需主动删除
  - 淘汰策略：v1 key 的最长 TTL 为 access token 有效期（默认 15 min）或
    refresh token 有效期（默认 30 天）。窗口期结束后可移除 _check_v1_compat 逻辑。

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

# 是否开启 v1 旧 key 兼容读取（迁移窗口期内保持 True；窗口关闭后设为 False）
_V1_COMPAT_READ = True


def _resolve_prefix(token_type: str) -> str:
    """根据 token_type 返回对应的 Redis key 前缀。"""
    normalized = (token_type or "access").strip().lower()
    prefix = _TOKEN_PREFIX_MAP.get(normalized)
    if prefix:
        return prefix
    logger.warning("未知 token_type=%s，回退为 access 黑名单前缀", token_type)
    return _PREFIX_ACCESS


def _build_v2_key(prefix: str, user_id, jti: str) -> str:
    """构造 v2 key: revoked:{type}:{user_id}:{jti}"""
    return f"{prefix}{user_id}:{jti}"


def _build_v1_key(prefix: str, jti: str) -> str:
    """构造 v1 key（兼容旧格式）: revoked:{type}:{jti}"""
    return f"{prefix}{jti}"


# ── 吊销 ─────────────────────────────────────────────────────────────────────

def revoke_token(
    jti: str,
    expires_delta: int,
    token_type: str = "access",
    user_id=None,
) -> None:
    """将 JTI 写入 Redis 黑名单。

    Args:
        jti:           JWT 的唯一标识符（jti claim）
        expires_delta: 令牌剩余有效秒数（用作 Redis TTL），必须 > 0
        token_type:    "access"（默认）或 "refresh"
        user_id:       用户 ID（可选）。提供时写 v2 key；未提供时写 v1 key（兼容旧调用）。
    """
    if expires_delta <= 0:
        logger.debug("Token 已过期，无需吊销: jti=%s", jti)
        return

    prefix = _resolve_prefix(token_type)

    if user_id is not None:
        key = _build_v2_key(prefix, user_id, jti)
    else:
        key = _build_v1_key(prefix, jti)

    extensions.redis_client.setex(key, expires_delta, "1")
    logger.debug(
        "Token 已吊销: type=%s jti=%s user_id=%s ttl=%ds",
        token_type, jti, user_id, expires_delta,
    )


def revoke_access_token(jti: str, expires_delta: int, user_id=None) -> None:
    """吊销 Access Token（语义化封装）"""
    revoke_token(jti, expires_delta, token_type="access", user_id=user_id)


def revoke_refresh_token(jti: str, expires_delta: int, user_id=None) -> None:
    """吊销 Refresh Token（语义化封装）"""
    revoke_token(jti, expires_delta, token_type="refresh", user_id=user_id)


# ── 检查 ─────────────────────────────────────────────────────────────────────

def is_token_revoked(jti: str, token_type: str = "access", user_id=None) -> bool:
    """检查 JTI 是否在黑名单中。

    查询策略（O(1)）：
      1. user_id 已知 → 直接构造 v2 key 查询（revoked:{type}:{user_id}:{jti}）
      2. user_id 未知 + _V1_COMPAT_READ → 同时查 v1 key（迁移期兼容）
      3. user_id 未知 + not _V1_COMPAT_READ → 只查 v1（降级，迁移期结束后应传 user_id）

    注意：user_id 缺失/异常 token 在调用方（app.py）应拒绝并记录原因。

    Args:
        jti:        JWT 的唯一标识符（jti claim）
        token_type: "access"（默认）或 "refresh"
        user_id:    用户 ID（可选，推荐提供以走 O(1) 路径）

    Returns:
        True 表示已吊销，False 表示有效。
    """
    prefix = _resolve_prefix(token_type)

    if user_id is not None:
        # O(1) 直接 key 查询（v2 路径）
        v2_key = _build_v2_key(prefix, user_id, jti)
        if extensions.redis_client.exists(v2_key) == 1:
            return True
        # v2 未命中时，兼容窗口期内还需检查 v1 key（旧写入路径残留）
        if _V1_COMPAT_READ:
            v1_key = _build_v1_key(prefix, jti)
            return extensions.redis_client.exists(v1_key) == 1
        return False
    else:
        # user_id 未知：只能查 v1 key（O(1)，key 已知）
        v1_key = _build_v1_key(prefix, jti)
        return extensions.redis_client.exists(v1_key) == 1


def is_access_token_revoked(jti: str, user_id=None) -> bool:
    """检查 Access Token 是否已吊销"""
    return is_token_revoked(jti, token_type="access", user_id=user_id)


def is_refresh_token_revoked(jti: str, user_id=None) -> bool:
    """检查 Refresh Token 是否已吊销"""
    return is_token_revoked(jti, token_type="refresh", user_id=user_id)


# ── 批量吊销（用于强制下线） ──────────────────────────────────────────────────

def revoke_all_user_tokens(user_id: int) -> int:
    """
    强制下线指定用户：在 Redis 中记录该用户的强制下线时间戳。
    凡是严格在该时间戳之前签发的 token 均视为已失效；
    在该时间戳之后签发的 token 仍有效，确保下线后重新登录的新会话可正常使用。

    forced_at 设为下一整秒边界（int(time.time()) + 1），确保在相同秒内签发的
    旧 token 一定被覆盖，同时新登录（iat >= forced_at）仍有效。

    需在 JWT blocklist 检查处同时调用 is_user_force_revoked()（已在 app.py 配置）。

    Returns:
        1 表示已设置强制下线标记，0 表示 Redis 写入失败。
    """
    key = f"{_PREFIX_USER}{user_id}:forced_at"
    # 取下一整秒边界：确保当前秒内的所有 token 都被覆盖，新登录（iat >= forced_at）则有效
    forced_at = int(time.time()) + 1
    try:
        extensions.redis_client.setex(key, _FORCE_LOGOUT_TTL, str(forced_at))
        logger.info("用户强制下线已设置: user_id=%s, forced_at=%s", user_id, forced_at)
        return 1
    except Exception as e:
        logger.error("设置用户强制下线标记失败: user_id=%s, error=%s", user_id, e)
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
    """返回黑名单中 access / refresh token 的数量（用于监控/调试）。

    注意：此函数使用 scan_iter，仅供调试/监控用途，禁止在热路径调用。
    生产环境建议限制调用频率（如每分钟一次）。
    """
    access_count  = sum(1 for _ in extensions.redis_client.scan_iter(f"{_PREFIX_ACCESS}*"))
    refresh_count = sum(1 for _ in extensions.redis_client.scan_iter(f"{_PREFIX_REFRESH}*"))
    return {
        "access_revoked":  access_count,
        "refresh_revoked": refresh_count,
        "total":           access_count + refresh_count,
    }
