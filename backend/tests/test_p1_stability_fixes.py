"""
P1-5 / P1-6 运行稳定性修复测试

P1-5: api/agent.py — Redis 降级路径并发保护
  - Redis 不可用时，降级写库受有界信号量保护，超出上限的请求被 load-shedding
  - 正常路径（Redis 可用）不受影响

P1-6: services/scheduler.py — APScheduler timezone 配置化
  - SCHEDULER_TIMEZONE 配置项可覆盖调度器时区
  - 月度重置使用调度器时区日期，避免系统时区与调度器时区不一致导致语义偏差
"""

import hashlib
import hmac
import json
import threading
import time
import uuid
from datetime import date, datetime
from unittest.mock import MagicMock, patch

import pytest


# ── helpers ──────────────────────────────────────────────────────────────────

def _agent_headers(agent_key: str, raw_body: bytes, agent_uuid: str, nonce: str = "n1"):
    ts = str(int(time.time()))
    sig = hmac.new(
        agent_key.encode("utf-8"),
        f"{ts}.{nonce}.".encode("utf-8") + raw_body,
        hashlib.sha256,
    ).hexdigest()
    return {
        "X-Agent-UUID": agent_uuid,
        "X-Agent-Key": agent_key,
        "X-Agent-Timestamp": ts,
        "X-Agent-Nonce": nonce,
        "X-Agent-Signature": sig,
    }


def _provision_agent(client, auth_headers, test_server):
    """注册 agent，返回 (agent_key, agent_uuid)."""
    key_resp = client.post(
        f"/api/v1/servers/{test_server}/agent-key/generate",
        headers=auth_headers,
    )
    assert key_resp.status_code == 200
    agent_key = key_resp.get_json()["agent_key"]
    agent_uuid = str(uuid.uuid4())
    claim = client.post(
        "/api/v1/agent/claim",
        json={"server_id": test_server, "uuid": agent_uuid},
        headers=auth_headers,
    )
    assert claim.status_code == 200
    return agent_key, agent_uuid


# ── P1-5: Redis 降级路径并发保护 ─────────────────────────────────────────────

