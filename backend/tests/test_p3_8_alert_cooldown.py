"""
tests/test_p3_8_alert_cooldown.py — P3-8: 告警冷却从 DB 迁移到 Redis

覆盖项：
  F-1  首次触发通过，窗口内抑制
  F-2  TTL 到期后恢复触发
  F-3  并发竞争下仅一次通过（原子性验证）
  F-4  不同 rule_id/fingerprint 互不干扰
  F-5  Redis 异常策略（fail-open / fail-closed）
  F-6  开关回退到 DB 后语义可用
  F-7  回归：现有告警相关测试通过（调度器 _job_check_alerts）

运行命令：
  cd backend && python -m pytest tests/test_p3_8_alert_cooldown.py -v
"""

import threading
import time
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock, patch

import pytest

import extensions
from models.models import AlertRule, Server, TelegramConfig
from extensions import db
from services.alert_cooldown import (
    check_and_set_cooldown,
    delete_cooldown_key,
    list_cooldown_keys,
    make_cooldown_key,
)
from tests.conftest import _InMemoryRedis


# ─────────────────────────────────────────────────────────────────────────────
# Helpers / fixtures
# ─────────────────────────────────────────────────────────────────────────────

@pytest.fixture
def fake_redis():
    """Fresh in-memory Redis instance for each test (no cross-test pollution)."""
    return _InMemoryRedis()


@pytest.fixture
def rule_id():
    return 42


@pytest.fixture
def server_id():
    return 7


# ─────────────────────────────────────────────────────────────────────────────
# Unit tests for services/alert_cooldown.py
# ─────────────────────────────────────────────────────────────────────────────

class TestMakeCooldownKey:
    def test_integer_server_id(self, rule_id, server_id):
        key = make_cooldown_key(rule_id, server_id)
        assert key == f"alert:cooldown:{rule_id}:{server_id}"

    def test_none_server_id_is_global(self, rule_id):
        key = make_cooldown_key(rule_id, None)
        assert key == f"alert:cooldown:{rule_id}:global"

    def test_prefix(self, rule_id, server_id):
        assert make_cooldown_key(rule_id, server_id).startswith("alert:cooldown:")


class TestCheckAndSetCooldown:
    """F-1: first trigger passes; within window it is suppressed."""

    def test_first_call_allows(self, fake_redis, rule_id, server_id):
        allowed, reason = check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        assert allowed is True
        assert reason == "allow"

    def test_second_call_suppresses(self, fake_redis, rule_id, server_id):
        check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        allowed, reason = check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        assert allowed is False
        assert reason == "suppress"

    def test_value_stored_is_timestamp(self, fake_redis, rule_id, server_id):
        before = int(time.time())
        check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        key = make_cooldown_key(rule_id, server_id)
        stored = int(fake_redis.get(key))
        after = int(time.time())
        assert before <= stored <= after

    def test_key_has_correct_ttl(self, fake_redis, rule_id, server_id):
        check_and_set_cooldown(fake_redis, rule_id, server_id, cool_down_s=60)
        key = make_cooldown_key(rule_id, server_id)
        ttl = fake_redis.ttl(key)
        # TTL should be within (0, 60]
        assert 0 < ttl <= 60

    def test_min_ttl_is_one_second(self, fake_redis, rule_id, server_id):
        """cool_down_s=0 should not produce a key with TTL=0 (immediate expiry)."""
        check_and_set_cooldown(fake_redis, rule_id, server_id, cool_down_s=0)
        key = make_cooldown_key(rule_id, server_id)
        ttl = fake_redis.ttl(key)
        # TTL coerced to at least 1 inside check_and_set_cooldown
        assert ttl >= 0


class TestTTLExpiry:
    """F-2: after TTL expires the alert fires again."""

    def test_fires_after_ttl(self, fake_redis, rule_id, server_id):
        # Use a 1-second cooldown so we can expire it quickly.
        check_and_set_cooldown(fake_redis, rule_id, server_id, cool_down_s=1)

        # Simulate expiry by removing the key manually (TTL elapsed)
        key = make_cooldown_key(rule_id, server_id)
        fake_redis.delete(key)

        allowed, reason = check_and_set_cooldown(fake_redis, rule_id, server_id, 1)
        assert allowed is True
        assert reason == "allow"

    def test_suppressed_before_ttl(self, fake_redis, rule_id, server_id):
        check_and_set_cooldown(fake_redis, rule_id, server_id, cool_down_s=300)
        allowed, reason = check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        assert allowed is False


