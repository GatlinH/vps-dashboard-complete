"""
/api/agent  — Agent 认领、推送、轮询命令
"""
import hashlib
import hmac
import ipaddress
import json
import logging
import re
import secrets
import socket
import requests
import threading
import time
from datetime import datetime, timedelta, timezone

import extensions
from flask import Blueprint, current_app, jsonify, request
from pathlib import Path
import base64

_RELEASE_VERSION_RE = re.compile(r"^agent-v[0-9A-Za-z][0-9A-Za-z._-]{0,127}$")
_RELEASE_FILE_RE = re.compile(r"^(?:manifest\.(?:json|sig)|vps-dashboard-agent-linux-(?:amd64|arm64))$")

_UNKNOWN_AGENT_EVENT_LOCK = threading.Lock()
_UNKNOWN_AGENT_EVENT_LAST = {}

def _record_unknown_agent_event_once(source, reason, interval=300, sample_uuid=None):
    """Bound unknown-agent DB writes by source/reason; fail closed on errors."""
    now = time.monotonic()
    key = (str(source or 'unknown'), str(reason or 'unknown'))
    with _UNKNOWN_AGENT_EVENT_LOCK:
        last = _UNKNOWN_AGENT_EVENT_LAST.get(key, 0)
        if now - last < interval:
            return False
        _UNKNOWN_AGENT_EVENT_LAST[key] = now
    try:
        record_ops_event('agent_register_failed', '未知 Agent 认领失败', message=reason,
                         level='error', payload={'source': key[0], 'reason': key[1], 'sample_uuid': sample_uuid})
        db.session.commit()
        return True
    except Exception:
        db.session.rollback()
        return False


def _pinned_agent_release_public_key() -> str:
    """Return the image/source-pinned Ed25519 trust anchor, never a served key."""
    candidates = (
        Path("/app/agent-release-ed25519-public.b64"),
        Path(__file__).resolve().parents[2] / "scripts" / "release" /
        "agent-release-ed25519-public.b64",
    )
    for path in candidates:
        if path.is_file():
            return path.read_text(encoding="ascii").strip()
    raise FileNotFoundError("agent release Ed25519 trust anchor missing")


def _configured_agent_release(version: str) -> Path | None:
    """Resolve only the single release explicitly configured by the operator."""
    configured_version = current_app.config.get("AGENT_RELEASE_VERSION", "")
    root = current_app.config.get("AGENT_RELEASE_DIR", "")
    if not root or version != configured_version or not _RELEASE_VERSION_RE.fullmatch(version):
        return None
    candidate = (Path(root).resolve() / version).resolve()
    try:
        candidate.relative_to(Path(root).resolve())
    except ValueError:
        return None
    return candidate if candidate.is_dir() else None
from sqlalchemy.orm.attributes import flag_modified
from werkzeug.security import check_password_hash