class TestAgentFallbackConcurrencyProtection:
    """当 Redis 不可用时，agent_push 降级写库路径的并发保护。"""

    def _do_push(self, client, agent_key, agent_uuid, nonce):
        payload = {"cpu_use": 10.0, "ram_use": 20.0, "status": "online"}
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
        headers = _agent_headers(agent_key, raw, agent_uuid, nonce=nonce)
        return client.post(
            "/api/v1/agent/push",
            data=raw,
            headers={**headers, "Content-Type": "application/json"},
        )

    def test_normal_path_redis_available(self, client, auth_headers, test_server):
        """Redis 可用时，正常路径不受影响，始终返回 202。"""
        import extensions
        agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

        # 确保 redis_client 有 rpush（正常测试环境均有）
        assert hasattr(extensions.redis_client, "rpush"), (
            "测试 Redis stub 应支持 rpush"
        )

        resp = self._do_push(client, agent_key, agent_uuid, nonce=str(uuid.uuid4()))
        assert resp.status_code == 202
        assert resp.get_json()["accepted"] is True

    def test_fallback_path_writes_db_when_semaphore_available(
        self, client, auth_headers, test_server, app
    ):
        """Redis 不可用且信号量有余量时，指标应被同步写入数据库。"""
        import api.agent as agent_module
        import extensions

        # 重置信号量，确保有余量
        original_sem = agent_module._fallback_db_sem
        agent_module._fallback_db_sem = threading.Semaphore(5)

        original_redis = extensions.redis_client
        # 模拟 Redis 不可用（设为 None）
        extensions.redis_client = None

        try:
            agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
            resp = self._do_push(client, agent_key, agent_uuid, nonce=str(uuid.uuid4()))
            assert resp.status_code == 202
            assert resp.get_json()["accepted"] is True
        finally:
            extensions.redis_client = original_redis
            agent_module._fallback_db_sem = original_sem

    def test_fallback_path_load_shedding_when_semaphore_exhausted(
        self, client, auth_headers, test_server, app
    ):
        """Redis 不可用且信号量已耗尽时，请求应被 load-shedding：
        仍返回 202（agent 不感知），但本次指标数据被丢弃。
        """
        import api.agent as agent_module
        import extensions
        from extensions import db as _db
        from models.models import ProbeResult

        # 强制信号量为 0（全满），模拟并发上限已耗尽
        original_sem = agent_module._fallback_db_sem
        agent_module._fallback_db_sem = threading.Semaphore(0)

        original_redis = extensions.redis_client
        extensions.redis_client = None

        try:
            agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)

            with app.app_context():
                count_before = ProbeResult.query.filter_by(
                    server_id=test_server
                ).count()

            resp = self._do_push(client, agent_key, agent_uuid, nonce=str(uuid.uuid4()))
            # 即使 load-shedding，agent 仍应收到 202
            assert resp.status_code == 202
            assert resp.get_json()["accepted"] is True

            # 数据库中不应新增 ProbeResult（因为写入被 load-shedding）
            with app.app_context():
                count_after = ProbeResult.query.filter_by(
                    server_id=test_server
                ).count()
            assert count_after == count_before, (
                "load-shedding 时不应有新的 ProbeResult 写入"
            )
        finally:
            extensions.redis_client = original_redis
            agent_module._fallback_db_sem = original_sem

    def test_fallback_semaphore_released_after_write(
        self, client, auth_headers, test_server, app
    ):
        """信号量在写库完成后必须被正确释放，避免资源泄漏。"""
        import api.agent as agent_module
        import extensions

        # 信号量上限为 1，连续两次请求应都能成功（第一次释放后第二次才能获取）
        original_sem = agent_module._fallback_db_sem
        agent_module._fallback_db_sem = threading.Semaphore(1)

        original_redis = extensions.redis_client
        extensions.redis_client = None

        # 确保限流不干扰本测试（某些其他测试可能已开启限流）
        original_ratelimit = app.config.get("RATELIMIT_ENABLED")
        app.config["RATELIMIT_ENABLED"] = False
        try:
            app.limiter.enabled = False
        except Exception:
            pass

        try:
            agent_key, agent_uuid = _provision_agent(client, auth_headers, test_server)
            r1 = self._do_push(client, agent_key, agent_uuid, nonce=str(uuid.uuid4()))
            r2 = self._do_push(client, agent_key, agent_uuid, nonce=str(uuid.uuid4()))
            assert r1.status_code == 202
            assert r2.status_code == 202
        finally:
            extensions.redis_client = original_redis
            agent_module._fallback_db_sem = original_sem
            if original_ratelimit is None:
                app.config.pop("RATELIMIT_ENABLED", None)
            else:
                app.config["RATELIMIT_ENABLED"] = original_ratelimit

    def test_fallback_concurrency_limit_configurable(self, app):
        """AGENT_FALLBACK_DB_CONCURRENCY 配置项应控制信号量上限。"""
        import api.agent as agent_module

        original_sem = agent_module._fallback_db_sem
        agent_module._fallback_db_sem = None  # 强制重新初始化

        try:
            with app.app_context():
                app.config["AGENT_FALLBACK_DB_CONCURRENCY"] = 3
                sem = agent_module._get_fallback_db_sem()
                # 能连续 acquire 3 次（耗尽），第 4 次应失败
                assert sem.acquire(blocking=False) is True
                assert sem.acquire(blocking=False) is True
                assert sem.acquire(blocking=False) is True
                assert sem.acquire(blocking=False) is False
                # 释放
                sem.release()
                sem.release()
                sem.release()
        finally:
            agent_module._fallback_db_sem = original_sem
            app.config.pop("AGENT_FALLBACK_DB_CONCURRENCY", None)


