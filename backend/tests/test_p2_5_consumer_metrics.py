"""
tests/test_p2_5_consumer_metrics.py
P2-5 可观测性测试：验证 agent_consumer 指标正确更新。

覆盖场景：
  1. 成功处理消息：success counter + processing_seconds + last_success_timestamp 更新
  2. 失败处理消息：failed counter 更新，inflight 正确回落（不泄漏）
  3. 队列 lag 可通过 llen 更新（测试 _update_queue_lag 函数）
  4. 指标端点可抓取（/metrics 响应文本包含新增指标名）
  5. inflight 在成功路径正确回落
"""
from __future__ import annotations

import json
import time
from unittest.mock import MagicMock, patch, call

import pytest


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _make_payload(server_id, **metrics):
    return json.dumps({"server_id": server_id, "metrics": metrics, "uuid": "test-uuid"})


def _run_one_message(app, extensions, consumer_module, monkeypatch, payload, mock_metrics=None):
    """辅助函数：运行一次消息处理循环（成功或失败均可）。
    
    返回 (handled, error_queue_calls) 元组。
    """
    handled = []
    error_queue_calls = []

    mock_redis = MagicMock()
    mock_redis.llen.return_value = 5

    call_count = [0]
    def fake_brpop(key, timeout=5):
        call_count[0] += 1
        if call_count[0] == 1:
            return (key, payload)
        raise SystemExit(0)

    mock_redis.brpop.side_effect = fake_brpop
    mock_redis.rpush.side_effect = lambda k, v: error_queue_calls.append((k, v))

    if mock_metrics is not None:
        monkeypatch.setattr(consumer_module, "_metrics", mock_metrics)

    monkeypatch.setattr(consumer_module, "create_app", lambda: app)
    monkeypatch.setattr(extensions, "redis_client", mock_redis)

    with pytest.raises(SystemExit):
        consumer_module.run()

    return error_queue_calls


# ─────────────────────────────────────────────────────────────────────────────
# 成功路径：指标验证
# ─────────────────────────────────────────────────────────────────────────────