from extensions import db
from middleware.rate_limit import limiter
from middleware.rbac import admin_required, owner_required
from middleware.metrics_middleware import record_agent_push, record_agent_poll, record_agent_ack
from models.models import AgentCommand, Server, format_server_location, record_ops_event
from utils.errors import AuthenticationError, ValidationError
from utils.request_context import audit_client_ip

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
    return f"agent-ip:{request.remote_addr or 'unknown'}"


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
        'hostname', 'agent_version', 'os', 'os_name', 'kernel', 'kernel_version', 'arch', 'architecture',
        'cpu_model', 'cpu_name', 'processor', 'cpu_cores', 'cpu',
        'ram_gb', 'memory_gb', 'disk_gb', 'storage_gb', 'bandwidth', 'ip'
    }})

    changed = False
    cpu = _num(inv.get('cpu_cores', inv.get('cpu')), int)
    ram = _num(inv.get('ram_gb', inv.get('memory_gb')), float)
    disk = _num(inv.get('disk_gb', inv.get('storage_gb')), int)
    bw = inv.get('bandwidth')
    hostname = inv.get('hostname')
    agent_version = inv.get('agent_version')
    os_name = inv.get('os') or inv.get('os_name')
    kernel_version = inv.get('kernel_version') or inv.get('kernel')
    arch = inv.get('arch') or inv.get('architecture')
    cpu_model = inv.get('cpu_model') or inv.get('cpu_name') or inv.get('processor')
    network_report = data.get('network') if isinstance(data.get('network'), dict) else {}
    public_ipv4 = str(network_report.get('public_ipv4') or data.get('public_ipv4') or '').strip()
    public_ipv6 = str(network_report.get('public_ipv6') or data.get('public_ipv6') or '').strip()
    local_ipv4 = str(network_report.get('local_ipv4') or inv.get('ip') or data.get('ip') or '').strip()
    local_ipv6_values = network_report.get('local_ipv6') if isinstance(network_report.get('local_ipv6'), list) else []
    local_ipv6 = next((str(value).strip() for value in local_ipv6_values if str(value).strip()), '')
    # A direct IPv6-only node has no IPv4 fallback; retain its IPv6 identity
    # rather than overwriting it with an empty/private IPv4 placeholder.
    agent_ip = public_ipv4 or public_ipv6 or local_ipv4 or local_ipv6 or str(server.ip or '').strip()

    # A NAT'd node can only see its private address, so the fallback chain above
    # would replace an already-known public IP with something like 172.16.x.x --
    # unreachable for peer probes, which silently drops the node out of the global
    # probe matrix. Never downgrade a public address to a private one.
    def _is_private_addr(value: str) -> bool:
        try:
            parsed = ipaddress.ip_address(value)
        except ValueError:
            return False
        return (
            parsed.is_private
            or parsed.is_loopback
            or parsed.is_link_local
            or parsed.is_reserved
        )

    current_ip = str(server.ip or '').strip()
    if (
        agent_ip
        and current_ip
        and agent_ip != current_ip
        and _is_private_addr(agent_ip)
        and not _is_private_addr(current_ip)
    ):
        agent_ip = current_ip

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
    if agent_version:
        extra['agent_version'] = str(agent_version).strip()[:80]
    if os_name:
        extra['os'] = str(os_name).strip()[:160]
    if kernel_version:
        extra['kernel_version'] = str(kernel_version).strip()[:160]
    if arch:
        extra['arch'] = str(arch).strip()[:80]
    if cpu_model:
        extra['cpu_model'] = str(cpu_model).strip()[:240]

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

    # Geo-locating a private address is meaningless and returns nothing useful, so
    # prefer any public address we already trust over the agent's private view.
    geo_lookup_ip = public_ipv4 or agent_ip
    if geo_lookup_ip and _is_private_addr(geo_lookup_ip):
        fallback_ip = str(server.ip or '').strip()
        geo_lookup_ip = fallback_ip if fallback_ip and not _is_private_addr(fallback_ip) else ''
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
        flag_modified(server, 'agent_config')
        changed = True
    return changed


def _authenticate_agent(payload: dict) -> tuple[Server, str]:
    _enforce_transport_security()
    uuid = payload.get("uuid") or request.headers.get("X-Agent-UUID")
    if not uuid:
        try:
            record_ops_event("agent_auth_failed", "Agent 认证失败", message="missing uuid", level="warn", payload={"reason": "missing_uuid", "remote_addr": audit_client_ip(), "has_json": bool(payload), "has_agent_key_header": bool(request.headers.get("X-Agent-Key")), "has_uuid_header": bool(request.headers.get("X-Agent-UUID")), "user_agent": request.headers.get("User-Agent", "")[:120]})
            db.session.commit()
        except Exception:
            db.session.rollback()
        raise AuthenticationError("missing uuid")

    server = Server.query.filter_by(uuid=uuid).first()
    if not server:
        _record_unknown_agent_event_once(audit_client_ip(), "unknown agent",
                                         sample_uuid=request.headers.get('X-Agent-UUID'))
        raise AuthenticationError("unknown agent")

    ts = request.headers.get("X-Agent-Timestamp", "")
    nonce = request.headers.get("X-Agent-Nonce", "")
    sig = request.headers.get("X-Agent-Signature", "")
    agent_key = request.headers.get("X-Agent-Key", "")
    if not all([ts, nonce, sig, agent_key]):
        try:
            record_ops_event("agent_auth_failed", f"Agent 认证失败 · {server.name}", message="missing auth headers", level="warn", server_id=server.id, payload={"uuid": uuid, "reason": "missing_auth_headers", "remote_addr": audit_client_ip(), "has_ts": bool(ts), "has_nonce": bool(nonce), "has_sig": bool(sig), "has_key": bool(agent_key), "user_agent": request.headers.get("User-Agent", "")[:120]})
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
            record_ops_event("agent_auth_failed", f"Agent 认证失败 · {server.name}", message="invalid key", level="warn", server_id=server.id, payload={"uuid": uuid, "reason": "invalid_key", "remote_addr": audit_client_ip()})
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
            record_ops_event("agent_auth_failed", f"Agent 认证失败 · {server.name}", message="signature mismatch", level="warn", server_id=server.id, payload={"uuid": uuid, "reason": "signature_mismatch", "remote_addr": audit_client_ip()})
            db.session.commit()
        except Exception:
            db.session.rollback()
        raise AuthenticationError("signature mismatch")

    server.agent_key_last_used = _utc_now()
    return server, uuid