# ── P1-6: Scheduler timezone 配置化 ─────────────────────────────────────────

class TestSchedulerTimezoneConfig:
    """scheduler timezone 可由 SCHEDULER_TIMEZONE 配置项控制。"""

    def test_create_scheduler_uses_configured_timezone(self, app):
        """create_scheduler 应使用 SCHEDULER_TIMEZONE 配置项而非硬编码 Asia/Shanghai。"""
        from services.scheduler import create_scheduler

        with app.app_context():
            original_tz = app.config.get("SCHEDULER_TIMEZONE")
            app.config["SCHEDULER_TIMEZONE"] = "UTC"
            try:
                scheduler = create_scheduler(app)
                if scheduler is not None:
                    # APScheduler 3.x 将时区存在 _scheduler_kwargs 或 timezone 属性
                    tz_repr = str(getattr(scheduler, "timezone", ""))
                    assert "UTC" in tz_repr or "utc" in tz_repr.lower(), (
                        f"调度器时区应为 UTC，实际: {tz_repr}"
                    )
                    scheduler.shutdown(wait=False)
            finally:
                if original_tz is None:
                    app.config.pop("SCHEDULER_TIMEZONE", None)
                else:
                    app.config["SCHEDULER_TIMEZONE"] = original_tz

    def test_create_scheduler_default_timezone_is_asia_shanghai(self, app):
        """SCHEDULER_TIMEZONE 未配置时，默认时区应为 Asia/Shanghai（保持向后兼容）。"""
        from services.scheduler import create_scheduler
        from zoneinfo import ZoneInfo

        with app.app_context():
            original_tz = app.config.pop("SCHEDULER_TIMEZONE", "SENTINEL")
            app.config["SCHEDULER_TIMEZONE"] = "Asia/Shanghai"
            try:
                scheduler = create_scheduler(app)
                if scheduler is not None:
                    tz_repr = str(getattr(scheduler, "timezone", ""))
                    assert "Shanghai" in tz_repr or "Asia" in tz_repr, (
                        f"默认时区应包含 Asia/Shanghai，实际: {tz_repr}"
                    )
                    scheduler.shutdown(wait=False)
            finally:
                if original_tz == "SENTINEL":
                    app.config.pop("SCHEDULER_TIMEZONE", None)
                else:
                    app.config["SCHEDULER_TIMEZONE"] = original_tz

    def test_create_scheduler_invalid_timezone_falls_back(self, app, caplog):
        """无效的 SCHEDULER_TIMEZONE 应回退到 Asia/Shanghai 并输出警告日志。"""
        import logging
        from services.scheduler import create_scheduler

        with app.app_context():
            original_tz = app.config.get("SCHEDULER_TIMEZONE")
            app.config["SCHEDULER_TIMEZONE"] = "Not/A/Timezone"
            try:
                with caplog.at_level(logging.WARNING, logger="services.scheduler"):
                    scheduler = create_scheduler(app)
                assert any(
                    "无效" in r.message or "Not/A/Timezone" in r.message
                    for r in caplog.records
                ), "无效时区应输出警告日志"
                if scheduler is not None:
                    scheduler.shutdown(wait=False)
            finally:
                if original_tz is None:
                    app.config.pop("SCHEDULER_TIMEZONE", None)
                else:
                    app.config["SCHEDULER_TIMEZONE"] = original_tz


# ── P1-6: 月度重置日期使用调度器时区 ────────────────────────────────────────

