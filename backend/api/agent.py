"""
/api/agent  — Agent 认领、推送、轮询命令
"""
import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import requests
import threading
import time
from datetime import datetime, timedelta, timezone

import extensions
from flask import Blueprint, current_app, jsonify, request
from werkzeug.security import check_password_hash

from extensions import db
from middleware.rate_limit import limiter
from middleware.rbac import admin_required, owner_required
from middleware.metrics_middleware import record_agent_push, record_agent_poll, record_agent_ack
from models.models import AgentCommand, Server, format_server_location, record_ops_event
from utils.errors import AuthenticationError, ValidationError

agent_bp = Blueprint("agent", __name__)
logger = logging.getLogger(__name__)

_CLOCK_SKEW_SECONDS = 60
_OVERLAP_MINUTES = 5
_QUEUE_KEY = "vps:agent:metrics_queue"


class _RateLimitedWarning:
    """Emit a ``logger.warning`` at most once per *interval* seconds per *key*.

    Calls that arrive within the cooldown window are counted as suppressed.
    When the next emission fires it appends ``[+N suppressed]`` to the message
    and sets ``suppressed=N`` in the structured ``extra`` dict, so log
    aggregators can still observe the total event frequency without every
    request flooding the log stream during a Redis outage.

    Thread-safe; the optional *_clock* argument (callable → float) allows
    monotonic-clock injection in unit tests.
    """

    def __init__(self, interval: float = 60.0, _clock=None):
        self._interval = interval
        self._clock = _clock or time.monotonic
        self._lock = threading.Lock()
        # key -> [last_emit_monotonic, suppressed_count]
        self._state: dict[str, list] = {}

    def warning(self, lg: logging.Logger, key: str, msg: str, *args, **kwargs):
        now = self._clock()
        emit = False
        suppressed = 0
        with self._lock:
            entry = self._state.get(key)
            if entry is None or now - entry[0] >= self._interval:
                suppressed = entry[1] if entry else 0
                self._state[key] = [now, 0]
                emit = True
            else:
                entry[1] += 1
        if not emit:
            return
        if suppressed:
            extra = dict(kwargs.pop("extra", None) or {})
            extra["suppressed"] = suppressed
            lg.warning(msg + " [+%d suppressed]", *(*args, suppressed), extra=extra, **kwargs)
        else:
            lg.warning(msg, *args, **kwargs)


_warn = _RateLimitedWarning(interval=60.0)

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
            _warn.warning(
                logger, "nonce_redis_error",
                "agent nonce validation skipped: Redis error (uuid=%s): %s. "
                "Replay protection degraded for the duration of Redis outage.",
                uuid, exc,
            )
    else:
        # Redis 不可用时无法执行防重放校验，记录警告后降级放行。
        # 此窗口期内短暂的重放攻击风险由 timestamp 窗口（_CLOCK_SKEW_SECONDS）和
        # HMAC 签名提供的有限保护兜底；运维侧应尽快恢复 Redis。
        _warn.warning(
            logger, "nonce_redis_unavailable",
            "agent nonce validation skipped: Redis unavailable (uuid=%s). "
            "Replay protection degraded for the duration of Redis outage.",
            uuid,
        )


def _enforce_transport_security():
    require_tls = current_app.config.get("AGENT_REQUIRE_TLS")
    if require_tls is None:
        require_tls = not current_app.config.get("TESTING", False)
    if not require_tls or request.is_secure:
        return

    # Live deployment runs the API behind Docker. The on-host agent may push to
    # the published HTTP port and arrive as docker-bridge/private source
    # (for example 172.18.0.1). Keep public HTTP rejected, but allow local/private
    # agent transport because HMAC + nonce still authenticate the payload.
    remote = request.remote_addr or ""
    try:
        ip = ipaddress.ip_address(remote)
        if ip.is_loopback or ip.is_private or ip.is_link_local:
            return
    except ValueError:
        pass

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


