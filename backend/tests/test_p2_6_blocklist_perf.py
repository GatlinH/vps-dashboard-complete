"""
tests/test_p2_6_blocklist_perf.py
P2-6 blocklist 性能优化测试。

覆盖场景：
  5.  新 key 写入（v2）与读取命中（O(1) 路径）
  6.  撤销后拒绝、未撤销通过
  7.  旧 key（v1）兼容读取（_V1_COMPAT_READ=True）
  8.  TTL 与 token exp 对齐验证
  9.  大量 key 场景下不触发热路径 scan（mock/assert）
  10. 回归：is_user_force_revoked / revoke_all_user_tokens 行为不变
  11. user_id 缺失 token：app.py JWT callback 应拒绝
"""
from __future__ import annotations

import time
from unittest.mock import MagicMock, patch

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def blocklist(app):
    """在 app context 内提供 token_blocklist 模块。"""
    with app.app_context():
        import utils.token_blocklist as bl
        yield bl


# ─────────────────────────────────────────────────────────────────────────────
# 5. v2 key 写入与命中
# ─────────────────────────────────────────────────────────────────────────────

class TestV2KeyWriteAndRead:
    """v2 key 方案写入与 O(1) 读取命中测试。"""

    def test_revoke_token_with_user_id_writes_v2_key(self, app, blocklist):
        """提供 user_id 时，revoke_token 应写入 v2 key。"""
        import extensions

        jti = "test-jti-v2-001"
        user_id = "42"
        ttl = 60

        blocklist.revoke_token(jti, ttl, token_type="access", user_id=user_id)

        v2_key = f"revoked:access:{user_id}:{jti}"
        assert extensions.redis_client.exists(v2_key) == 1, (
            f"v2 key '{v2_key}' 应存在于 Redis 中"
        )

    def test_is_token_revoked_v2_path_hits_without_scan(self, app, blocklist):
        """is_token_revoked with user_id 应直接命中，不调用 scan_iter。"""
        import extensions

        jti = "test-jti-v2-002"
        user_id = "99"
        ttl = 60

        blocklist.revoke_token(jti, ttl, token_type="access", user_id=user_id)

        # 记录 scan_iter 调用
        scan_calls = []
        original_scan = extensions.redis_client.scan_iter
        def _spy_scan(pattern):
            scan_calls.append(pattern)
            return original_scan(pattern)

        extensions.redis_client.scan_iter = _spy_scan
        try:
            result = blocklist.is_token_revoked(jti, token_type="access", user_id=user_id)
        finally:
            extensions.redis_client.scan_iter = original_scan

        assert result is True, "v2 路径应命中撤销的 token"
        assert len(scan_calls) == 0, "热路径不应调用 scan_iter"

    def test_revoke_access_token_with_user_id(self, app, blocklist):
        """revoke_access_token 支持 user_id 参数。"""
        import extensions

        jti = "test-jti-access-uid"
        user_id = "7"
        blocklist.revoke_access_token(jti, 60, user_id=user_id)

        assert blocklist.is_access_token_revoked(jti, user_id=user_id) is True

    def test_revoke_refresh_token_with_user_id(self, app, blocklist):
        """revoke_refresh_token 支持 user_id 参数。"""
        import extensions

        jti = "test-jti-refresh-uid"
        user_id = "8"
        blocklist.revoke_refresh_token(jti, 60, user_id=user_id)

        assert blocklist.is_refresh_token_revoked(jti, user_id=user_id) is True


# ─────────────────────────────────────────────────────────────────────────────
# 6. 撤销后拒绝、未撤销通过
# ─────────────────────────────────────────────────────────────────────────────

class TestRevokeSemantics:
    """撤销语义不变：撤销拒绝、未撤销通过。"""

    def test_revoked_token_returns_true(self, app, blocklist):
        """撤销后 is_token_revoked 应返回 True。"""
        jti = "revoked-jti-001"
        user_id = "10"
        blocklist.revoke_token(jti, 60, token_type="access", user_id=user_id)

        assert blocklist.is_token_revoked(jti, token_type="access", user_id=user_id) is True

    def test_non_revoked_token_returns_false(self, app, blocklist):
        """未撤销的 token 应返回 False（不误杀）。"""
        jti = "fresh-jti-001"
        user_id = "11"

        assert blocklist.is_token_revoked(jti, token_type="access", user_id=user_id) is False

    def test_different_user_id_does_not_cross_hit(self, app, blocklist):
        """不同 user_id 的 token 不应互相影响。"""
        jti = "cross-jti-001"

        blocklist.revoke_token(jti, 60, token_type="access", user_id="uid-A")

        # uid-B 同 jti 未被撤销
        assert blocklist.is_token_revoked(jti, token_type="access", user_id="uid-B") is False

    def test_different_token_type_does_not_cross_hit(self, app, blocklist):
        """access 撤销不影响相同 jti 的 refresh 检查。"""
        jti = "type-cross-jti"
        user_id = "12"

        blocklist.revoke_token(jti, 60, token_type="access", user_id=user_id)

        assert blocklist.is_token_revoked(jti, token_type="refresh", user_id=user_id) is False


