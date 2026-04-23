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


def _handle_message(raw_payload: str):
    payload = json.loads(raw_payload)
    server_id = payload.get("server_id")
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
            try:
                item = redis_client.brpop(_QUEUE_KEY, timeout=POLL_TIMEOUT)
                if not item:
                    continue
                _, raw_payload = item
                _handle_message(raw_payload)
            except Exception as exc:  # noqa: BLE001
                logger.exception("agent_consumer failed to process message: %s", exc)
                db.session.rollback()
                try:
                    if 'raw_payload' in locals() and raw_payload:
                        redis_client.rpush(ERROR_QUEUE_KEY, raw_payload)
                except Exception:  # noqa: BLE001
                    logger.exception("agent_consumer failed to push payload into error queue")
                time.sleep(RETRY_SLEEP_SECONDS)


if __name__ == "__main__":
    run()