def _num(v, cast):
    try:
        if v is None or v == '':
            return None
        return cast(v)
    except (TypeError, ValueError):
        return None


def _geo_lookup_by_ip(ip: str) -> dict:
    ip = (ip or '').strip()
    if not ip:
        return {}
    try:
        url = f"http://ip-api.com/json/{ip}?fields=status,country,regionName,city,lat,lon,isp,org,query&lang=zh-CN"
        resp = requests.get(url, timeout=6)
        d = resp.json() if resp.ok else {}
        if d.get('status') != 'success':
            return {}
        return {
            'country': d.get('country') or '',
            'region': d.get('regionName') or '',
            'city': d.get('city') or '',
            'lat': d.get('lat'),
            'lon': d.get('lon'),
            'isp': d.get('isp') or '',
            'org': d.get('org') or '',
            'query': d.get('query') or ip,
        }
    except Exception:
        return {}


def _agent_readonly_policy(server: Server) -> dict:
    cfg = server.agent_config if isinstance(server.agent_config, dict) else {}
    caps = cfg.get("capabilities") if isinstance(cfg.get("capabilities"), dict) else {}
    return {
        "readonly": True,
        "exec": False,
        "terminal": False,
        "file_list": False,
        "reason": "监控面板与 TG 机器人仅允许只读监控，禁止远程执行/在线终端/文件列表任务。",
        "capabilities": {
            "exec": False,
            "terminal": False,
            "file_list": False,
            **caps,
            "exec": False,
            "terminal": False,
            "file_list": False,
        },
    }


def _apply_agent_inventory(server: Server, data: dict):
    inv = {}
    for key in ('inventory', 'system', 'spec', 'hardware'):
        val = data.get(key)
        if isinstance(val, dict):
            inv.update(val)
    inv.update({k: v for k, v in data.items() if k in {
        'hostname', 'os', 'os_name', 'arch', 'architecture', 'cpu_cores', 'cpu', 'ram_gb', 'memory_gb', 'disk_gb', 'storage_gb', 'bandwidth', 'ip'
    }})

    changed = False
    cpu = _num(inv.get('cpu_cores', inv.get('cpu')), int)
    ram = _num(inv.get('ram_gb', inv.get('memory_gb')), float)
    disk = _num(inv.get('disk_gb', inv.get('storage_gb')), int)
    bw = inv.get('bandwidth')
    hostname = inv.get('hostname')
    os_name = inv.get('os') or inv.get('os_name')
    arch = inv.get('arch') or inv.get('architecture')
    network_report = data.get('network') if isinstance(data.get('network'), dict) else {}
    public_ipv4 = str(network_report.get('public_ipv4') or data.get('public_ipv4') or '').strip()
    public_ipv6 = str(network_report.get('public_ipv6') or data.get('public_ipv6') or '').strip()
    local_ipv4 = str(network_report.get('local_ipv4') or inv.get('ip') or data.get('ip') or '').strip()
    agent_ip = public_ipv4 or local_ipv4 or str(server.ip or '').strip()

    if cpu is not None and 0 < cpu <= 1024 and server.cpu_cores != cpu:
        server.cpu_cores = cpu
        changed = True
    if ram is not None and 0 < ram <= 16384 and server.ram_gb != ram:
        server.ram_gb = ram
        changed = True
    if disk is not None and 0 < disk <= 1048576 and server.disk_gb != disk:
        server.disk_gb = disk
        changed = True
    if isinstance(bw, str) and bw.strip() and server.bandwidth != bw.strip():
        server.bandwidth = bw.strip()
        changed = True

    cfg = dict(server.agent_config or {})
    extra = dict(cfg.get('inventory_meta') or {})

    if hostname:
        extra['hostname'] = str(hostname).strip()
    if os_name:
        extra['os'] = str(os_name).strip()
    if arch:
        extra['arch'] = str(arch).strip()

    if network_report:
        network = dict(cfg.get('network') or {})
        for key in ('local_ipv4', 'public_ipv4', 'public_ipv6'):
            value = str(network_report.get(key) or '').strip()
            if value:
                network[key] = value
        local_ipv6 = network_report.get('local_ipv6')
        if isinstance(local_ipv6, list):
            network['local_ipv6'] = [str(v).strip() for v in local_ipv6 if str(v).strip()][:8]
        network['updated_at'] = _utc_now().isoformat()
        cfg['network'] = network
        extra['network'] = network

    if agent_ip:
        extra['ip'] = agent_ip
        if server.ip != agent_ip:
            server.ip = agent_ip
            changed = True

    geo_lookup_ip = public_ipv4 or agent_ip
    geo = _geo_lookup_by_ip(geo_lookup_ip) if geo_lookup_ip else {}
    if geo:
        for key in ('city', 'country', 'region', 'isp', 'org', 'query'):
            value = str(geo.get(key) or '').strip()
            if value:
                extra[key] = value
                cfg[key] = value
        lat = geo.get('lat')
        lon = geo.get('lon')
        if lat is not None and lon is not None:
            extra['lat'] = lat
            extra['lon'] = lon
            cfg['lat'] = lat
            cfg['lon'] = lon
        provider_guess = str(geo.get('org') or geo.get('isp') or '').strip()
        if provider_guess:
            extra['provider_guess'] = provider_guess
            cfg['provider_guess'] = provider_guess

        auto_location = format_server_location(extra.get('city'), extra.get('region'), extra.get('country'))
        if auto_location and server.location != auto_location:
            server.location = auto_location
            changed = True

    cfg['inventory_meta'] = extra
    if server.agent_config != cfg:
        server.agent_config = cfg
        changed = True
    return changed


