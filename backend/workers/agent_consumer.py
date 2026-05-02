"""Redis metrics queue consumer for agent push pipeline."""

from __future__ import annotations

import json
import logging
import os
import time

from app import create_app
from api.agent import _QUEUE_KEY, _record_metrics
from extensions import db
from models.models import Server

logger = logging.getLogger(__name__)

ERROR_QUEUE_KEY = os.getenv("AGENT_METRICS_ERROR_QUEUE", "vps:agent:metrics_queue:error")
POLL_TIMEOUT = int(os.getenv("AGENT_METRICS_QUEUE_TIMEOUT", "5"))
RETRY_SLEEP_SECONDS = float(os.getenv("AGENT_METRICS_RETRY_SLEEP", "1"))

# ── Prometheus 指标（懒加载，避免无 prometheus_client 时报错）───────────────────


def _make_metrics():
    """初始化并返回 agent_consumer 专用 Prometheus 指标。

    Returns a namespace object with attributes:
        messages_total, processing_seconds, inflight,
        queue_lag, last_success_timestamp
    或全部为 _NoOp 占位（当 prometheus_client 未安装时）。
    """
    try:
        from prometheus_client import Counter, Histogram, Gauge

        _buckets = (0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)

        class _Metrics:
            messages_total = Counter(
                "agent_consumer_messages_total",
                "Total messages processed by agent_consumer",
                ["result"],  # success | failed | dropped
            )
            processing_seconds = Histogram(
                "agent_consumer_processing_seconds",
                "Per-message processing latency in seconds",
                buckets=_buckets,
            )
            inflight = Gauge(
                "agent_consumer_inflight",
                "Number of messages currently being processed",
            )
            queue_lag = Gauge(
                "agent_consumer_queue_lag",
                "Estimated queue backlog (pending messages in the Redis list)",
            )
            last_success_timestamp = Gauge(
                "agent_consumer_last_success_timestamp",
                "Unix timestamp of the last successfully processed message",
            )

        return _Metrics()
    except Exception:  # pragma: no cover
        class _NoOp:
            def labels(self, **_): return self
            def inc(self, *a, **k): pass
            def observe(self, *a, **k): pass
            def set(self, *a, **k): pass

        class _NoOpMetrics:
            messages_total = _NoOp()
            processing_seconds = _NoOp()
            inflight = _NoOp()
            queue_lag = _NoOp()
            last_success_timestamp = _NoOp()

        return _NoOpMetrics()


_metrics = _make_metrics()


def _update_queue_lag(redis_client, queue_key: str) -> None:
    """更新队列积压 Gauge（llen 是 O(1) 操作）。"""
    try:
        lag = redis_client.llen(queue_key)
        _metrics.queue_lag.set(lag if lag is not None else 0)
    except Exception as exc:
        logger.debug("agent_consumer: failed to update queue_lag: %s", exc)


def _handle_message(raw_payload: str):
    payload = json.loads(raw_payload)
    server_id = payload.get("server_id")
    agent_id = payload.get("uuid", "")
    metrics = payload.get("metrics") or {}

    if not server_id:
        raise ValueError("missing server_id")

    server = db.session.get(Server, int(server_id))
    if not server:
        raise ValueError(f"server not found: {server_id}")

    _record_metrics(server, metrics)
    db.session.commit()


def run():
    app = create_app()
    redis_client = app.extensions.get("redis_client")

    if redis_client is None:
        # 兼容当前项目将 redis 客户端保存在 extensions 模块全局变量
        import extensions

        redis_client = extensions.redis_client

    if redis_client is None:
        raise RuntimeError("Redis client unavailable for agent consumer")

    logger.info("agent_consumer started. queue=%s", _QUEUE_KEY)
    with app.app_context():
        while True:
            raw_payload = None
            try:
                # 每次循环更新队列积压量（llen 是 O(1)，不影响吞吐）
                _update_queue_lag(redis_client, _QUEUE_KEY)

                item = redis_client.brpop(_QUEUE_KEY, timeout=POLL_TIMEOUT)
                if not item:
                    continue
                _, raw_payload = item

                _metrics.inflight.inc()
                t0 = time.monotonic()
                try:
                    _handle_message(raw_payload)
                    elapsed = time.monotonic() - t0
                    _metrics.processing_seconds.observe(elapsed)
                    _metrics.messages_total.labels(result="success").inc()
                    _metrics.last_success_timestamp.set(time.time())
                    logger.debug(
                        "agent_consumer: message processed",
                        extra={"elapsed_s": round(elapsed, 4)},
                    )
                except Exception as exc:
                    elapsed = time.monotonic() - t0
                    _metrics.processing_seconds.observe(elapsed)
                    _metrics.messages_total.labels(result="failed").inc()
                    raise
                finally:
                    _metrics.inflight.dec()

            except Exception as exc:  # noqa: BLE001
                # 提取结构化字段（尽力而为，payload 可能非法 JSON）
                _server_id = None
                _agent_id = None
                if raw_payload:
                    try:
                        _p = json.loads(raw_payload)
                        _server_id = _p.get("server_id")
                        _agent_id = _p.get("uuid")
                    except Exception:
                        pass
                logger.exception(
                    "agent_consumer failed to process message: %s",
                    exc,
                    extra={
                        "server_id": _server_id,
                        "agent_id": _agent_id,
                        # Redis queue 不分 topic/partition/offset，保留字段供扩展
                        "queue": _QUEUE_KEY,
                        "topic": _QUEUE_KEY,
                        "partition": None,
                        "offset": None,
                    },
                )
                db.session.rollback()
                try:
                    if raw_payload:
                        redis_client.rpush(ERROR_QUEUE_KEY, raw_payload)
                except Exception:  # noqa: BLE001
                    logger.exception("agent_consumer failed to push payload into error queue")
                time.sleep(RETRY_SLEEP_SECONDS)


if __name__ == "__main__":
    run()