@agent_bp.post("/register")
def agent_register():
    """Mint an initial agent credential only for an explicitly enrolled installer."""
    enrollment_key = str(current_app.config.get("AGENT_ENROLLMENT_KEY") or "")
    authorization = request.headers.get("Authorization", "")
    expected = f"Bearer {enrollment_key}" if enrollment_key else ""
    if not enrollment_key or not hmac.compare_digest(authorization, expected):
        return jsonify(msg="Agent 注册未启用或 enrollment key 无效"), 403

    data = request.get_json(silent=True) or {}
    hostname = (data.get("hostname") or data.get("host") or socket.gethostname() or "auto")[:64]
    import uuid, secrets
    from werkzeug.security import generate_password_hash
    new_uuid = str(uuid.uuid4())
    new_key = secrets.token_urlsafe(32)
    # L-5: use the (ProxyFix-normalized) peer address, not a client-spoofable
    # X-Forwarded-For header, when recording the enrolling agent's IP.
    remote_ip = request.remote_addr or ""
    # Seed geo at enrolment time. The richer inventory geo lookup only runs on the
    # telemetry push path, so a node that enrols but cannot push yet (for example a
    # transport-policy rejection) would otherwise sit at lat/lon 0,0 -- rendering on
    # the globe as "Null Island" with an empty city/country.
    geo = _geo_lookup_by_ip(remote_ip) if remote_ip else {}
    geo_cfg = {}
    seed_location = ""
    if geo:
        for key in ("city", "country", "region", "isp", "org", "query"):
            value = str(geo.get(key) or "").strip()
            if value:
                geo_cfg[key] = value
        lat, lon = geo.get("lat"), geo.get("lon")
        if lat is not None and lon is not None:
            geo_cfg["lat"] = lat
            geo_cfg["lon"] = lon
        seed_location = format_server_location(
            str(geo_cfg.get("city") or ""),
            str(geo_cfg.get("region") or ""),
            str(geo_cfg.get("country") or ""),
        )
    srv = Server(
        name=hostname, uuid=new_uuid,
        agent_key_hash=generate_password_hash(new_key),
        agent_key_last_used=datetime.utcnow(),
        agent_config=geo_cfg, ip=remote_ip,
        location=seed_location or None,
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
    # M-2: bound the batch size so a compromised/rogue agent cannot submit a
    # multi-million-row batch that blocks the DB connection pool in one txn.
    max_items = int(current_app.config.get("AGENT_PROBE_RESULTS_MAX_ITEMS", 500))
    if isinstance(results, list) and len(results) > max_items:
        return jsonify({
            "accepted": False,
            "reason": f"too many results (>{max_items}); split into smaller batches",
        }), 400
    for r in results:
        if "latency_ms" in r and "stats" not in r:
            r["stats"] = {"avg_ms": r.get("latency_ms"), "loss_pct": r.get("loss_pct", 0), "count": 1}
            r["quality"] = 100 if (r.get("latency_ms") and r["latency_ms"] < 100) else (50 if r.get("latency_ms") and r["latency_ms"] < 300 else 0)
    if not results:
        return jsonify({"accepted": False, "reason": "no results"}), 400
    try:
        from datetime import datetime as dt
        # Ensure the target table exists (and is partitioned on MySQL) before
        # inserting; the endpoint may be the first writer on a fresh install.
        try:
            from api.probe import _target_history_table_ready
            _target_history_table_ready()
        except Exception:
            pass
        default_ts = dt.utcnow()

        def _parse_created_at(raw):
            # Agents batch per-second samples and stamp each one; honor that
            # timestamp so chart density reflects real sample times. Fall back to
            # server receive time for legacy agents that omit created_at.
            if not raw:
                return default_ts
            try:
                s = str(raw).replace("Z", "").split("+")[0]
                return dt.fromisoformat(s)
            except Exception:
                return default_ts

        stored = 0
        for r in results:
            lat = r.get("latency_ms") or (r.get("stats") or {}).get("avg_ms")
            row_ts = _parse_created_at(r.get("created_at"))
            db.session.execute(db.text(
                "INSERT INTO ping_target_results (server_id,target_key,label,host,port,protocol,latency_ms,success,loss_pct,quality,created_at) VALUES (:sid,:key,:label,:host,:port,:proto,:lat,:ok,:loss,:qual,:ts)"),
                {"sid":server.id,"key":str(r.get("key") or r.get("host") or "unknown")[:128],"label":str(r.get("label") or r.get("host") or "")[:255],"host":str(r.get("host") or "")[:255],"port":r.get("port"),"proto":str(r.get("protocol") or "tcp")[:16],"lat":float(lat) if lat is not None else None,"ok":1 if lat is not None else 0,"loss":r.get("loss_pct"),"qual":int(r.get("quality",0)) if isinstance(r.get("quality"),(int,float)) else (100 if (r.get("latency_ms") and r["latency_ms"]<100) else (50 if r.get("latency_ms") and r["latency_ms"]<300 else 0)),"ts":row_ts})
            # Maintain the hourly rollup for this raw sample so 30/90-day PING
            # history and rollup-lag monitoring stay accurate. Without this the
            # high-volume agent batch path leaves rollups permanently behind.
            try:
                from services.ping_rollups import record_ping_rollup
                record_ping_rollup(server.id, {
                    "key": r.get("key") or r.get("host") or "unknown",
                    "label": r.get("label") or r.get("host") or "",
                    "protocol": r.get("protocol") or "tcp",
                    "stats": {"avg_ms": lat, "loss_pct": r.get("loss_pct")},
                }, row_ts)
            except Exception:
                logger.exception("agent probe rollup write failed", extra={"server_id": server.id})
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
            "tasks": [],
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
        "tasks": [
            {
                **(c.payload or {}),
                "id": c.id,
                "expires_at": c.expires_at.isoformat() if c.expires_at else None,
            }
            for c in commands
        ],
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

_AGENT_RUNTIME_FILES = {
    "vps-agent.py": "vps-agent.py",
    "agent_tasks.py": "agent_tasks.py",
}


def _agent_runtime_dir():
    from pathlib import Path
    configured = current_app.config.get("AGENT_RUNTIME_DIR", "")
    if configured:
        return Path(configured)
    bundled = Path("/app/agent-runtime")
    # Local source/test runs intentionally use the same repository scripts.
    return bundled if bundled.is_dir() else Path(__file__).resolve().parents[2] / "scripts"


@agent_bp.get("/releases/<version>/<name>")
def agent_signed_release_file(version, name):
    """Serve allowlisted bytes from the one configured immutable release only."""
    release = _configured_agent_release(version)
    if not release or not _RELEASE_FILE_RE.fullmatch(name):
        return jsonify(msg="agent release not found"), 404
    path = release / name
    if not path.is_file():
        return jsonify(msg="agent release asset unavailable"), 404
    try:
        content = path.read_bytes()
    except OSError:
        logger.exception("agent release asset unavailable: %s/%s", version, name)
        return jsonify(msg="agent release asset unavailable"), 503
    mime = "application/json" if name == "manifest.json" else "text/plain"
    response = current_app.response_class(content, mimetype=mime)
    response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


def _agent_install_template():
    from pathlib import Path

    return Path(__file__).resolve().parents[1] / "templates" / "agent" / "install.sh"


@agent_bp.get("/install.sh")
def agent_install_script():
    release_version = current_app.config.get("AGENT_RELEASE_VERSION", "")
    # The key is source-pinned; never consume manifest.pub from the same origin.
    try:
        pinned_public_key = _pinned_agent_release_public_key()
    except OSError:
        logger.exception("Agent release trust anchor unavailable")
        pinned_public_key = ""

    try:
        script = _agent_install_template().read_text(encoding="utf-8")
    except OSError:
        logger.exception("Agent install template unavailable")
        return jsonify(msg="agent install template unavailable"), 503

    script = script.replace("__RELEASE_VERSION__", release_version).replace(
        "__PINNED_PUBLIC_KEY__",
        pinned_public_key,
    )
    return current_app.response_class(script, mimetype="text/plain; charset=utf-8")