# ─────────────────────────────────────────────────────────────────────────────
# 7. v1 key 兼容读取
# ─────────────────────────────────────────────────────────────────────────────

class TestV1Compatibility:
    """旧 v1 key 兼容读取（_V1_COMPAT_READ=True）。"""

    def test_v1_key_is_read_when_compat_enabled(self, app, blocklist, monkeypatch):
        """_V1_COMPAT_READ=True 时，查询 user_id 已知的 token 若 v2 不存在，应回退查 v1。"""
        import extensions

        jti = "legacy-jti-001"
        user_id = "20"

        # 只写 v1 key（模拟旧写入路径）
        blocklist.revoke_token(jti, 60, token_type="access")  # user_id=None → v1

        monkeypatch.setattr(blocklist, "_V1_COMPAT_READ", True)

        result = blocklist.is_token_revoked(jti, token_type="access", user_id=user_id)
        assert result is True, "v1 兼容读取应命中旧 key"

    def test_v1_key_not_read_when_compat_disabled(self, app, blocklist, monkeypatch):
        """_V1_COMPAT_READ=False 时，v1 key 不再被读取。"""
        jti = "legacy-jti-002"
        user_id = "21"

        # 只写 v1 key
        blocklist.revoke_token(jti, 60, token_type="access")

        monkeypatch.setattr(blocklist, "_V1_COMPAT_READ", False)

        result = blocklist.is_token_revoked(jti, token_type="access", user_id=user_id)
        assert result is False, "compat 关闭后 v1 key 不应被读取"

    def test_revoke_without_user_id_writes_v1_key(self, app, blocklist):
        """未提供 user_id 时，应写 v1 key（向后兼容）。"""
        import extensions

        jti = "v1-write-jti-001"
        blocklist.revoke_token(jti, 60, token_type="access")

        v1_key = f"revoked:access:{jti}"
        assert extensions.redis_client.exists(v1_key) == 1


# ─────────────────────────────────────────────────────────────────────────────
# 8. TTL 与 token exp 对齐
# ─────────────────────────────────────────────────────────────────────────────

class TestTTLAlignment:
    """TTL 与 token 剩余有效期对齐验证。"""

    def test_ttl_matches_expires_delta(self, app, blocklist):
        """写入的 Redis key TTL 应与 expires_delta 对齐（允许 2 秒误差）。"""
        import extensions

        jti = "ttl-test-jti-001"
        user_id = "30"
        expires_delta = 300  # 5 分钟

        blocklist.revoke_token(jti, expires_delta, token_type="access", user_id=user_id)

        v2_key = f"revoked:access:{user_id}:{jti}"
        actual_ttl = extensions.redis_client.ttl(v2_key)
        assert abs(actual_ttl - expires_delta) <= 2, (
            f"TTL 应约为 {expires_delta}s，实际 {actual_ttl}s"
        )

    def test_zero_expires_delta_skips_revoke(self, app, blocklist):
        """expires_delta <= 0 时不写入 Redis（已过期 token 无需吊销）。"""
        import extensions

        jti = "expired-jti-001"
        user_id = "31"

        blocklist.revoke_token(jti, 0, token_type="access", user_id=user_id)

        v2_key = f"revoked:access:{user_id}:{jti}"
        v1_key = f"revoked:access:{jti}"
        assert extensions.redis_client.exists(v2_key) == 0
        assert extensions.redis_client.exists(v1_key) == 0

    def test_negative_expires_delta_skips_revoke(self, app, blocklist):
        """expires_delta < 0 时不写入 Redis。"""
        import extensions

        jti = "neg-ttl-jti-001"
        user_id = "32"

        blocklist.revoke_token(jti, -10, token_type="access", user_id=user_id)

        v2_key = f"revoked:access:{user_id}:{jti}"
        assert extensions.redis_client.exists(v2_key) == 0


# ─────────────────────────────────────────────────────────────────────────────
# 9. 大量 key 下不触发热路径 scan
# ─────────────────────────────────────────────────────────────────────────────