def _authenticate_agent(payload: dict) -> tuple[Server, str]:
    _enforce_transport_security()
    uuid = payload.get("uuid") or request.headers.get("X-Agent-UUID")
    if not uuid:
        try:
            record_ops_event("agent_auth_failed", "Agent 认证失败", message="missing uuid", level="warn", payload={"reason": "missing_uuid", "remote_addr": request.headers.get("X-Forwarded-For", request.remote_addr), "has_json": bool(payload), "has_agent_key_header": bool(request.headers.get("X-Agent-Key")), "has_uuid_header": bool(request.headers.get("X-Agent-UUID")), "user_agent": request.headers.get("User-Agent", "")[:120]})
            db.session.commit()
        except Exception:
            db.session.rollback()
        raise AuthenticationError("missing uuid")

    server = Server.query.filter_by(uuid=uuid).first()
    if not server:
        try:
            record_ops_event("agent_register_failed", "未知 Agent 认领失败", message="unknown agent", level="error", payload={"uuid": uuid})
            db.session.commit()
        except Exception:
            db.session.rollback()
        raise AuthenticationError("unknown agent")

    ts = request.headers.get("X-Agent-Timestamp", "")
    nonce = request.headers.get("X-Agent-Nonce", "")
    sig = request.headers.get("X-Agent-Signature", "")
    agent_key = request.headers.get("X-Agent-Key", "")
    if not all([ts, nonce, sig, agent_key]):
        try:
            record_ops_event("agent_auth_failed", f"Agent 认证失败 · {server.name}", message="missing auth headers", level="warn", server_id=server.id, payload={"uuid": uuid, "reason": "missing_auth_headers", "remote_addr": request.headers.get("X-Forwarded-For", request.remote_addr), "has_ts": bool(ts), "has_nonce": bool(nonce), "has_sig": bool(sig), "has_key": bool(agent_key), "user_agent": request.headers.get("User-Agent", "")[:120]})
            db.session.commit()
        except Exception:
            db.session.rollback()
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
        try:
            record_ops_event("agent_auth_failed", f"Agent 认证失败 · {server.name}", message="invalid key", level="warn", server_id=server.id, payload={"uuid": uuid, "reason": "invalid_key", "remote_addr": request.headers.get("X-Forwarded-For", request.remote_addr)})
            db.session.commit()
        except Exception:
            db.session.rollback()
        raise AuthenticationError("invalid key")

    expected = _hmac_digest(
        secret=agent_key,
        body=request.get_data(cache=True) or b"",
        ts=ts,
        nonce=nonce,
    )
    if not hmac.compare_digest(expected, sig):
        try:
            record_ops_event("agent_auth_failed", f"Agent 认证失败 · {server.name}", message="signature mismatch", level="warn", server_id=server.id, payload={"uuid": uuid, "reason": "signature_mismatch", "remote_addr": request.headers.get("X-Forwarded-For", request.remote_addr)})
            db.session.commit()
        except Exception:
            db.session.rollback()
        raise AuthenticationError("signature mismatch")

    server.agent_key_last_used = _utc_now()
    return server, uuid


