"""
单元测试：workers/agent_consumer.py

这是从整体后端审计 P2 中拆分出的「agent_consumer 单元测试」独立 PR。

覆盖场景：
  1. 合法消息被消费并成功处理（_handle_message 成功路径）
  2. 缺少 server_id 时抛 ValueError
  3. 非法 JSON 时抛 json.JSONDecodeError
  4. server 不存在时抛 ValueError
  5. _record_metrics 抛异常时，异常从 _handle_message 传出（run() 中 rollback）
  6. brpop 返回 None 时，消费循环不崩溃，且不写入 error queue
  7. redis_client 完全不可用时，run() 抛 RuntimeError
  8. 消息处理失败时，原始 payload 被推入 error queue
  9. 合法消息经 brpop 取出后被正确分发给 _handle_message
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# _handle_message 隔离测试
# ─────────────────────────────────────────────────────────────────────────────


class TestHandleMessage:
    """_handle_message 各路径隔离测试（依赖 Flask app context + 测试 DB）。"""

    def test_success_updates_server_fields(self, app, test_server):
        """合法 payload：服务器指标被更新并提交到数据库。"""
        import workers.agent_consumer as consumer_module
        from extensions import db
        from models.models import Server

        raw = json.dumps({
            "server_id": test_server,
            "metrics": {"cpu_use": 42.0, "ram_use": 55.0, "status": "online"},
        })

        consumer_module._handle_message(raw)

        server = db.session.get(Server, test_server)
        assert server.cpu_use == 42.0
        assert server.ram_use == 55.0
        assert server.status == "online"

    def test_missing_server_id_raises_value_error(self, app):
        """payload 缺少 server_id 时应抛出 ValueError。"""
        import workers.agent_consumer as consumer_module

        raw = json.dumps({"metrics": {"cpu_use": 10.0}})
        with pytest.raises(ValueError, match="missing server_id"):
            consumer_module._handle_message(raw)

    def test_invalid_json_raises(self, app):
        """非法 JSON 字符串应抛出 json.JSONDecodeError。"""
        import workers.agent_consumer as consumer_module

        with pytest.raises(json.JSONDecodeError):
            consumer_module._handle_message("not-valid-json{{invalid}}")

    def test_server_not_found_raises_value_error(self, app):
        """DB 中不存在的 server_id 应抛出 ValueError。"""
        import workers.agent_consumer as consumer_module

        raw = json.dumps({"server_id": 999999, "metrics": {}})
        with pytest.raises(ValueError, match="server not found"):
            consumer_module._handle_message(raw)

    def test_record_metrics_exception_propagates(self, app, test_server, monkeypatch):
        """_record_metrics 抛异常时，异常应从 _handle_message 传出。
        （run() 的 except 块负责 rollback；此处只验证异常能传出。）
        """
        import workers.agent_consumer as consumer_module

        def _boom(server, metrics):
            raise RuntimeError("db write failure")

        # _record_metrics 在 agent_consumer 模块中以局部名绑定，需在此打补丁
        monkeypatch.setattr(consumer_module, "_record_metrics", _boom)

        raw = json.dumps({"server_id": test_server, "metrics": {}})
        with pytest.raises(RuntimeError, match="db write failure"):
            consumer_module._handle_message(raw)


# ─────────────────────────────────────────────────────────────────────────────
# 消费主循环行为测试
# ─────────────────────────────────────────────────────────────────────────────


class TestConsumerLoop:
    """run() 消费主循环的关键行为测试。
    采用 monkeypatch 替换 create_app / extensions.redis_client，
    使用受控的 Mock Redis，不依赖真实外部 Redis。
    """

    def test_brpop_none_continues_loop_silently(self, app, monkeypatch):
        """brpop 返回 None 时，循环静默继续，不向 error queue 写入任何内容。"""
        import workers.agent_consumer as consumer_module
        import extensions

        call_count = [0]

        def fake_brpop(key, timeout=5):
            call_count[0] += 1
            if call_count[0] >= 3:
                raise SystemExit(0)
            return None

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop

        monkeypatch.setattr(consumer_module, "create_app", lambda: app)
        monkeypatch.setattr(extensions, "redis_client", mock_redis)

        with pytest.raises(SystemExit):
            consumer_module.run()

        assert call_count[0] >= 3, "brpop 应至少被调用 3 次"
        mock_redis.rpush.assert_not_called()

    def test_redis_unavailable_raises_runtime_error(self, app, monkeypatch):
        """extensions.redis_client 为 None 时，run() 应立即抛出 RuntimeError。"""
        import workers.agent_consumer as consumer_module
        import extensions

        monkeypatch.setattr(consumer_module, "create_app", lambda: app)
        monkeypatch.setattr(extensions, "redis_client", None)

        with pytest.raises(RuntimeError, match="Redis client unavailable"):
            consumer_module.run()

    def test_failed_message_pushed_to_error_queue(self, app, monkeypatch):
        """消息处理失败时，原始 payload 应被推入 error queue。
        同时验证循环在捕获异常后不再抛出（进入 sleep 路径）。
        """
        import workers.agent_consumer as consumer_module
        import extensions

        bad_payload = "NOT-VALID-JSON"
        rpush_calls = []

        def fake_brpop(key, timeout=5):
            # 始终返回同一条坏消息；sleep 触发后 SystemExit 终止循环
            return (key, bad_payload)

        def fake_rpush(key, value):
            rpush_calls.append((key, value))

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop
        mock_redis.rpush.side_effect = fake_rpush

        # 用 SystemExit 替代真实 sleep 以终止无限循环
        mock_time = MagicMock()
        mock_time.sleep.side_effect = SystemExit(0)

        monkeypatch.setattr(consumer_module, "create_app", lambda: app)
        monkeypatch.setattr(extensions, "redis_client", mock_redis)
        monkeypatch.setattr(consumer_module, "time", mock_time)

        with pytest.raises(SystemExit):
            consumer_module.run()

        assert any(
            k == consumer_module.ERROR_QUEUE_KEY for k, _ in rpush_calls
        ), "失败 payload 应被推入 error queue"
        assert any(
            v == bad_payload for _, v in rpush_calls
        ), "error queue 中应包含原始 payload"

    def test_valid_message_dispatched_to_handle_message(self, app, test_server, monkeypatch):
        """brpop 取到合法消息后应将其传入 _handle_message。"""
        import workers.agent_consumer as consumer_module
        import extensions

        payload = json.dumps({
            "server_id": test_server,
            "metrics": {"cpu_use": 15.0},
        })
        handled = []

        def fake_handle_message(raw):
            handled.append(raw)

        def fake_brpop(key, timeout=5):
            if not handled:
                return (key, payload)
            raise SystemExit(0)

        mock_redis = MagicMock()
        mock_redis.brpop.side_effect = fake_brpop

        monkeypatch.setattr(consumer_module, "create_app", lambda: app)
        monkeypatch.setattr(extensions, "redis_client", mock_redis)
        monkeypatch.setattr(consumer_module, "_handle_message", fake_handle_message)

        with pytest.raises(SystemExit):
            consumer_module.run()

        assert len(handled) == 1, "_handle_message 应被调用一次"
        assert handled[0] == payload, "_handle_message 应收到原始 payload"