class TestNoHotPathScan:
    """验证热路径（is_token_revoked）不调用 scan_iter，即使 Redis 中有大量 key。"""

    def test_no_scan_iter_in_hot_path_with_many_keys(self, app, blocklist, monkeypatch):
        """写入 100 个 key 后，is_token_revoked 仍不使用 scan_iter。"""
        import extensions

        # 写入 100 个 v2 key
        for i in range(100):
            blocklist.revoke_token(
                f"bulk-jti-{i}", 60, token_type="access", user_id=str(i)
            )

        scan_calls = []
        original_scan = extensions.redis_client.scan_iter
        def _spy_scan(pattern):
            scan_calls.append(pattern)
            return original_scan(pattern)

        extensions.redis_client.scan_iter = _spy_scan
        try:
            result = blocklist.is_token_revoked(
                "bulk-jti-50", token_type="access", user_id="50"
            )
        finally:
            extensions.redis_client.scan_iter = original_scan

        assert result is True
        assert len(scan_calls) == 0, f"热路径不应调用 scan_iter，实际调用 {len(scan_calls)} 次"

    def test_get_blocklist_stats_is_not_called_by_is_token_revoked(self, app, blocklist):
        """is_token_revoked 不应调用 get_blocklist_stats（含 scan）。"""
        import extensions

        jti = "stats-check-jti"
        user_id = "99"
        blocklist.revoke_token(jti, 60, token_type="access", user_id=user_id)

        scan_calls = []
        original_scan = extensions.redis_client.scan_iter
        def _spy_scan(pattern):
            scan_calls.append(pattern)
            return original_scan(pattern)

        extensions.redis_client.scan_iter = _spy_scan
        try:
            _ = blocklist.is_token_revoked(jti, token_type="access", user_id=user_id)
        finally:
            extensions.redis_client.scan_iter = original_scan

        assert scan_calls == [], "is_token_revoked 不应触发 scan"


# ─────────────────────────────────────────────────────────────────────────────
# 10. 回归：强制下线行为不变
# ─────────────────────────────────────────────────────────────────────────────

class TestForceLogoutRegression:
    """revoke_all_user_tokens / is_user_force_revoked 回归测试。"""

    def test_revoke_all_user_tokens_sets_marker(self, app, blocklist):
        """revoke_all_user_tokens 应在 Redis 中设置强制下线标记。"""
        import extensions

        user_id = 55
        result = blocklist.revoke_all_user_tokens(user_id)
        assert result == 1

        key = f"revoked:user:{user_id}:forced_at"
        assert extensions.redis_client.get(key) is not None

    def test_is_user_force_revoked_true_for_old_iat(self, app, blocklist):
        """iat 早于 forced_at 时 is_user_force_revoked 应返回 True。"""
        user_id = 56
        blocklist.revoke_all_user_tokens(user_id)
        old_iat = time.time() - 10  # 10 秒前签发
        assert blocklist.is_user_force_revoked(user_id, old_iat) is True

    def test_is_user_force_revoked_false_for_new_iat(self, app, blocklist):
        """iat 在 forced_at 之后签发的 token 不应被强制下线覆盖。"""
        user_id = 57
        blocklist.revoke_all_user_tokens(user_id)
        future_iat = time.time() + 5  # 未来签发
        assert blocklist.is_user_force_revoked(user_id, future_iat) is False


# ─────────────────────────────────────────────────────────────────────────────
# 11. user_id 缺失 token 在 app.py 被拒绝
# ─────────────────────────────────────────────────────────────────────────────

class TestMissingUserIdRejection:
    """app.py JWT callback：user_id（sub）缺失时应拒绝 token。"""

    def test_token_without_sub_is_rejected_by_blocklist_check(self, app):
        """JWT payload 缺少 sub 时，check_if_token_revoked 应返回 True（拒绝）。"""
        with app.app_context():
            from app import create_app as _create_app

            # 直接获取 jwt.token_in_blocklist_loader 绑定的回调
            from extensions import jwt as _jwt

            # 模拟 payload 缺少 sub
            jwt_header = {"alg": "HS256"}
            jwt_payload = {
                "jti": "no-sub-jti",
                "exp": int(time.time()) + 300,
                "iat": int(time.time()),
                # 故意不包含 "sub"
            }

            # 找到注册的 callback（flask-jwt-extended 存储在 _token_in_blocklist_callback）
            callbacks = getattr(_jwt, "_token_in_blocklist_callback", None)
            if callbacks is None:
                # 不同版本的 flask-jwt-extended 存储方式不同
                pytest.skip("无法访问 token_in_blocklist callback，跳过")

            result = callbacks(jwt_header, jwt_payload)
            assert result is True, "缺少 sub 的 token 应被拒绝"