class TestConsumerMetricsSuccess:
    """成功处理路径的指标更新验证（通过 run() 循环）。"""

    def test_success_increments_success_counter(self, app, test_server, monkeypatch):
        """成功处理后 messages_total{result=success} 应自增。"""
        import workers.agent_consumer as consumer_module
        import extensions

        success_label_calls = []

        class _FakeCounter:
            def labels(self, **kw):
                success_label_calls.append(kw)
                return self
            def inc(self): pass

        mock_metrics = MagicMock()
        mock_metrics.messages_total = _FakeCounter()
        mock_metrics.inflight = MagicMock()
        mock_metrics.processing_seconds = MagicMock()
        mock_metrics.last_success_timestamp = MagicMock()
        mock_metrics.queue_lag = MagicMock()

        payload = _make_payload(test_server, cpu_use=50.0)
        _run_one_message(app, extensions, consumer_module, monkeypatch, payload, mock_metrics)

        assert any(kw.get("result") == "success" for kw in success_label_calls), (
            "成功路径应调用 messages_total.labels(result='success')"
        )

    def test_success_observes_processing_seconds(self, app, test_server, monkeypatch):
        """成功处理后 processing_seconds 应被观测一次。"""
        import workers.agent_consumer as consumer_module
        import extensions

        observed = []

        class _FakeHisto:
            def observe(self, v): observed.append(v)

        mock_metrics = MagicMock()
        mock_metrics.messages_total = MagicMock()
        mock_metrics.messages_total.labels.return_value = MagicMock()
        mock_metrics.processing_seconds = _FakeHisto()
        mock_metrics.inflight = MagicMock()
        mock_metrics.last_success_timestamp = MagicMock()
        mock_metrics.queue_lag = MagicMock()

        payload = _make_payload(test_server, cpu_use=30.0)
        _run_one_message(app, extensions, consumer_module, monkeypatch, payload, mock_metrics)

        assert len(observed) >= 1, "processing_seconds 应被 observe 至少一次"
        assert observed[0] >= 0.0, "latency 应为非负值"

    def test_success_updates_last_success_timestamp(self, app, test_server, monkeypatch):
        """成功处理后 last_success_timestamp 应被 set 为当前 unix 时间戳。"""
        import workers.agent_consumer as consumer_module
        import extensions

        ts_set = []

        class _FakeGauge:
            def set(self, v): ts_set.append(v)
            def inc(self): pass
            def dec(self): pass

        mock_metrics = MagicMock()
        mock_metrics.messages_total = MagicMock()
        mock_metrics.messages_total.labels.return_value = MagicMock()
        mock_metrics.processing_seconds = MagicMock()
        mock_metrics.inflight = MagicMock()
        mock_metrics.last_success_timestamp = _FakeGauge()
        mock_metrics.queue_lag = MagicMock()

        before = time.time()
        payload = _make_payload(test_server)
        _run_one_message(app, extensions, consumer_module, monkeypatch, payload, mock_metrics)
        after = time.time()

        assert len(ts_set) >= 1, "last_success_timestamp 应被 set"
        assert before <= ts_set[0] <= after + 1

    def test_inflight_increments_and_decrements_on_success(self, app, test_server, monkeypatch):
        """成功路径：inflight 先 inc 再 dec，最终回落。"""
        import workers.agent_consumer as consumer_module
        import extensions

        inflight_calls = []

        class _FakeInflight:
            def inc(self): inflight_calls.append("inc")
            def dec(self): inflight_calls.append("dec")
            def set(self, v): pass

        mock_metrics = MagicMock()
        mock_metrics.messages_total = MagicMock()
        mock_metrics.messages_total.labels.return_value = MagicMock()
        mock_metrics.processing_seconds = MagicMock()
        mock_metrics.inflight = _FakeInflight()
        mock_metrics.last_success_timestamp = MagicMock()
        mock_metrics.queue_lag = MagicMock()

        payload = _make_payload(test_server, cpu_use=10.0)
        _run_one_message(app, extensions, consumer_module, monkeypatch, payload, mock_metrics)

        assert "inc" in inflight_calls, "inflight 应调用 inc"
        assert "dec" in inflight_calls, "inflight 应调用 dec（不泄漏）"
        # inc 在 dec 之前
        inc_idx = inflight_calls.index("inc")
        dec_idx = inflight_calls.index("dec")
        assert inc_idx < dec_idx, "inflight.inc() 应在 inflight.dec() 之前"


# ─────────────────────────────────────────────────────────────────────────────
# 失败路径：指标验证
# ─────────────────────────────────────────────────────────────────────────────

class TestConsumerMetricsFailed:
    """失败处理路径的指标更新验证。"""

    def test_failed_message_increments_failed_counter(self, app, monkeypatch):
        """处理失败后 messages_total{result=failed} 应自增。"""
        import workers.agent_consumer as consumer_module
        import extensions

        failed_labels = []

        class _FakeCounter:
            def labels(self, **kw):
                failed_labels.append(kw)
                return self
            def inc(self): pass

        mock_metrics = MagicMock()
        mock_metrics.messages_total = _FakeCounter()
        mock_metrics.inflight = MagicMock()
        mock_metrics.processing_seconds = MagicMock()
        mock_metrics.last_success_timestamp = MagicMock()
        mock_metrics.queue_lag = MagicMock()

        bad_payload = json.dumps({"server_id": 999999, "metrics": {}})
        _run_one_message(app, extensions, consumer_module, monkeypatch, bad_payload, mock_metrics)

        assert any(kw.get("result") == "failed" for kw in failed_labels), (
            "失败路径应调用 messages_total.labels(result='failed')"
        )

    def test_inflight_decrements_on_failure(self, app, monkeypatch):
        """失败路径：inflight 在 finally 块中必须 dec（不泄漏）。"""
        import workers.agent_consumer as consumer_module
        import extensions

        inflight_calls = []

        class _FakeInflight:
            def inc(self): inflight_calls.append("inc")
            def dec(self): inflight_calls.append("dec")
            def set(self, v): pass

        mock_metrics = MagicMock()
        mock_metrics.messages_total = MagicMock()
        mock_metrics.messages_total.labels.return_value = MagicMock()
        mock_metrics.processing_seconds = MagicMock()
        mock_metrics.inflight = _FakeInflight()
        mock_metrics.last_success_timestamp = MagicMock()
        mock_metrics.queue_lag = MagicMock()

        bad_payload = json.dumps({"server_id": 999999, "metrics": {}})
        _run_one_message(app, extensions, consumer_module, monkeypatch, bad_payload, mock_metrics)

        assert "dec" in inflight_calls, "失败路径也应调用 inflight.dec()（不泄漏）"


