"""
/api/agent  — Agent 认领、推送、轮询命令
"""
import hashlib
import hmac
import json
import logging
import secrets
import threading
from datetime import datetime, timedelta, timezone

import extensions
from flask import Blueprint, current_app, jsonify, request
from werkzeug.security import check_password_hash

from extensions import db
from middleware.rate_limit import limiter
from middleware.rbac import admin_required
from middleware.metrics_middleware import record_agent_push, record_agent_poll, record_agent_ack
from models.models import AgentCommand, Server
from utils.errors import AuthenticationError, ValidationError

agent_bp = Blueprint("agent", __name__)
logger = logging.getLogger(__name__)

_CLOCK_SKEW_SECONDS = 60
_OVERLAP_MINUTES = 5
_QUEUE_KEY = "vps:agent:metrics_queue"

# ── Redis 降级路径并发保护 ──────────────────────────────────────────────────
# 当 Redis 不可用时，agent_push 会降级为同步写库。为避免高并发场景下同步写库
# 把数据库连接/事务压力无限放大，使用有界信号量限制同时进行的降级写库数量。
# 超过并发上限的请求仍返回 202（agent 不报错），但本次指标数据被丢弃（load-shedding）。
# 默认上限由 AGENT_FALLBACK_DB_CONCURRENCY 配置项控制（默认 5）。
_fallback_db_sem: threading.Semaphore | None = None
_fallback_db_sem_init_lock = threading.Lock()


def _get_fallback_db_sem() -> threading.Semaphore:
    """获取（或懒初始化）Redis 降级路径的并发信号量。

    信号量上限由 AGENT_FALLBACK_DB_CONCURRENCY 配置项决定，在首次调用时从
    current_app.config 中读取并缓存。若需在测试中重置，可将模块级
    _fallback_db_sem 设为 None。
    """
    global _fallback_db_sem
    if _fallback_db_sem is None:
        with _fallback_db_sem_init_lock:
            if _fallback_db_sem is None:
                limit = int(current_app.config.get("AGENT_FALLBACK_DB_CONCURRENCY", 5))
                _fallback_db_sem = threading.Semaphore(limit)
    return _fallback_db_sem


def _utc_now():
    return datetime.now(timezone.utc)


def _parse_ts(raw: str) -> datetime:
    try:
        ts = int(raw)
    except (TypeError, ValueError):
        raise AuthenticationError("invalid timestamp")
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    if abs((_utc_now() - dt).total_seconds()) > _CLOCK_SKEW_SECONDS:
        raise AuthenticationError("timestamp out of acceptable range")
    return dt


def _validate_nonce(uuid: str, nonce: str):
    if not nonce or len(nonce) > 128:
        raise AuthenticationError("invalid nonce")
    nonce_key = f"vps:agent:nonce:{uuid}:{nonce}"
    if extensions.redis_client:
        try:
            # 使用 Redis 原子写入（SET NX EX），避免 exists()+setex() 竞态
            accepted = extensions.redis_client.set(
                nonce_key,
                "1",
                ex=_CLOCK_SKEW_SECONDS,
                nx=True,
            )
            if not accepted:
                raise AuthenticationError("replayed request")
        except AuthenticationError:
            raise
        except Exception as exc:
            # redis-py 在 Redis 故障时抛出 ConnectionError / RedisError 等，
            # 而不是返回 None；捕获后降级放行并记录警告。
            logger.warning(
                "agent nonce validation skipped: Redis error (uuid=%s): %s. "
                "Replay protection degraded for the duration of Redis outage.",
                uuid, exc,
            )
    else:
        # Redis 不可用时无法执行防重放校验，记录警告后降级放行。
        # 此窗口期内短暂的重放攻击风险由 timestamp 窗口（_CLOCK_SKEW_SECONDS）和
        # HMAC 签名提供的有限保护兜底；运维侧应尽快恢复 Redis。
        logger.warning(
            "agent nonce validation skipped: Redis unavailable (uuid=%s). "
            "Replay protection degraded for the duration of Redis outage.",
            uuid,
        )