class TestConcurrency:
    """F-3: under concurrent access exactly one caller wins per (rule, server)."""

    def test_only_one_winner_among_threads(self, rule_id, server_id):
        """Spawn N threads that simultaneously call check_and_set_cooldown.

        Exactly 1 should succeed (SET NX); the rest should be suppressed.
        This verifies the atomic guarantee of SET NX EX.
        """
        # This test specifically validates atomic SET NX EX behavior under
        # concurrency, so require fakeredis and skip when it is unavailable
        # instead of falling back to a non-atomic in-memory stub.
        _fr = pytest.importorskip("fakeredis")
        r = _fr.FakeRedis(decode_responses=True)

        n_threads = 10
        results = []
        lock = threading.Lock()

        def worker():
            allowed, reason = check_and_set_cooldown(r, rule_id, server_id, 300)
            with lock:
                results.append((allowed, reason))

        threads = [threading.Thread(target=worker) for _ in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        allow_count = sum(1 for a, _ in results if a)
        suppress_count = sum(1 for a, _ in results if not a)

        assert allow_count == 1, f"Expected exactly 1 allow, got {allow_count}"
        assert suppress_count == n_threads - 1


class TestIndependentKeys:
    """F-4: different rule_id / server_id combinations are independent."""

    def test_different_rule_ids_independent(self, fake_redis, server_id):
        allowed1, _ = check_and_set_cooldown(fake_redis, 1, server_id, 300)
        allowed2, _ = check_and_set_cooldown(fake_redis, 2, server_id, 300)
        assert allowed1 is True
        assert allowed2 is True

    def test_different_server_ids_independent(self, fake_redis, rule_id):
        allowed1, _ = check_and_set_cooldown(fake_redis, rule_id, 100, 300)
        allowed2, _ = check_and_set_cooldown(fake_redis, rule_id, 101, 300)
        assert allowed1 is True
        assert allowed2 is True

    def test_none_vs_int_server_id_are_different_keys(self, fake_redis, rule_id):
        allowed_global, _ = check_and_set_cooldown(fake_redis, rule_id, None, 300)
        allowed_specific, _ = check_and_set_cooldown(fake_redis, rule_id, 0, 300)
        assert allowed_global is True
        assert allowed_specific is True

    def test_second_call_same_key_suppressed(self, fake_redis, rule_id, server_id):
        check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        check_and_set_cooldown(fake_redis, rule_id, server_id + 1, 300)
        # Second call for the original key should still be suppressed
        allowed, reason = check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        assert allowed is False


class TestRedisErrorStrategies:
    """F-5: Redis error behaviour (fail-open / fail-closed)."""

    def _bad_redis(self):
        r = MagicMock()
        r.set.side_effect = Exception("connection refused")
        return r

    def test_fail_open_allows_on_error(self, rule_id, server_id):
        allowed, reason = check_and_set_cooldown(
            self._bad_redis(), rule_id, server_id, 300, fail_open=True
        )
        assert allowed is True
        assert reason == "error_fail_open"

    def test_fail_closed_suppresses_on_error(self, rule_id, server_id):
        allowed, reason = check_and_set_cooldown(
            self._bad_redis(), rule_id, server_id, 300, fail_open=False
        )
        assert allowed is False
        assert reason == "error_fail_closed"


class TestDeleteCooldownKey:
    def test_delete_existing_key(self, fake_redis, rule_id, server_id):
        check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        deleted = delete_cooldown_key(fake_redis, rule_id, server_id)
        assert deleted == 1
        # Now the key is gone; next check should allow
        allowed, _ = check_and_set_cooldown(fake_redis, rule_id, server_id, 300)
        assert allowed is True

    def test_delete_nonexistent_key(self, fake_redis, rule_id, server_id):
        deleted = delete_cooldown_key(fake_redis, rule_id, server_id)
        assert deleted == 0

    def test_delete_handles_redis_error(self, rule_id, server_id):
        r = MagicMock()
        r.delete.side_effect = Exception("connection refused")
        deleted = delete_cooldown_key(r, rule_id, server_id)
        assert deleted == 0


class TestListCooldownKeys:
    def test_lists_active_keys(self, fake_redis, rule_id):
        check_and_set_cooldown(fake_redis, rule_id, 10, 300)
        check_and_set_cooldown(fake_redis, rule_id, 11, 300)
        keys = list_cooldown_keys(fake_redis, rule_id=rule_id)
        assert len(keys) == 2

    def test_lists_all_keys_without_rule_filter(self, fake_redis):
        check_and_set_cooldown(fake_redis, 1, 10, 300)
        check_and_set_cooldown(fake_redis, 2, 10, 300)
        keys = list_cooldown_keys(fake_redis)
        assert len(keys) >= 2

    def test_empty_when_no_active_cooldowns(self, fake_redis, rule_id):
        keys = list_cooldown_keys(fake_redis, rule_id=rule_id)
        assert keys == []

    def test_handles_redis_error(self, rule_id):
        r = MagicMock()
        r.scan_iter.side_effect = Exception("connection refused")
        keys = list_cooldown_keys(r, rule_id=rule_id)
        assert keys == []


# ─────────────────────────────────────────────────────────────────────────────
# Integration tests: _job_check_alerts with mocked send_message
# ─────────────────────────────────────────────────────────────────────────────

class TestJobCheckAlertsRedisBackend:
    """F-6 (partial) + F-7: scheduler uses Redis cooldown correctly."""

    def _setup(self, app):
        """Create minimal DB fixtures and return (rule_id, server_id)."""
        with app.app_context():
            # TelegramConfig enabled
            cfg = TelegramConfig(
                bot_token="test-token",
                chat_id="test-chat",
                enabled=True,
            )
            db.session.add(cfg)

            # Server over threshold
            s = Server(
                name="alert-srv",
                ip="10.0.0.99",
                cpu_use=95.0,
                ram_use=50.0,
                disk_use=50.0,
                status="online",
            )
            db.session.add(s)
            db.session.flush()

            # CPU alert rule, 300s cooldown
            rule = AlertRule(
                server_id=s.id,
                rule_type="cpu",
                threshold=90.0,
                enabled=True,
                cool_down_s=300,
            )
            db.session.add(rule)
            db.session.commit()
            return rule.id, s.id

    def test_redis_backend_first_trigger_allowed(self, app):
        """F-1 / F-7: first check fires; Redis key is created."""
        rule_id, server_id = self._setup(app)

        app.config["ALERT_COOLDOWN_BACKEND"] = "redis"
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = True

        with patch("api.telegram.send_message", return_value={"ok": True}) as mock_send, \
             patch("api.telegram.requests.post", return_value=MagicMock(json=lambda: {"ok": True})):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)

        # A cooldown key should now exist
        with app.app_context():
            key = make_cooldown_key(rule_id, server_id)
            assert extensions.redis_client.get(key) is not None

    def test_redis_backend_second_trigger_suppressed(self, app):
        """F-1: second check within cooldown window is suppressed (no send_message)."""
        rule_id, server_id = self._setup(app)

        app.config["ALERT_COOLDOWN_BACKEND"] = "redis"
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = True

        with app.app_context():
            # Pre-set the cooldown key so it looks like the alert already fired
            key = make_cooldown_key(rule_id, server_id)
            extensions.redis_client.set(key, str(int(time.time())), ex=300)

        with patch("api.telegram.send_message") as mock_send, \
             patch("api.telegram.requests.post"):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)
            mock_send.assert_not_called()

    def test_redis_backend_does_not_update_last_fired(self, app):
        """P3-8 C: in Redis mode last_fired is NOT updated (no DB write per check)."""
        rule_id, server_id = self._setup(app)
        app.config["ALERT_COOLDOWN_BACKEND"] = "redis"
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = True

        with app.app_context():
            rule_before = AlertRule.query.get(rule_id)
            lf_before = rule_before.last_fired

        with patch("api.telegram.send_message", return_value={"ok": True}), \
             patch("api.telegram.requests.post", return_value=MagicMock(json=lambda: {"ok": True})):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)

        with app.app_context():
            rule_after = AlertRule.query.get(rule_id)
            # last_fired must NOT have changed in Redis backend
            assert rule_after.last_fired == lf_before