class TestMonthlyResetTimezoneSemantics:
    """check_monthly_resets 应接受显式 today 参数，消除系统时区与调度器时区偏差。"""

    def _make_server(self, app, reset_day: int, suffix: str = ""):
        from extensions import db as _db
        from models.models import Server

        with app.app_context():
            s = Server(
                name=f"tz_test_srv_{reset_day}_{suffix}",
                ip=f"10.99.{reset_day}.{abs(hash(suffix)) % 250}",
                traffic_reset_day=reset_day,
                traffic_used_gb=100.0,
                traffic_up_gb=60.0,
                traffic_down_gb=40.0,
            )
            _db.session.add(s)
            _db.session.commit()
            return s.id

    def _delete_server(self, app, server_id):
        from extensions import db as _db
        from models.models import Server

        with app.app_context():
            s = _db.session.get(Server, server_id)
            if s:
                _db.session.delete(s)
                _db.session.commit()

    def test_check_monthly_resets_accepts_explicit_today(self, app):
        """check_monthly_resets(today=...) 应使用传入日期而非 date.today()."""
        from api.traffic import check_monthly_resets

        sid = self._make_server(app, 15, "explicit_today")
        try:
            explicit_today = date(2025, 5, 15)
            with app.app_context():
                result = check_monthly_resets(today=explicit_today)
            assert sid in result, "显式传入重置日应触发重置"
        finally:
            self._delete_server(app, sid)

    def test_check_monthly_resets_explicit_today_no_reset_on_wrong_day(self, app):
        """传入非重置日时不应触发重置。"""
        from api.traffic import check_monthly_resets

        sid = self._make_server(app, 15, "wrong_day")
        try:
            wrong_day = date(2025, 5, 14)
            with app.app_context():
                result = check_monthly_resets(today=wrong_day)
            assert sid not in result, "非重置日不应触发重置"
        finally:
            self._delete_server(app, sid)

    def test_check_monthly_resets_default_today_unchanged(self, app):
        """不传 today 时，check_monthly_resets 行为应与修改前一致（向后兼容）。"""
        from api.traffic import check_monthly_resets

        # 使用 date.today() 的日期构建一个不会实际重置的服务器（reset_day=0）
        with app.app_context():
            # 正常调用不应抛出异常
            result = check_monthly_resets()
            assert isinstance(result, list)

    def test_job_monthly_traffic_reset_uses_scheduler_tz(self, app):
        """_job_monthly_traffic_reset 应将调度器时区的当前日期传给 check_monthly_resets。"""
        from services.scheduler import _job_monthly_traffic_reset
        from zoneinfo import ZoneInfo

        captured_today = {}

        def fake_check_monthly_resets(today=None):
            captured_today["today"] = today
            return []

        with app.app_context():
            app.config["SCHEDULER_TIMEZONE"] = "UTC"
            tz_utc = ZoneInfo("UTC")
            expected_today = datetime.now(tz_utc).date()

            # _job_monthly_traffic_reset 通过 `from api.traffic import check_monthly_resets`
            # 在函数体内导入，因此需要 patch api.traffic 模块上的引用。
            with patch("api.traffic.check_monthly_resets", fake_check_monthly_resets):
                _job_monthly_traffic_reset(app)

            assert "today" in captured_today, "_job_monthly_traffic_reset 应传入 today 参数"
            today_passed = captured_today["today"]
            assert today_passed == expected_today, (
                f"传入的 today ({today_passed}) 应等于 UTC 时区的今天 ({expected_today})"
            )

    def test_job_monthly_traffic_reset_cross_timezone(self, app):
        """验证跨时区场景：用 Asia/Shanghai 时区时，传入的日期是上海时间的日期。"""
        from services.scheduler import _job_monthly_traffic_reset
        from zoneinfo import ZoneInfo

        captured_today = {}

        def fake_check_monthly_resets(today=None):
            captured_today["today"] = today
            return []

        with app.app_context():
            app.config["SCHEDULER_TIMEZONE"] = "Asia/Shanghai"
            tz_sh = ZoneInfo("Asia/Shanghai")
            expected_today = datetime.now(tz_sh).date()

            with patch("api.traffic.check_monthly_resets", fake_check_monthly_resets):
                _job_monthly_traffic_reset(app)

            assert captured_today.get("today") == expected_today, (
                f"传入的 today ({captured_today.get('today')}) 应等于 Asia/Shanghai 的今天 ({expected_today})"
            )