def _enforce_transport_security():
    require_tls = current_app.config.get("AGENT_REQUIRE_TLS")
    if require_tls is None:
        require_tls = not current_app.config.get("TESTING", False)
    if require_tls and not request.is_secure:
        raise AuthenticationError("agent endpoints require HTTPS")


def _agent_rate_limit_key() -> str:
    uuid = request.headers.get("X-Agent-UUID", "").strip()
    if uuid:
        return f"agent:{uuid}"
    return f"ip:{request.remote_addr or 'unknown'}"


def _hmac_digest(secret: str, body: bytes, ts: str, nonce: str) -> str:
    msg = f"{ts}.{nonce}.".encode("utf-8") + body
    return hmac.new(secret.encode("utf-8"), msg, hashlib.sha256).hexdigest()


def _record_metrics(server: Server, data: dict):
    """Write metrics from *data* to *server* and append a ProbeResult.

    Delegates to the shared :func:`~services.metrics_ingest.ingest_metrics`
    entry point with lenient (agent-path) validation semantics.
    Does NOT commit the session; the caller is responsible.
    """
    from services.metrics_ingest import ingest_metrics
    ingest_metrics(server, data, strict=False, source="agent")


def _authenticate_agent(payload: dict) -> tuple[Server, str]:
    _enforce_transport_security()
    uuid = payload.get("uuid") or request.headers.get("X-Agent-UUID")
    if not uuid:
        raise AuthenticationError("missing uuid")

    server = Server.query.filter_by(uuid=uuid).first()
    if not server:
        raise AuthenticationError("unknown agent")

    ts = request.headers.get("X-Agent-Timestamp", "")
    nonce = request.headers.get("X-Agent-Nonce", "")
    sig = request.headers.get("X-Agent-Signature", "")
    agent_key = request.headers.get("X-Agent-Key", "")
    if not all([ts, nonce, sig, agent_key]):
        raise AuthenticationError("missing auth headers")

    _parse_ts(ts)
    _validate_nonce(uuid, nonce)

    valid_key = bool(server.agent_key_hash and check_password_hash(server.agent_key_hash, agent_key))
    within_overlap = bool(
        server.agent_key_prev_hash
        and server.agent_key_prev_expires_at
        and server.agent_key_prev_expires_at >= _utc_now()
        and check_password_hash(server.agent_key_prev_hash, agent_key)
    )
    if not (valid_key or within_overlap):
        raise AuthenticationError("invalid key")

    expected = _hmac_digest(
        secret=agent_key,
        body=request.get_data(cache=True) or b"",
        ts=ts,
        nonce=nonce,
    )
    if not hmac.compare_digest(expected, sig):
        raise AuthenticationError("signature mismatch")

    server.agent_key_last_used = _utc_now()
    return server, uuid


@agent_bp.post("/claim")
@admin_required
def claim_agent():
    data = request.get_json(silent=True) or {}
    sid = data.get("server_id")
    uuid = (data.get("uuid") or "").strip()
    if not sid or not uuid:
        raise ValidationError("server_id 与 uuid 必填")

    server = Server.query.get_or_404(int(sid))
    if server.uuid and server.uuid != uuid:
        raise ValidationError("该服务器已绑定其他 UUID")

    if Server.query.filter(Server.uuid == uuid, Server.id != server.id).first():
        raise ValidationError("UUID 已被其他服务器占用")

    server.uuid = uuid
    db.session.commit()
    return jsonify({"ok": True, "server_id": server.id, "uuid": server.uuid})