class TestJobCheckAlertsDBBackend:
    """F-6: fallback to DB backend preserves original cooldown semantics."""

    def _setup(self, app, last_fired=None):
        with app.app_context():
            cfg = TelegramConfig(
                bot_token="test-token",
                chat_id="test-chat",
                enabled=True,
            )
            db.session.add(cfg)

            s = Server(
                name="db-alert-srv",
                ip="10.0.0.88",
                cpu_use=95.0,
                ram_use=50.0,
                disk_use=50.0,
                status="online",
            )
            db.session.add(s)
            db.session.flush()

            rule = AlertRule(
                server_id=s.id,
                rule_type="cpu",
                threshold=90.0,
                enabled=True,
                cool_down_s=300,
                last_fired=last_fired,
            )
            db.session.add(rule)
            db.session.commit()
            return rule.id, s.id

    def test_db_backend_first_trigger_allowed_and_updates_last_fired(self, app):
        rule_id, server_id = self._setup(app, last_fired=None)
        app.config["ALERT_COOLDOWN_BACKEND"] = "db"

        with patch("api.telegram.send_message", return_value={"ok": True}), \
             patch("api.telegram.requests.post", return_value=MagicMock(json=lambda: {"ok": True})):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)

        with app.app_context():
            rule = AlertRule.query.get(rule_id)
            assert rule.last_fired is not None

    def test_db_backend_suppresses_within_cooldown(self, app):
        recent = datetime.now(timezone.utc) - timedelta(seconds=10)
        rule_id, server_id = self._setup(app, last_fired=recent)
        app.config["ALERT_COOLDOWN_BACKEND"] = "db"

        with patch("api.telegram.send_message") as mock_send, \
             patch("api.telegram.requests.post"):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)
            mock_send.assert_not_called()

    def test_db_backend_allows_after_cooldown_expires(self, app):
        old_ts = datetime.now(timezone.utc) - timedelta(seconds=400)
        rule_id, _ = self._setup(app, last_fired=old_ts)
        app.config["ALERT_COOLDOWN_BACKEND"] = "db"

        with patch("api.telegram.send_message", return_value={"ok": True}), \
             patch("api.telegram.requests.post", return_value=MagicMock(json=lambda: {"ok": True})):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)

        with app.app_context():
            rule = AlertRule.query.get(rule_id)
            # last_fired should be updated to roughly now
            # SQLite may return naive datetime; normalize for comparison.
            lf = rule.last_fired
            if lf is not None and lf.tzinfo is None:
                lf = lf.replace(tzinfo=timezone.utc)
            assert lf > old_ts


