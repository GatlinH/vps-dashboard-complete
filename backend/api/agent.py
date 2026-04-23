"""
/api/agent  — Agent 认领、推送、轮询命令
"""
import hashlib
import hmac
import json
import secrets
from datetime import datetime, timedelta, timezone

import extensions
from flask import Blueprint, current_app, jsonify, request
from werkzeug.security import check_password_hash

from extensions import db
from middleware.rate_limit import limiter
from models.models import AgentCommand, ProbeResult, Server
from utils.errors import AuthenticationError, ValidationError

agent_bp = Blueprint("agent", __name__)

_CLOCK_SKEW_SECONDS = 60
_OVERLAP_MINUTES = 5
_QUEUE_KEY = "vps:agent:metrics_queue"


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
        # 使用 Redis 原子写入（SET NX EX），避免 exists()+setex() 竞态
        accepted = extensions.redis_client.set(
            nonce_key,
            "1",
            ex=_CLOCK_SKEW_SECONDS,
            nx=True,
        )
        if not accepted:
            raise AuthenticationError("replayed request")


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
    for field in ["cpu_use", "ram_use", "disk_use", "net_up", "net_down", "status", "uptime"]:
        if field in data:
            setattr(server, field, data[field])

    bytes_out = data.get("bytes_out_total")
    bytes_in = data.get("bytes_in_total")
    if bytes_out is not None and bytes_in is not None:
        try:
            bytes_out = int(bytes_out)
            bytes_in = int(bytes_in)
            prev_out = server.bytes_out_snapshot or 0
            prev_in = server.bytes_in_snapshot or 0
            if prev_out > 0 and bytes_out >= prev_out:
                server.traffic_up_gb = round((server.traffic_up_gb or 0) + (bytes_out - prev_out) / 1024 / 1024 / 1024, 6)
            if prev_in > 0 and bytes_in >= prev_in:
                server.traffic_down_gb = round((server.traffic_down_gb or 0) + (bytes_in - prev_in) / 1024 / 1024 / 1024, 6)
            server.traffic_used_gb = (server.traffic_up_gb or 0) + (server.traffic_down_gb or 0)
            server.bytes_out_snapshot = bytes_out
            server.bytes_in_snapshot = bytes_in
        except (TypeError, ValueError):
            pass

    db.session.add(ProbeResult(
        server_id=server.id,
        cpu_use=data.get("cpu_use", server.cpu_use),
        ram_use=data.get("ram_use", server.ram_use),
        disk_use=data.get("disk_use", server.disk_use),
        net_up=data.get("net_up", server.net_up),
        net_down=data.get("net_down", server.net_down),
        latency_ms=data.get("latency_ms"),
        status=data.get("status", server.status),
    ))


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

    if extensions.redis_client and hasattr(extensions.redis_client, "rpush"):
        payload = json.dumps(
            {"server_id": server.id, "uuid": uuid, "metrics": data, "received_at": _utc_now().isoformat()},
            ensure_ascii=False,
        )
        extensions.redis_client.rpush(_QUEUE_KEY, payload)
    else:
        _record_metrics(server, data)
        db.session.commit()

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

    return jsonify({
        "config": server.agent_config or {},
        "commands": [c.to_dict() for c in commands],
    })