@agent_bp.post("/register")
def agent_register():
    data = request.get_json(silent=True) or {}
    hostname = (data.get("hostname") or data.get("host") or socket.gethostname() or "auto")[:64]
    import uuid, secrets
    from werkzeug.security import generate_password_hash
    new_uuid = str(uuid.uuid4())
    new_key = secrets.token_urlsafe(32)
    remote_ip = request.headers.get("X-Forwarded-For", request.remote_addr) or ""
    srv = Server(
        name=hostname, uuid=new_uuid,
        agent_key_hash=generate_password_hash(new_key),
        agent_key_last_used=datetime.utcnow(),
        agent_config={}, ip=remote_ip
    )
    db.session.add(srv)
    db.session.commit()
    return jsonify({"ok": True, "server_id": srv.id, "uuid": new_uuid, "agent_key": new_key}), 201

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
            _warn.warning(
                logger, "rpush_failed",
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
            _warn.warning(
                logger, "load_shedding",
                "agent push: Redis unavailable and fallback DB concurrency limit reached;"
                " metrics dropped (load-shedding)",
                extra={"server_id": server.id, "uuid": uuid},
            )
            try:
                record_agent_push("dropped")
            except Exception as exc:
                _warn.warning(logger, "metric_dropped_record_failed",
                              "Failed to record agent push dropped metric: %s", exc)
        else:
            try:
                _record_metrics(server, data)
                _apply_agent_inventory(server, data)
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
        record_ops_event("agent_push_ok", f"Agent 上报成功 · {server.name}", message="metrics accepted", server_id=server.id, payload={"status": server.status, "ip": server.ip, "uuid": uuid})
        db.session.commit()
    except Exception:
        db.session.rollback()

    try:
        record_agent_push("accepted")
    except Exception as exc:
        _warn.warning(logger, "metric_accepted_record_failed",
                      "Failed to record agent push metric: %s", exc)

    return jsonify({"accepted": True}), 202


@agent_bp.post("/probe-results")
@limiter.limit(
    lambda: current_app.config.get("AGENT_PUSH_RATE_LIMIT", "60 per minute"),
    key_func=_agent_rate_limit_key,
)
def agent_probe_results():
    data = request.get_json(silent=True) or {}
    server, uuid = _authenticate_agent(data)
    results = data.get("results") or []
    for r in results:
        if "latency_ms" in r and "stats" not in r:
            r["stats"] = {"avg_ms": r.get("latency_ms"), "loss_pct": r.get("loss_pct", 0), "count": 1}
            r["quality"] = 100 if (r.get("latency_ms") and r["latency_ms"] < 100) else (50 if r.get("latency_ms") and r["latency_ms"] < 300 else 0)
    if not results:
        return jsonify({"accepted": False, "reason": "no results"}), 400
    try:
        from datetime import datetime as dt
        ts = dt.utcnow()
        stored = 0
        for r in results:
            lat = r.get("latency_ms") or (r.get("stats") or {}).get("avg_ms")
            db.session.execute(db.text(
                "INSERT INTO ping_target_results (server_id,target_key,label,host,port,protocol,latency_ms,success,loss_pct,quality,created_at) VALUES (:sid,:key,:label,:host,:port,:proto,:lat,:ok,:loss,:qual,:ts)"),
                {"sid":server.id,"key":str(r.get("key") or r.get("host") or "unknown")[:128],"label":str(r.get("label") or r.get("host") or "")[:255],"host":str(r.get("host") or "")[:255],"port":r.get("port"),"proto":str(r.get("protocol") or "tcp")[:16],"lat":float(lat) if lat is not None else None,"ok":1 if lat is not None else 0,"loss":r.get("loss_pct"),"qual":int(r.get("quality",0)) if isinstance(r.get("quality"),(int,float)) else (100 if (r.get("latency_ms") and r["latency_ms"]<100) else (50 if r.get("latency_ms") and r["latency_ms"]<300 else 0)),"ts":ts})
            stored += 1
        db.session.commit()
        logger.info("agent probe stored", extra={"server_id": server.id, "count": stored})
        return jsonify({"accepted": True, "stored": stored}), 202
    except Exception as exc:
        db.session.rollback()
        logger.warning("agent probe results failed: %s", exc, extra={"server_id": server.id})
        return jsonify({"accepted": False, "reason": str(exc)[:200]}), 500

@agent_bp.get("/poll")
@limiter.limit(
    lambda: current_app.config.get("AGENT_POLL_RATE_LIMIT", "120 per minute"),
    key_func=_agent_rate_limit_key,
)
def agent_poll():
    data = {"uuid": request.headers.get("X-Agent-UUID")}
    server, _ = _authenticate_agent(data)

    policy = _agent_readonly_policy(server)
    if not current_app.config.get("TESTING") and (
        policy.get("readonly") or not current_app.config.get("AGENT_COMMANDS_ENABLED", False)
    ):
        stale = AgentCommand.query.filter(AgentCommand.server_id == server.id, AgentCommand.status == "pending").all()
        for cmd in stale:
            cmd.status = "disabled"
        if stale:
            db.session.commit()
        try:
            record_agent_poll("ok")
        except Exception as exc:
            logger.debug("Failed to record agent poll metric: %s", exc)
        return jsonify({
            "config": server.agent_config or {},
            "commands": [],
            "readonly": True,
            "policy": policy,
        })

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

@agent_bp.get("/install.sh")
def agent_install_script():
    script = r'''#!/usr/bin/env bash
set -euo pipefail

API_ROOT=""
AGENT_UUID=""
AGENT_KEY=""
SERVER_ID=""
INSTALL_DIR="/opt/vps-agent"
SERVICE_NAME="vps-agent.service"
INTERVAL="20"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --api-root) API_ROOT="$2"; shift 2 ;;
    --auto-register)
      AUTO_REGISTER=1
      shift
      ;;
  --uuid) AGENT_UUID="$2"; shift 2 ;;
    --agent-key) AGENT_KEY="$2"; shift 2 ;;
    --server-id) SERVER_ID="$2"; shift 2 ;;
    --interval) INTERVAL="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$API_ROOT" || -z "$AGENT_UUID" || -z "$AGENT_KEY" || -z "$SERVER_ID" ]]; then
  echo "Usage: install.sh --api-root URL --uuid UUID --agent-key KEY --server-id ID [--interval 20]" >&2
  exit 1
fi
case "$API_ROOT" in http://*|https://*) ;; *) echo "Invalid --api-root" >&2; exit 1 ;; esac
if [[ ! "$SERVER_ID" =~ ^[0-9]+$ ]]; then echo "Invalid --server-id" >&2; exit 1; fi
if [[ ! "$INTERVAL" =~ ^[0-9]+$ ]]; then echo "Invalid --interval" >&2; exit 1; fi
if (( INTERVAL < 10 || INTERVAL > 3600 )); then echo "Invalid --interval range" >&2; exit 1; fi

mkdir -p "$INSTALL_DIR"
umask 077
{
  printf 'API_ROOT=%q
' "$API_ROOT"
  printf 'AGENT_UUID=%q
' "$AGENT_UUID"
  printf 'AGENT_KEY=%q
' "$AGENT_KEY"
  printf 'SERVER_ID=%q
' "$SERVER_ID"
  printf 'INTERVAL=%q
' "$INTERVAL"
} > "$INSTALL_DIR/agent.env"

cat > "$INSTALL_DIR/agent.py" <<'PY2'
def read_os_name():
    try:
        data = {}
        with open("/etc/os-release", "r", encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip().split("=", 1)
                    data[k] = v.strip().strip('"')
        return data.get("PRETTY_NAME") or data.get("NAME") or platform.platform()
    except Exception:
        return platform.platform()

def get_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(2)
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
        return ip or "127.0.0.1"
    except Exception:
        return "127.0.0.1"

def meminfo():
    vals = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as f:
        for line in f:
            key, rest = line.split(":", 1)
            vals[key] = int(rest.strip().split()[0])
    total = vals.get("MemTotal", 0) / 1024 / 1024
    avail = vals.get("MemAvailable", 0) / 1024 / 1024
    used_pct = 0 if total <= 0 else round((1 - avail / total) * 100, 2)
    return round(total, 2), used_pct

def diskinfo():
    du = shutil.disk_usage("/")
    total = du.total / 1024 / 1024 / 1024
    used_pct = 0 if du.total <= 0 else round((du.used / du.total) * 100, 2)
    return int(round(total)), used_pct

def uptime_text():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            sec = int(float(f.read().split()[0]))
        days, rem = divmod(sec, 86400)
        hours, rem = divmod(rem, 3600)
        mins, _ = divmod(rem, 60)
        parts = []
        if days: parts.append(f"{days} days")
        if hours: parts.append(f"{hours} hours")
        parts.append(f"{mins} minutes")
        return ", ".join(parts)
    except Exception:
        return ""

def net_totals():
    rx = tx = 0
    with open("/proc/net/dev", "r", encoding="utf-8") as f:
        lines = f.readlines()[2:]
    for line in lines:
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo": continue
        parts = rest.split()
        rx += int(parts[0])
        tx += int(parts[8])
    return rx, tx

def net_rates():
    now = time.time()
    rx, tx = net_totals()
    prev = {}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            prev = json.load(f)
    except Exception:
        prev = {}
    prev_t = float(prev.get("t", now))
    prev_rx = int(prev.get("rx", rx))
    prev_tx = int(prev.get("tx", tx))
    dt = max(1e-6, now - prev_t)
    down = max(0.0, (rx - prev_rx) / 1024 / dt)
    up = max(0.0, (tx - prev_tx) / 1024 / dt)
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"t": now, "rx": rx, "tx": tx}, f)
    except Exception:
        pass
    return round(up, 2), round(down, 2)

def cpu_use(cpu_cores):
    try:
        load1 = os.getloadavg()[0]
        return round(min(100.0, max(0.0, load1 / max(cpu_cores, 1) * 100)), 2)
    except Exception:
        return 0.0

def payload():
    cores = os.cpu_count() or 1
    ram_gb, ram_use = meminfo()
    disk_gb, disk_use = diskinfo()
    net_up, net_down = net_rates()
    return {
        "uuid": AGENT_UUID, "status": "online", "hostname": socket.gethostname(),
        "os": read_os_name(), "arch": platform.machine(), "cpu_cores": cores,
        "ram_gb": ram_gb, "disk_gb": disk_gb, "bandwidth": "N/A",
        "ip": get_ip(), "cpu_use": cpu_use(cores), "ram_use": ram_use,
        "disk_use": disk_use, "net_up": net_up, "net_down": net_down,
        "uptime": uptime_text(),
    }

def sign(body, ts, nonce):
    msg = f"{ts}.{nonce}.".encode("utf-8") + body
    return hmac.new(AGENT_KEY.encode("utf-8"), msg, hashlib.sha256).hexdigest()

def http_get(path, timeout=10):
    req = urllib.request.Request(API_ROOT + path, method="GET")
    req.add_header("X-Agent-UUID", AGENT_UUID)
    req.add_header("X-Agent-Key", AGENT_KEY)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))

def push_once():
    data = payload()
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ts = str(int(time.time()))
    nonce = str(int(time.time() * 1000))
    req = urllib.request.Request(API_ROOT + "/api/v1/agent/push", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Agent-UUID", AGENT_UUID)
    req.add_header("X-Agent-Key", AGENT_KEY)
    req.add_header("X-Agent-Timestamp", ts)
    req.add_header("X-Agent-Nonce", nonce)
    req.add_header("X-Agent-Signature", sign(body, ts, nonce))
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", "ignore")

# ── Peer probe ─────────────────────────────────────────────────
def tcp_probe(host, port, timeout=5):
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((str(host), int(port)))
        elapsed = (time.time() - start) * 1000
        sock.close()
        return round(elapsed, 1) if result == 0 else None
    except Exception:
        return None

def probe_targets():
    try:
        targets_resp = http_get(f"/api/v1/probe/public/ping-targets/{SERVER_ID}?count=2&source=agent")
    except Exception:
        return
    targets = targets_resp.get("targets", [])
    if not targets:
        return
    results = []
    for t in targets:
        host = t.get("host") or t.get("label")
        port = t.get("port") or 80
        latency = tcp_probe(host, port)
        results.append({
            "key": t.get("key", str(host)), "host": host, "port": port,
            "protocol": t.get("protocol", "tcp"),
            "latency_ms": latency, "success": latency is not None,
            "loss_pct": 0 if latency is not None else 100,
        })
    if results:
        body = json.dumps({"results": results, "agent_uuid": AGENT_UUID}, ensure_ascii=False).encode("utf-8")
        ts = str(int(time.time()))
        nonce = str(int(time.time() * 1000))
        req = urllib.request.Request(API_ROOT + "/api/v1/agent/probe-results", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Agent-UUID", AGENT_UUID)
        req.add_header("X-Agent-Key", AGENT_KEY)
        req.add_header("X-Agent-Timestamp", ts)
        req.add_header("X-Agent-Nonce", nonce)
        req.add_header("X-Agent-Signature", sign(body, ts, nonce))
        try:
            urllib.request.urlopen(req, timeout=15)
        except Exception:
            pass

last_probe = 0
while True:
    try:
        push_once()
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] push failed: {e}", flush=True)
    now = time.time()
    if now - last_probe >= PROBE_INTERVAL:
        try:
            probe_targets()
        except Exception as e:
            print(f"[{datetime.utcnow().isoformat()}] probe failed: {e}", flush=True)
        last_probe = now
    time.sleep(INTERVAL)
PY2
chmod +x "$INSTALL_DIR/agent.py"

install -m 0644 /dev/null "/etc/systemd/system/$SERVICE_NAME"
cat > "/etc/systemd/system/$SERVICE_NAME" <<EOF
[Unit]
Description=VPS Readonly Metrics Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=$INSTALL_DIR/agent.env
ExecStart=/usr/bin/python3 $INSTALL_DIR/agent.py
Restart=always
RestartSec=5
User=root
WorkingDirectory=$INSTALL_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager --full | sed -n "1,20p"
echo "installed: $SERVICE_NAME"
'''
    return current_app.response_class(script, mimetype='text/plain; charset=utf-8')