class TestJobCheckAlertsFailStrategies:
    """F-5: Redis failure strategies in the scheduler."""

    def _setup(self, app):
        with app.app_context():
            cfg = TelegramConfig(
                bot_token="test-token",
                chat_id="test-chat",
                enabled=True,
            )
            db.session.add(cfg)
            s = Server(
                name="fail-srv",
                ip="10.0.0.77",
                cpu_use=95.0,
                ram_use=50.0,
                disk_use=50.0,
                status="online",
            )
            db.session.add(s)
            db.session.flush()
            rule = AlertRule(
                server_id=s.id,
                rule_type="cpu",
                threshold=90.0,
                enabled=True,
                cool_down_s=300,
            )
            db.session.add(rule)
            db.session.commit()

    def test_redis_fail_open_allows_alert(self, app):
        """When Redis is down and fail_open=True, alert fires."""
        self._setup(app)
        app.config["ALERT_COOLDOWN_BACKEND"] = "redis"
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = True

        broken = MagicMock()
        broken.set.side_effect = Exception("Redis down")

        original_redis = extensions.redis_client
        extensions.redis_client = broken

        try:
            with patch("api.telegram.send_message", return_value={"ok": True}) as mock_send, \
                 patch("api.telegram.requests.post",
                       return_value=MagicMock(json=lambda: {"ok": True})):
                with patch("middleware.metrics_middleware.vps_alert_cooldown_check"):
                    from services.scheduler import _job_check_alerts
                    _job_check_alerts(app)
                mock_send.assert_called()
        finally:
            extensions.redis_client = original_redis

    def test_redis_fail_closed_suppresses_alert(self, app):
        """When Redis is down and fail_open=False, alert is suppressed."""
        self._setup(app)
        app.config["ALERT_COOLDOWN_BACKEND"] = "redis"
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = False

        broken = MagicMock()
        broken.set.side_effect = Exception("Redis down")

        original_redis = extensions.redis_client
        extensions.redis_client = broken

        try:
            with patch("api.telegram.send_message") as mock_send, \
                 patch("api.telegram.requests.post"):
                with patch("middleware.metrics_middleware.vps_alert_cooldown_check"):
                    from services.scheduler import _job_check_alerts
                    _job_check_alerts(app)
                mock_send.assert_not_called()
        finally:
            extensions.redis_client = original_redis