@agent_bp.post("/push")
@limiter.limit(
    lambda: current_app.config.get("AGENT_PUSH_RATE_LIMIT", "60 per minute"),
    key_func=_agent_rate_limit_key,
)
def agent_push():
    data = request.get_json(silent=True) or {}
    server, uuid = _authenticate_agent(data)

    _use_fallback = True  # assume fallback until Redis enqueue succeeds
    if extensions.redis_client and hasattr(extensions.redis_client, "rpush"):
        payload = json.dumps(
            {"server_id": server.id, "uuid": uuid, "metrics": data, "received_at": _utc_now().isoformat()},
            ensure_ascii=False,
        )
        try:
            extensions.redis_client.rpush(_QUEUE_KEY, payload)
            _use_fallback = False
        except Exception as exc:
            # redis-py raises ConnectionError/RedisError on outage; fall back to
            # the semaphore-protected synchronous DB write path so that the agent
            # does not receive a 500 and the load-shedding logic remains reachable.
            logger.warning(
                "agent push: Redis rpush failed (%s), falling back to synchronous DB write",
                exc,
                extra={"server_id": server.id, "uuid": uuid},
            )

    if _use_fallback:
        # Redis not available or rpush failed: fallback to semaphore-protected
        # synchronous DB write.  If semaphore is exhausted, data is dropped
        # (load-shedding); agent still gets 202.
        sem = _get_fallback_db_sem()
        if not sem.acquire(blocking=False):
            logger.warning(
                "agent push: Redis unavailable and fallback DB concurrency limit reached;"
                " metrics dropped (load-shedding)",
                extra={"server_id": server.id, "uuid": uuid},
            )
            try:
                record_agent_push("dropped")
            except Exception as exc:
                logger.debug("Failed to record agent push dropped metric: %s", exc)
        else:
            try:
                _record_metrics(server, data)
                db.session.commit()
            except Exception:
                db.session.rollback()
                raise
            finally:
                sem.release()

    logger.info(
        "agent push accepted",
        extra={"server_id": server.id, "uuid": uuid},
    )

    try:
        record_agent_push("accepted")
    except Exception as exc:
        logger.debug("Failed to record agent push metric: %s", exc)

    return jsonify({"accepted": True}), 202


@agent_bp.get("/poll")
@limiter.limit(
    lambda: current_app.config.get("AGENT_POLL_RATE_LIMIT", "120 per minute"),
    key_func=_agent_rate_limit_key,
)
def agent_poll():
    data = {"uuid": request.headers.get("X-Agent-UUID")}
    server, _ = _authenticate_agent(data)

    now = _utc_now()
    commands = (
        AgentCommand.query
        .filter(AgentCommand.server_id == server.id, AgentCommand.status == "pending")
        .filter((AgentCommand.expires_at.is_(None)) | (AgentCommand.expires_at >= now))
        .order_by(AgentCommand.created_at.asc())
        .limit(20)
        .all()
    )

    try:
        record_agent_poll("ok")
    except Exception as exc:
        logger.debug("Failed to record agent poll metric: %s", exc)

    logger.info(
        "agent poll: %d pending commands",
        len(commands),
        extra={"server_id": server.id},
    )

    return jsonify({
        "config": server.agent_config or {},
        "commands": [c.to_dict() for c in commands],
    })


@agent_bp.post("/ack")
@limiter.limit(
    lambda: current_app.config.get("AGENT_ACK_RATE_LIMIT", "120 per minute"),
    key_func=_agent_rate_limit_key,
)
def agent_ack():
    """Agent 命令确认：将已执行的命令标记为 executed。
    请求体: {"command_ids": [1, 2, 3]}
    """
    data = request.get_json(silent=True) or {}
    server, _ = _authenticate_agent(data)

    command_ids = data.get("command_ids") or []
    if not isinstance(command_ids, list):
        raise ValidationError("command_ids 必须是列表", field="command_ids")
    if len(command_ids) > 50:
        raise ValidationError("单次最多确认 50 条命令", field="command_ids")

    now = _utc_now()
    updated = 0
    for cid in command_ids:
        try:
            cmd = AgentCommand.query.filter_by(
                id=int(cid), server_id=server.id
            ).first()
            if cmd and cmd.status == "pending":
                cmd.status = "executed"
                cmd.executed_at = now
                updated += 1
        except (TypeError, ValueError):
            continue

    try:
        db.session.commit()
    except Exception:
        db.session.rollback()
        try:
            record_agent_ack("error")
        except Exception as metric_exc:
            logger.debug("Failed to record agent ack error metric: %s", metric_exc)
        raise

    try:
        record_agent_ack("ok")
    except Exception as exc:
        logger.debug("Failed to record agent ack metric: %s", exc)

    logger.info(
        "agent ack: %d commands acknowledged",
        updated,
        extra={"server_id": server.id},
    )

    return jsonify({"ok": True, "updated": updated})