# ─────────────────────────────────────────────────────────────────────────────
# 队列 lag 指标
# ─────────────────────────────────────────────────────────────────────────────

class TestQueueLag:
    """队列积压 Gauge 更新测试。"""

    def test_update_queue_lag_calls_llen(self, app, monkeypatch):
        """_update_queue_lag 应调用 redis llen 并 set gauge。"""
        import workers.agent_consumer as consumer_module

        lag_set = []

        class _FakeGauge:
            def set(self, v): lag_set.append(v)

        mock_metrics = MagicMock()
        mock_metrics.queue_lag = _FakeGauge()
        monkeypatch.setattr(consumer_module, "_metrics", mock_metrics)

        mock_redis = MagicMock()
        mock_redis.llen.return_value = 42

        consumer_module._update_queue_lag(mock_redis, "test:queue")

        mock_redis.llen.assert_called_once_with("test:queue")
        assert lag_set == [42]

    def test_update_queue_lag_tolerates_redis_error(self, app, monkeypatch):
        """_update_queue_lag Redis 异常时不应抛出（只 debug 日志）。"""
        import workers.agent_consumer as consumer_module

        mock_metrics = MagicMock()
        monkeypatch.setattr(consumer_module, "_metrics", mock_metrics)

        mock_redis = MagicMock()
        mock_redis.llen.side_effect = RuntimeError("redis down")

        # 不应抛出
        consumer_module._update_queue_lag(mock_redis, "test:queue")

    def test_run_loop_calls_update_queue_lag(self, app, monkeypatch):
        """run() 主循环每次迭代都应调用 _update_queue_lag。"""
        import workers.agent_consumer as consumer_module
        import extensions

        lag_updates = []

        def fake_update_queue_lag(redis_client, key):
            lag_updates.append(key)
            if len(lag_updates) >= 2:
                raise SystemExit(0)

        mock_redis = MagicMock()
        mock_redis.brpop.return_value = None

        monkeypatch.setattr(consumer_module, "create_app", lambda: app)
        monkeypatch.setattr(extensions, "redis_client", mock_redis)
        monkeypatch.setattr(consumer_module, "_update_queue_lag", fake_update_queue_lag)

        with pytest.raises(SystemExit):
            consumer_module.run()

        assert len(lag_updates) >= 1, "_update_queue_lag 应被主循环调用"


# ─────────────────────────────────────────────────────────────────────────────
# /metrics 端点可抓取
# ─────────────────────────────────────────────────────────────────────────────

class TestMetricsEndpoint:
    """验证 /metrics 端点中包含新增指标名。"""

    def test_metrics_endpoint_contains_consumer_metric_names(self, client, app, monkeypatch):
        """GET /metrics 的响应文本应包含 agent_consumer 指标名称。"""
        # 绕过 IP 白名单限制（测试环境使用 127.0.0.1）
        monkeypatch.setattr(
            "middleware.metrics_middleware._is_metrics_allowed",
            lambda ip: True,
        )

        try:
            import prometheus_client  # noqa: F401
        except ImportError:
            pytest.skip("prometheus_client 未安装，跳过端点测试")

        resp = client.get("/metrics", environ_base={"REMOTE_ADDR": "127.0.0.1"})
        assert resp.status_code == 200
        body = resp.data.decode("utf-8")

        expected_metrics = [
            "agent_consumer_messages_total",
            "agent_consumer_processing_seconds",
            "agent_consumer_inflight",
            "agent_consumer_queue_lag",
            "agent_consumer_last_success_timestamp",
        ]
        for metric_name in expected_metrics:
            assert metric_name in body, (
                f"指标 '{metric_name}' 未出现在 /metrics 响应中"
            )