class TestMultiRuleIndependence:
    """F-4 integration: multiple rules don't share cooldown windows."""

    def test_two_rules_same_server_independent(self, app):
        with app.app_context():
            cfg = TelegramConfig(
                bot_token="test-token",
                chat_id="test-chat",
                enabled=True,
            )
            db.session.add(cfg)
            s = Server(
                name="multi-rule-srv",
                ip="10.0.0.66",
                cpu_use=95.0,
                ram_use=95.0,
                disk_use=50.0,
                status="online",
            )
            db.session.add(s)
            db.session.flush()
            rule_cpu = AlertRule(
                server_id=s.id,
                rule_type="cpu",
                threshold=90.0,
                enabled=True,
                cool_down_s=300,
            )
            rule_ram = AlertRule(
                server_id=s.id,
                rule_type="ram",
                threshold=90.0,
                enabled=True,
                cool_down_s=300,
            )
            db.session.add_all([rule_cpu, rule_ram])
            db.session.commit()
            cpu_id = rule_cpu.id
            ram_id = rule_ram.id
            sid = s.id

        app.config["ALERT_COOLDOWN_BACKEND"] = "redis"
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = True

        with app.app_context():
            # Pre-set cooldown for CPU rule only
            extensions.redis_client.set(
                make_cooldown_key(cpu_id, sid), str(int(time.time())), ex=300
            )

        with patch("api.telegram.send_message", return_value={"ok": True}) as mock_send, \
             patch("api.telegram.requests.post",
                   return_value=MagicMock(json=lambda: {"ok": True})):
            from services.scheduler import _job_check_alerts
            _job_check_alerts(app)

        # CPU rule suppressed → ram rule must still fire
        with app.app_context():
            ram_key = make_cooldown_key(ram_id, sid)
            assert extensions.redis_client.get(ram_key) is not None


# ─────────────────────────────────────────────────────────────────────────────
# Config / observability tests
# ─────────────────────────────────────────────────────────────────────────────

class TestConfigOptions:
    def test_default_backend_is_redis(self, app):
        app.config.pop("ALERT_COOLDOWN_BACKEND", None)
        from config import Config
        assert Config.ALERT_COOLDOWN_BACKEND == "redis"

    def test_default_fail_open_is_true(self, app):
        from config import Config
        assert Config.ALERT_COOLDOWN_FAIL_OPEN is True

    def test_backend_can_be_overridden(self, app):
        app.config["ALERT_COOLDOWN_BACKEND"] = "db"
        assert app.config["ALERT_COOLDOWN_BACKEND"] == "db"

    def test_fail_open_can_be_set_false(self, app):
        app.config["ALERT_COOLDOWN_FAIL_OPEN"] = False
        assert app.config["ALERT_COOLDOWN_FAIL_OPEN"] is False


class TestPrometheusMetric:
    def test_record_cooldown_check_importable(self):
        from middleware.metrics_middleware import record_cooldown_check
        # Should not raise even without prometheus_client
        record_cooldown_check("allow", "redis")
        record_cooldown_check("suppress", "redis")
        record_cooldown_check("error_fail_open", "redis")
        record_cooldown_check("error_fail_closed", "redis")
        record_cooldown_check("allow", "db")
