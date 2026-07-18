"""
/api/probe  —  TCP Ping / IPv4 信息查询 / 批量探针触发
"""
import socket
import ipaddress
import time
from datetime import datetime, timezone, timedelta
import json
import os
import re
import subprocess
from urllib.parse import urlparse
import requests
from urllib.parse import urlencode
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Blueprint, request, jsonify, current_app
from extensions import db
import extensions
from models.models import Server, ProbeResult
from middleware.rbac import admin_required
from middleware.rate_limit import limiter, PING_LIMIT
from utils.validators import validate_port, validate_ip_or_hostname
from services.probe_fetcher import fetch_and_parse_probe, _parse_probe_payload_dict

probe_bp = Blueprint("probe", __name__)


IP_GEO_CACHE_VERSION = "v4"

def _is_public_ipv4(value):
    try:
        ip_obj = ipaddress.ip_address(str(value or "").strip())
        return ip_obj.version == 4 and not (ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_reserved or ip_obj.is_multicast)
    except Exception:
        return False


def _client_public_ip():
    candidate = (request.remote_addr or "").strip()
    return candidate if _is_public_ipv4(candidate) else ""


def _fetch_json_url(url, timeout=5):
    try:
        resp = requests.get(url, timeout=timeout, headers={"Accept": "application/json", "User-Agent": "vps-dashboard-ipgeo/1.0"})
        if resp.status_code >= 400:
            return None
        return resp.json()
    except Exception:
        return None


def _normalize_ipwho(raw):
    if not isinstance(raw, dict) or raw.get("success") is False:
        return None
    conn = raw.get("connection") if isinstance(raw.get("connection"), dict) else {}
    tz = raw.get("timezone")
    return {
        "status": "success",
        "country": raw.get("country") or "",
        "countryCode": raw.get("country_code") or "",
        "regionName": raw.get("region") or "",
        "city": raw.get("city") or "",
        "lat": raw.get("latitude"),
        "lon": raw.get("longitude"),
        "isp": conn.get("isp") or "",
        "org": conn.get("org") or "",
        "as": str(conn.get("asn") or ""),
        "query": raw.get("ip") or "",
        "timezone": tz.get("id") if isinstance(tz, dict) else tz,
        "source": "ipwho.is",
    }


def _valid_geo(data):
    try:
        if not isinstance(data, dict) or data.get("status") not in (None, "success"):
            return False
        lat = float(data.get("lat"))
        lon = float(data.get("lon"))
        return -90 <= lat <= 90 and -180 <= lon <= 180
    except Exception:
        return False


def lookup_ip_geo(ip=""):
    target = (ip or _client_public_ip()).strip()
    if target and not _is_public_ipv4(target):
        raise ValueError("仅支持合法公网 IPv4 地址")

    suffix = target or ""
    ip_api = _fetch_json_url(
        f"http://ip-api.com/json/{suffix}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,query,timezone&lang=zh-CN",
        timeout=5,
    )
    who = _normalize_ipwho(_fetch_json_url(f"https://ipwho.is/{suffix}?lang=zh-CN", timeout=5))

    candidates = [d for d in (ip_api, who) if _valid_geo(d)]
    if candidates:
        chosen = candidates[0]
        if len(candidates) > 1:
            a, b = candidates[0], candidates[1]
            ac = str(a.get("countryCode") or "").upper()
            bc = str(b.get("countryCode") or "").upper()
            if ac != bc and ac == "US" and bc and bc != "US":
                chosen = b
            elif ac != bc and bc == "US" and ac and ac != "US":
                chosen = a
        sources = []
        for name, data in (("ip-api", ip_api), ("ipwho.is", who)):
            if _valid_geo(data):
                sources.append({"source": name, "countryCode": data.get("countryCode"), "country": data.get("country"), "city": data.get("city"), "lat": data.get("lat"), "lon": data.get("lon")})
        out = dict(chosen)
        out["source"] = chosen.get("source") or ("ip-api" if chosen is ip_api else "ipwho.is")
        out["geo_sources"] = sources
        if len(sources) > 1 and str(sources[0].get("countryCode") or "").upper() != str(sources[1].get("countryCode") or "").upper():
            out["geo_conflict"] = True
        return out

    # Controlled degradation: never leak upstream unavailability to the public UI.
    # Return a safe anonymous placeholder so the visitor beacon can still render
    # a non-identifying state instead of disappearing.
    return {
        "status": "success",
        "valid": False,
        "query": target,
        "country": "—",
        "countryCode": "ZZ",
        "regionName": "—",
        "city": "—",
        "lat": 0,
        "lon": 0,
        "timezone": None,
        "isp": None,
        "org": None,
        "as": None,
        "source": "fallback:anonymous",
        "degraded": True,
    }

DEFAULT_PING_TARGET_PRESETS = [
    {"key": "hk", "label": "香港 CMI", "host": "43.155.88.12", "port": 443, "protocol": "tcp"},
    {"key": "jp", "label": "日本东京 SoftBank", "host": "27.0.234.55", "port": 443, "protocol": "tcp"},
    {"key": "de", "label": "德国法兰克福", "host": "95.216.12.88", "port": 443, "protocol": "tcp"},
    {"key": "sg", "label": "新加坡", "host": "172.104.55.99", "port": 443, "protocol": "tcp"},
    {"key": "us", "label": "美国纽约 OVH", "host": "51.81.22.44", "port": 443, "protocol": "tcp"},
]

PING_TARGETS_CACHE_TTL = 15
_ping_targets_memory_cache = {}


def _cache_get_json(key):
    try:
        client = getattr(extensions, "redis_client", None)
        if client:
            raw = client.get(key)
            if raw:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                return json.loads(raw)
    except Exception:
        pass
    item = _ping_targets_memory_cache.get(key)
    if item and item.get("expires", 0) > time.time():
        return item.get("value")
    return None


def _cache_set_json(key, value, ttl=PING_TARGETS_CACHE_TTL):
    try:
        client = getattr(extensions, "redis_client", None)
        if client:
            client.setex(key, int(ttl), json.dumps(value, ensure_ascii=False))
            return
    except Exception:
        pass
    _ping_targets_memory_cache[key] = {"expires": time.time() + ttl, "value": value}


def clear_ping_targets_cache(sid):
    prefix = f"vps:public:ping-targets:{sid}:"
    for key in list(_ping_targets_memory_cache.keys()):
        if str(key).startswith(prefix):
            _ping_targets_memory_cache.pop(key, None)
    try:
        client = getattr(extensions, "redis_client", None)
        if client:
            for key in client.scan_iter(f"{prefix}*"):
                client.delete(key)
    except Exception:
        pass



def _is_private_or_loopback_host(host: str) -> bool:
    try:
        import ipaddress
        ip = ipaddress.ip_address(str(host).strip().strip('[]'))
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast
    except Exception:
        return False


def _peer_probe_endpoint(peer: Server):
    cfg = peer.agent_config if isinstance(peer.agent_config, dict) else {}
    network = cfg.get("network") if isinstance(cfg.get("network"), dict) else {}
    nat = cfg.get("nat") if isinstance(cfg.get("nat"), dict) else {}
    mapped = cfg.get("mapped_ports") if isinstance(cfg.get("mapped_ports"), dict) else {}
    host = str(nat.get("public_ipv4") or network.get("public_ipv4") or cfg.get("public_ipv4") or "").strip()
    port = nat.get("public_port") or nat.get("mapped_port") or mapped.get("https") or mapped.get("tcp") or cfg.get("public_port") or 80
    if host and not _is_private_or_loopback_host(host):
        try: port = int(port)
        except Exception: port = 80
        return host, port, "tcp", "public_ipv4"
    ipv6 = str(network.get("public_ipv6") or nat.get("public_ipv6") or cfg.get("public_ipv6") or "").strip()
    if ipv6 and not _is_private_or_loopback_host(ipv6):
        return ipv6, int(nat.get("port") or mapped.get("https") or mapped.get("tcp") or cfg.get("probe_port") or 22), "tcp", "public_ipv6"
    host = str(getattr(peer, "ip", "") or "").strip()
    if host and not _is_private_or_loopback_host(host):
        return host, 80, "tcp", "server_ip"
    return None
def _server_peer_ping_targets(server: Server):
    """Default global probe targets: current VPS -> other VPS nodes in this dashboard."""
    try:
        peers = Server.query.filter(Server.id != server.id).order_by(Server.id.asc()).all()
    except Exception:
        return [], False
    out = []
    for peer in peers:
        endpoint = _peer_probe_endpoint(peer)
        if not endpoint:
            continue
        host, port, protocol, source = endpoint
        label_parts = [str(getattr(peer, "name", "") or "").strip(), str(getattr(peer, "location", "") or "").strip()]
        label = " · ".join([p for p in label_parts if p]) or host
        out.append({
            "key": f"vps-{peer.id}",
            "label": label,
            "host": host,
            "port": port,
            "protocol": protocol,
            "peer_server_id": peer.id,
            "source": source,
            "type": "peer",
        })
    # has peer nodes means the semantic source is VPS-to-VPS, even if every peer is NAT-only/unreachable.
    return out, bool(peers)


def _ping_targets_are_peer_targets(server: Server, targets=None):
    """True when targets describe VPS-to-VPS peer probes.

    These must come from the source node/agent.  The API container is only the
    controller and must not synthesize directional latency by probing from the
    controller host; that produced false near-zero samples for controller-local
    peers.
    """
    targets = targets if targets is not None else _resolve_ping_targets_for_server(server)
    return bool(targets) and all(str(t.get("key", "")).startswith("vps-") or t.get("peer_server_id") for t in targets)


def _agent_side_unavailable_payload(server_id, targets, hours=None):
    sanitized = []
    for t in targets or []:
        sanitized.append({
            "key": t.get("key"),
            "label": t.get("label") or t.get("key") or "peer",
            "port": t.get("port"),
            "protocol": t.get("protocol") or "tcp",
            "results": [],
            "stats": {"avg_ms": None, "count": 0, "success": 0, "loss_pct": None, "port": t.get("port"), "protocol": t.get("protocol") or "tcp"},
            "quality": None,
            "source": "agent-side-unavailable",
            "points": [],
        })
    payload = {
        "server_id": server_id,
        "targets": sanitized,
        "derived_from": "agent-side peer probe unavailable",
        "probe_source": "agent",
        "unavailable": True,
        "message": "暂无真实节点侧互探采样",
    }
    if hours is not None:
        payload["hours"] = hours
    return payload


def _resolve_ping_targets_for_server(server: Server):
    """Resolve user-facing latency monitor targets only.

    Detail-page PING charts/tables must show only targets configured in the
    admin latency monitor (agent_config.ping_targets), or global defaults when
    no per-node config exists. Added VPS/peer nodes are reserved for
    source=agent peer probing and must not be mixed into the public PING view.
    """
    cfg = (server.agent_config or {}) if getattr(server, "agent_config", None) else {}
    targets = cfg.get("ping_targets")
    if isinstance(targets, list):
        if not targets:
            return []
        cleaned = []
        for idx, item in enumerate(targets):
            if not isinstance(item, dict):
                continue
            host = str(item.get("host", "")).strip()
            label = str(item.get("label", host or f"target-{idx+1}")).strip()
            key = str(item.get("key", f"target-{idx+1}")).strip()
            try:
                port = int(item.get("port", 443))
            except Exception:
                port = 443
            if host:
                cleaned.append({"key": key, "label": label, "host": host, "port": port, "protocol": _normalize_probe_protocol(item.get("protocol")), "type": "external"})
        return cleaned
    return [{**dt, "type": "external"} for dt in _load_ping_targets()]

def _load_ping_targets():
    """Load global external latency targets.

    Empty/missing config intentionally means no targets.  Older builds used
    DEFAULT_PING_TARGET_PRESETS here, which made fresh installs display PING
    data even when the admin had never configured latency monitoring.
    """
    raw = os.getenv("PING_TARGETS_JSON", "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            return []
        legacy_default_hosts = {str(t.get("host")) for t in DEFAULT_PING_TARGET_PRESETS}
        incoming_hosts = {str(t.get("host")) for t in data if isinstance(t, dict)}
        if incoming_hosts == legacy_default_hosts:
            return []
        cleaned = []
        for idx, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            host = str(item.get("host", "")).strip()
            label = str(item.get("label", host or f"target-{idx+1}")).strip()
            key = str(item.get("key", f"target-{idx+1}")).strip()
            try:
                port = int(item.get("port", 443))
            except Exception:
                port = 443
            if not host:
                continue
            cleaned.append({"key": key, "label": label, "host": host, "port": port, "protocol": _normalize_probe_protocol(item.get("protocol")), "type": "external"})
        return cleaned
    except Exception:
        return []



# ── TCP Ping ─────────────────────────────────────────────────────────────────

def tcp_ping(host: str, port: int, timeout: float = 5.0) -> dict:
    """
    单次 TCP 连接测试。
    返回 { success, latency_ms, error }
    """
    start = time.perf_counter()
    try:
        target = str(host or "").strip().strip("[]")
        if ":" in target:
            helper = os.getenv("HOST_PROBE_HELPER_URL", "http://172.18.0.1:9117/tcp").strip()
            if helper:
                try:
                    url = helper + "?" + urlencode({"host": target, "port": int(port), "timeout": float(timeout)})
                    resp = requests.get(url, timeout=timeout + 1)
                    if resp.ok:
                        data = resp.json()
                        return {
                            "success": bool(data.get("success")),
                            "latency_ms": data.get("latency_ms"),
                            "error": data.get("error"),
                        }
                    return {"success": False, "latency_ms": None, "error": f"helper HTTP {resp.status_code}"}
                except Exception as helper_exc:
                    return {"success": False, "latency_ms": None, "error": f"helper: {helper_exc}"}
        family = socket.AF_INET6 if ":" in target else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((target, port))
        elapsed = (time.perf_counter() - start) * 1000
        sock.close()
        if result == 0:
            return {"success": True, "latency_ms": round(elapsed, 2), "error": None}
        else:
            return {"success": False, "latency_ms": None, "error": f"errno {result}"}
    except socket.timeout:
        return {"success": False, "latency_ms": None, "error": "timeout"}
    except Exception as e:
        return {"success": False, "latency_ms": None, "error": str(e)}


def _normalize_probe_protocol(value) -> str:
    proto = str(value or "tcp").strip().lower()
    if proto == "lcmp":
        proto = "icmp"
    return proto if proto in {"tcp", "icmp", "http"} else "tcp"


def _http_probe_url(host: str, port: int | None = None) -> str:
    raw = (host or "").strip()
    if raw.startswith(("http://", "https://")):
        return raw
    if port and port not in (80, 443):
        return f"http://{raw}:{int(port)}"
    return f"http://{raw}"


def _is_public_probe_hostname(hostname: str) -> bool:
    """Reject loopback/private/link-local/reserved targets for anonymous probes."""
    name = (hostname or "").strip().strip("[]")
    if not name:
        return False
    lowered = name.lower().rstrip(".")
    # Block cloud metadata endpoints (SSRF prevention)
    if name in {"169.254.169.254", "metadata.google.internal"}:
        return False
    if lowered in {"localhost", "localhost.localdomain"}:
        return False
    try:
        infos = socket.getaddrinfo(name, None)
    except Exception:
        return False
    for info in infos:
        sockaddr = info[4] or ()
        ip_raw = sockaddr[0] if sockaddr else ""
        try:
            ip_obj = ipaddress.ip_address(ip_raw)
        except ValueError:
            return False
        if (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_multicast
            or ip_obj.is_reserved
            or ip_obj.is_unspecified
        ):
            return False
    return True


def _validate_probe_target(protocol: str, host: str) -> bool:
    if protocol == "http":
        parsed = urlparse(_http_probe_url(host))
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return False
        return validate_ip_or_hostname(parsed.hostname) and _is_public_probe_hostname(parsed.hostname)
    return validate_ip_or_hostname(host) and _is_public_probe_hostname(host)


def icmp_ping(host: str, timeout: float = 5.0) -> dict:
    start = time.perf_counter()
    try:
        proc = subprocess.run(
            ["ping", "-c", "1", "-W", str(max(1, int(timeout))), host],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout + 1,
        )
        out = (proc.stdout or "") + "\n" + (proc.stderr or "")
        if proc.returncode == 0:
            m = re.search(r"time[=<]([0-9.]+)\s*ms", out)
            latency = float(m.group(1)) if m else (time.perf_counter() - start) * 1000
            return {"success": True, "latency_ms": round(latency, 2), "error": None}
        return {"success": False, "latency_ms": None, "error": (out.strip().splitlines()[-1] if out.strip() else f"exit {proc.returncode}")[:160]}
    except FileNotFoundError:
        return {"success": False, "latency_ms": None, "error": "ping command unavailable"}
    except subprocess.TimeoutExpired:
        return {"success": False, "latency_ms": None, "error": "timeout"}
    except Exception as e:
        return {"success": False, "latency_ms": None, "error": str(e)}


def http_ping(host: str, port: int | None = None, timeout: float = 5.0) -> dict:
    url = _http_probe_url(host, port)
    start = time.perf_counter()
    try:
        resp = requests.get(url, timeout=timeout, allow_redirects=False, headers={"User-Agent": "vps-dashboard-probe/1.0"})
        elapsed = (time.perf_counter() - start) * 1000
        ok = 100 <= int(resp.status_code) < 500
        return {"success": ok, "latency_ms": round(elapsed, 2) if ok else None, "error": None if ok else f"HTTP {resp.status_code}", "status_code": resp.status_code, "url": url}
    except requests.exceptions.Timeout:
        return {"success": False, "latency_ms": None, "error": "timeout", "url": url}
    except Exception as e:
        return {"success": False, "latency_ms": None, "error": str(e), "url": url}


def run_probe_once(protocol: str, host: str, port: int, timeout: float = 5.0) -> dict:
    protocol = _normalize_probe_protocol(protocol)
    if protocol == "icmp":
        r = icmp_ping(host, timeout)
    elif protocol == "http":
        r = http_ping(host, port, timeout)
    else:
        r = tcp_ping(host, port, timeout)
    r["protocol"] = protocol
    return r


def _probe_stats(protocol: str, host: str, port: int, count: int, timeout: float, max_workers: int = 5):
    protocol = _normalize_probe_protocol(protocol)
    def _probe_once(seq):
        r = run_probe_once(protocol, host, port, timeout)
        r["seq"] = seq + 1
        return r
    results = []
    with ThreadPoolExecutor(max_workers=min(count, max_workers)) as pool:
        futures = {pool.submit(_probe_once, i): i for i in range(count)}
        for fut in as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as e:
                results.append({"seq": futures[fut] + 1, "success": False, "error": type(e).__name__, "protocol": protocol})
    results.sort(key=lambda r: r["seq"])
    latencies = [r["latency_ms"] for r in results if r.get("success") and r.get("latency_ms") is not None]
    stats = {
        "host": host, "port": port, "protocol": protocol, "count": count,
        "success": len(latencies),
        "loss_pct": round((count - len(latencies)) / count * 100, 1),
        "avg_ms": round(sum(latencies) / len(latencies), 2) if latencies else None,
        "min_ms": round(min(latencies), 2) if latencies else None,
        "max_ms": round(max(latencies), 2) if latencies else None,
    }
    return results, stats




def _tcp_ping_stats(host: str, port: int, count: int, timeout: float, protocol: str = "tcp"):
    return _probe_stats(protocol, host, port, count, timeout, max_workers=5)


def _target_history_table_ready():
    try:
        db.session.execute(db.text("""
            CREATE TABLE IF NOT EXISTS ping_target_results (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                server_id INT NOT NULL,
                target_key VARCHAR(128) NOT NULL,
                label VARCHAR(255) NOT NULL DEFAULT '',
                host VARCHAR(255) NOT NULL DEFAULT '',
                port INT NULL,
                protocol VARCHAR(16) NOT NULL DEFAULT 'icmp',
                latency_ms DOUBLE NULL,
                success TINYINT(1) NOT NULL DEFAULT 0,
                loss_pct DOUBLE NULL,
                quality INT NULL,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_ptr_server_created (server_id, created_at),
                INDEX idx_ptr_server_target_created (server_id, target_key, created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """))
        db.session.commit()
        return True
    except Exception:
        db.session.rollback()
        return False


def _persist_ping_target_results(server_id, targets, created_at=None):
    if not targets or not _target_history_table_ready():
        return
    created_at = created_at or datetime.now(timezone.utc)
    try:
        for t in targets:
            stats = t.get("stats") or {}
            avg_ms = stats.get("avg_ms")
            success = avg_ms is not None
            db.session.execute(db.text("""
                INSERT INTO ping_target_results
                  (server_id, target_key, label, host, port, protocol, latency_ms, success, loss_pct, quality, created_at)
                VALUES
                  (:server_id, :target_key, :label, :host, :port, :protocol, :latency_ms, :success, :loss_pct, :quality, :created_at)
            """), {
                "server_id": server_id,
                "target_key": str(t.get("key") or t.get("host") or t.get("label") or "unknown")[:128],
                "label": str(t.get("label") or t.get("host") or "")[:255],
                "host": str(t.get("host") or "")[:255],
                "port": t.get("port"),
                "protocol": str(t.get("protocol") or "icmp")[:16],
                "latency_ms": float(avg_ms) if avg_ms is not None else None,
                "success": 1 if success else 0,
                "loss_pct": stats.get("loss_pct"),
                "quality": t.get("quality"),
                "created_at": created_at.replace(tzinfo=None) if hasattr(created_at, "replace") else created_at,
            })
        db.session.commit()
    except Exception:
        db.session.rollback()


def _fetch_ping_target_history(server_id, hours=12, limit=2000):
    if not _target_history_table_ready():
        return []
    hours = max(1, min(int(hours or 12), 168))
    limit = max(1, min(int(limit or 2000), 10000))
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    rows = db.session.execute(db.text("""
        SELECT server_id, target_key, label, host, port, protocol, latency_ms, success, loss_pct, quality, created_at
        FROM ping_target_results
        WHERE server_id = :server_id AND created_at >= :since
        ORDER BY created_at ASC
        LIMIT :limit
    """), {"server_id": server_id, "since": since.replace(tzinfo=None), "limit": limit}).mappings().all()
    return [dict(r) for r in rows]



def _backend_fallback_probe_peer_targets(server_id, targets):
    if not targets:
        return False
    results = []
    for t in targets:
        host = t.get("host") or t.get("label")
        port = t.get("port") or 22
        if not host:
            continue
        try:
            import socket, time
            start = time.time()
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(3)
            result = sock.connect_ex((str(host), int(port)))
            elapsed = (time.time() - start) * 1000
            sock.close()
            if result == 0:
                t["stats"] = {"avg_ms": round(elapsed, 1), "loss_pct": 0, "count": 1}
                t["quality"] = "good" if elapsed < 100 else ("fair" if elapsed < 300 else "poor")
                t["source"] = "backend-fallback"
                results.append(t)
            else:
                t["stats"] = {"avg_ms": None, "loss_pct": 100, "count": 0}
                t["quality"] = "dead"
                t["source"] = "backend-fallback"
                results.append(t)
        except Exception as e:
            t["stats"] = {"avg_ms": None, "loss_pct": 100, "count": 0, "error": str(e)[:200]}
            t["quality"] = "dead"
            t["source"] = "backend-fallback"
            results.append(t)
    if results:
        _persist_ping_target_results(server_id, results)
    return bool(results)
@probe_bp.get("/public/ping-targets/<int:sid>/history")
def public_ping_targets_history(sid):
    server = Server.query.get(sid)
    hours = max(1, min(int(request.args.get("hours", 12)), 168))
    limit = max(1, min(int(request.args.get("limit", 2000)), 10000))
    if not server:
        resp = jsonify({"server_id": sid, "hours": hours, "targets": [], "derived_from": "server not found", "configured": False, "not_configured": True})
        resp.headers["Cache-Control"] = "no-store"
        return resp

    configured = _resolve_ping_targets_for_server(server)
    if _ping_targets_are_peer_targets(server, configured):
        # Peer latency history must come from agent reports only; never synthesize
        # controller/API-side fallback samples.
        stored_rows = _fetch_ping_target_history(sid, hours, limit)
        if not stored_rows:
            payload = _agent_side_unavailable_payload(sid, configured, hours=hours)
            resp = jsonify(payload)
            resp.headers["Cache-Control"] = "no-store"
            return resp
    rows = _fetch_ping_target_history(sid, hours, limit)
    targets_meta = {}
    for i, t in enumerate(configured):
        primary = str(t.get("key") or t.get("host") or t.get("label") or f"target-{i}")
        targets_meta[primary] = t
        # Backward/agent compatibility: stored rows may use host or label as target_key
        # while the current admin-configured latency targets use short keys (hk/jp/sg).
        for alias in (t.get("host"), t.get("label")):
            if alias:
                targets_meta.setdefault(str(alias), t)
    if not configured:
        payload = {"server_id": sid, "hours": hours, "targets": [], "derived_from": "not configured", "configured": False, "not_configured": True}
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = "no-store"
        return resp
    grouped = {}
    for r in rows:
        key = str(r.get("target_key") or "unknown")
        if key not in targets_meta:
            continue
        meta_candidate = targets_meta.get(key, {})
        if meta_candidate.get("type") == "peer" or key.startswith("vps-"):
            continue
        meta = targets_meta.get(key, {})
        item = grouped.setdefault(key, {
            "key": key,
            "label": r.get("label") or meta.get("label") or key,
            "port": r.get("port") or meta.get("port"),
            "protocol": r.get("protocol") or meta.get("protocol") or "icmp",
            "points": [],
        })
        if r.get("success") and r.get("latency_ms") is not None:
            ca = r.get("created_at")
            point_protocol = r.get("protocol") or meta.get("protocol") or "icmp"
            item["points"].append({
                "x": ca.isoformat() if hasattr(ca, "isoformat") else str(ca),
                "latency_ms": float(r.get("latency_ms")),
                "success": True,
                "loss_pct": r.get("loss_pct"),
                "quality": r.get("quality"),
                "protocol": point_protocol,
                "key": key,
                "label": r.get("label") or meta.get("label") or key,
            })
    for i, meta in enumerate(configured):
        key = str(meta.get("key") or meta.get("host") or meta.get("label") or f"target-{i}")
        grouped.setdefault(key, {"key": key, "label": meta.get("label") or key, "port": meta.get("port"), "protocol": meta.get("protocol") or "icmp", "points": []})
    payload = {"server_id": sid, "hours": hours, "targets": list(grouped.values()), "derived_from": "persisted ping_target_results"}
    resp = jsonify(payload)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@probe_bp.get("/public/ping-targets/<int:sid>")
def public_ping_targets(sid):
    server = Server.query.get(sid)
    count = min(max(int(request.args.get("count", 1)), 1), 4)
    timeout = min(float(current_app.config.get("PROBE_TIMEOUT_S", 5)), 5.0)
    source = str(request.args.get("source") or "public").strip().lower()
    if not server:
        payload = {"server_id": sid, "targets": [], "derived_from": "server not found", "configured": False, "not_configured": True, "cache_ttl": PING_TARGETS_CACHE_TTL}
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Ping-Targets-Cache"] = "bypass"
        return resp
    cache_key = f"vps:public:ping-targets:{sid}:{count}:{source}"
    cached = _cache_get_json(cache_key)
    if cached:
        resp = jsonify(cached)
        resp.headers["Cache-Control"] = f"public, max-age={PING_TARGETS_CACHE_TTL}"
        resp.headers["X-Ping-Targets-Cache"] = "hit"
        return resp

    # Agent collectors ask for VPS peer targets explicitly. Keep this separate
    # from the public/detail-page PING view so added VPS nodes never appear as
    # user-facing latency monitor targets. Do NOT probe here from the controller:
    # values must be real agent-side peer samples, otherwise the global latency
    # table shows fake API-container-to-peer latency.
    if source == "agent":
        peer_only, _ = _server_peer_ping_targets(server)
        rows = _fetch_ping_target_history(sid, 12, 500)
        latest_by_key = {}
        for r in rows:
            key = str(r.get("target_key") or "")
            if not key.startswith("vps-"):
                continue
            latest_by_key[key] = r
        targets = []
        has_real_sample = False
        for item in peer_only:
            key = str(item.get("key") or "")
            sample = latest_by_key.get(key)
            out = dict(item)
            if sample:
                latency = sample.get("latency_ms")
                success = bool(sample.get("success")) and latency is not None
                loss = sample.get("loss_pct")
                out["stats"] = {
                    "avg_ms": float(latency) if success else None,
                    "loss_pct": float(loss) if loss is not None else (0 if success else 100),
                    "count": 1,
                    "protocol": sample.get("protocol") or item.get("protocol") or "tcp",
                }
                out["results"] = [{
                    "success": success,
                    "latency_ms": float(latency) if success else None,
                    "loss_pct": out["stats"]["loss_pct"],
                    "protocol": out["stats"]["protocol"],
                }]
                avg_ms = out["stats"].get("avg_ms")
                out["quality"] = 0 if avg_ms is None else max(0, min(100, round(100 - avg_ms / 4)))
                out["sample_source"] = "agent-reported"
                has_real_sample = True
            else:
                out["stats"] = {"avg_ms": None, "loss_pct": None, "count": 0, "protocol": item.get("protocol") or "tcp"}
                out["results"] = []
                out["quality"] = None
                out["sample_source"] = "missing"
            targets.append(out)
        payload = {
            "server_id": sid,
            "targets": targets,
            "derived_from": "agent-reported peer results",
            "probe_source": "agent",
            "unavailable": (len(peer_only) > 0 and not has_real_sample),
            "cache_ttl": PING_TARGETS_CACHE_TTL,
        }
        _cache_set_json(cache_key, payload, PING_TARGETS_CACHE_TTL)
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = f"public, max-age={PING_TARGETS_CACHE_TTL}"
        resp.headers["X-Ping-Targets-Cache"] = "miss"
        return resp

    # Public/detail-page PING = admin-configured latency monitor targets only
    # (agent_config.ping_targets or global default presets). No VPS peers.
    resolved_targets = [t for t in _resolve_ping_targets_for_server(server) if t.get("type") != "peer" and not str(t.get("key", "")).startswith("vps-")]
    if not resolved_targets:
        payload = {"server_id": sid, "targets": [], "derived_from": "not configured", "configured": False, "not_configured": True, "cache_ttl": PING_TARGETS_CACHE_TTL}
        _cache_set_json(cache_key, payload, PING_TARGETS_CACHE_TTL)
        resp = jsonify(payload)
        resp.headers["Cache-Control"] = f"public, max-age={PING_TARGETS_CACHE_TTL}"
        resp.headers["X-Ping-Targets-Cache"] = "miss"
        return resp

    targets = []
    for item in resolved_targets:
        results, stats = _tcp_ping_stats(item["host"], item.get("port", 443), count, timeout, item.get("protocol", "tcp"))
        stats = {k: v for k, v in (stats or {}).items() if k not in ("host",)}
        avg_ms = stats.get("avg_ms")
        quality = 0 if avg_ms is None else max(0, min(100, round(100 - avg_ms / 4)))
        targets.append({
            "key": item["key"],
            "label": item["label"],
            "host": item.get("host", ""),
            "port": item.get("port", 443),
            "protocol": item.get("protocol", "tcp"),
            "results": results,
            "stats": stats,
            "quality": quality,
            "type": "external",
        })

    targets.sort(key=lambda t: (t["stats"].get("avg_ms") is None, t["stats"].get("avg_ms") or 1e9))
    payload = {"server_id": sid, "targets": targets, "derived_from": "configured latency monitor targets", "cache_ttl": PING_TARGETS_CACHE_TTL}
    _persist_ping_target_results(sid, targets)
    _cache_set_json(cache_key, payload, PING_TARGETS_CACHE_TTL)
    resp = jsonify(payload)
    resp.headers["Cache-Control"] = f"public, max-age={PING_TARGETS_CACHE_TTL}"
    resp.headers["X-Ping-Targets-Cache"] = "miss"
    return resp


@probe_bp.post("/public/ping")
@limiter.limit(PING_LIMIT)
def public_ping():
    """Public TCP / ICMP / HTTP probe for display page."""
    data = request.get_json(silent=True) or {}
    host = (data.get("host") or "").strip()
    protocol = _normalize_probe_protocol(data.get("protocol", "tcp"))
    port_raw = data.get("port", 80 if protocol == "http" else 443)
    count = min(max(int(data.get("count", 3)), 1), 5)
    timeout = min(float(current_app.config.get("PROBE_TIMEOUT_S", 5)), 5.0)

    if not host:
        return jsonify(msg="host 不能为空"), 400
    if protocol == "http":
        return jsonify(msg="公开探测已禁用 HTTP 协议；请使用 TCP/ICMP"), 400
    if not _validate_probe_target(protocol, host):
        return jsonify(msg="host/url 格式不合法"), 400

    if protocol == "icmp":
        port = 0
    else:
        try:
            port = int(port_raw)
        except (TypeError, ValueError):
            return jsonify(msg="port 必须是数字"), 400
        if not validate_port(port):
            return jsonify(msg="port 必须在 1-65535"), 400

    results, stats = _probe_stats(protocol, host, port, count, timeout, max_workers=5)
    return jsonify(results=results, stats=stats)


@probe_bp.post("/ping")
@admin_required
def ping():
    """
    Body: { host, port, count, protocol }
    返回每次 TCP / ICMP / HTTP 探测结果列表 + 统计（并发执行）
    """
    data    = request.get_json(silent=True) or {}
    host    = data.get("host", "").strip()
    protocol = _normalize_probe_protocol(data.get("protocol", "tcp"))
    port_raw = data.get("port", 80 if protocol == "http" else 443)
    count   = min(int(data.get("count", 5)), 20)
    timeout = float(current_app.config.get("PROBE_TIMEOUT_S", 5))

    if not host:
        return jsonify(msg="host 不能为空"), 400
    if not _validate_probe_target(protocol, host):
        return jsonify(msg="host/url 格式不合法"), 400

    if protocol == "icmp":
        port = 0
    else:
        try:
            port = int(port_raw)
        except (TypeError, ValueError):
            return jsonify(msg="port 必须是数字"), 400
        if not validate_port(port):
            return jsonify(msg="port 必须在 1-65535"), 400

    max_workers = current_app.config.get("PROBE_PING_MAX_WORKERS", 20)
    results, stats = _probe_stats(protocol, host, port, count, timeout, max_workers=max_workers)
    return jsonify(results=results, stats=stats)


def _enforce_batch_safety(server_ids, redis_key_prefix: str):
    """批量探针硬限制：最大批次 + 最小触发间隔。"""
    max_batch = int(current_app.config.get("PROBE_BATCH_MAX_ITEMS", 50))
    min_interval = float(current_app.config.get("PROBE_BATCH_MIN_INTERVAL_S", 3))

    if server_ids and len(server_ids) > max_batch:
        return jsonify(
            error_code="BATCH_TOO_LARGE",
            message=f"单次最多允许 {max_batch} 台服务器",
            max_batch=max_batch,
        ), 400

    try:
        key = f"{redis_key_prefix}:{request.remote_addr or 'unknown'}"
        last_raw = extensions.redis_client.get(key)
        now = time.time()
        if last_raw:
            elapsed = now - float(last_raw)
            if elapsed < min_interval:
                retry_after = max(1, int(min_interval - elapsed + 0.999))
                return jsonify(
                    success=False,
                    error_code="BATCH_RATE_LIMITED",
                    message=f"批量任务触发过快，请至少间隔 {min_interval:.1f}s",
                    retry_after=retry_after,
                ), 429
        extensions.redis_client.setex(key, max(1, int(min_interval * 3)), f"{now:.3f}")
    except Exception:
        # Redis 故障时不阻断主流程，仅降级为无间隔保护
        pass

    return None


@probe_bp.post("/ping/batch")
@admin_required
@limiter.limit(lambda: current_app.config.get("PROBE_BATCH_RATE_LIMIT", "6 per minute"))
def ping_batch():
    """
    批量 ping 所有 servers 的 IP（80 端口）
    Body: { server_ids?: [1,2,3] }  — 不传则全部
    """
    data       = request.get_json(silent=True) or {}
    server_ids = data.get("server_ids")
    timeout    = float(current_app.config.get("PROBE_TIMEOUT_S", 5))

    blocked = _enforce_batch_safety(server_ids, "vps:probe:batch:ping")
    if blocked:
        return blocked

    query = Server.query
    if server_ids:
        query = query.filter(Server.id.in_(server_ids))
    servers = query.all()

    # ── 并发 TCP ping 阶段（纯 I/O，不写共享状态）─────────────────────────────
    pingable   = [(s.id, s.ip) for s in servers if s.ip]
    no_ip_ids  = [s.id for s in servers if not s.ip]

    max_workers = int(current_app.config.get("PROBE_PING_MAX_WORKERS", 10))
    ping_results: dict = {}  # server_id -> result dict

    if pingable:
        with ThreadPoolExecutor(max_workers=min(len(pingable), max_workers)) as pool:
            futures = {
                pool.submit(tcp_ping, ip, 80, timeout): sid
                for sid, ip in pingable
            }
            for fut in as_completed(futures):
                sid = futures[fut]
                try:
                    ping_results[sid] = fut.result()
                except Exception as e:
                    ping_results[sid] = {
                        "success": False, "latency_ms": None, "error": type(e).__name__
                    }

    # ── 主线程：整理结果 + DB 更新（安全，不涉及共享状态）────────────────────
    results: dict = {}
    for sid in no_ip_ids:
        results[str(sid)] = {"error": "no IP configured"}

    servers_by_id = {s.id: s for s in servers}
    for sid, r in ping_results.items():
        results[str(sid)] = r
        s = servers_by_id[sid]
        s.status = "online" if r["success"] else "offline"
        if r.get("latency_ms") and r["latency_ms"] > 300:
            s.status = "warn"
        db.session.add(ProbeResult(
            server_id  = s.id,
            latency_ms = r.get("latency_ms"),
            status     = s.status,
            cpu_use    = s.cpu_use, ram_use=s.ram_use,
            disk_use   = s.disk_use, net_up=s.net_up, net_down=s.net_down,
        ))

    db.session.commit()

    # 清 Redis 缓存
    try:
        extensions.redis_client.delete("vps:servers:admin", "vps:servers:public")
    except Exception:
        pass

    return jsonify(results=results)


# ── AFFMAN 探针数据抓取 ───────────────────────────────────────────────────────

@probe_bp.post("/fetch-probe")
@admin_required
@limiter.limit(lambda: current_app.config.get("PROBE_FETCH_RATE_LIMIT", "6 per minute"))
def fetch_probe():
    """
    从 server.probe_url 抓取 AFFMAN / 哪吒探针 JSON 数据并更新 metrics。
    支持的探针格式：
      - 哪吒探针 v0 API: { servers: [{ id, cpu, mem_used, mem_total, ... }] }
      - 自定义 JSON:      { cpu_use, ram_use, disk_use, net_up, net_down, status }
    ---
    tags:
      - Webhook
      - Probe
    summary: 主动抓取探针数据
    description: 后端主动轮询探针 URL；常用于运维侧 webhook/采集任务触发。
    security:
      - Bearer: []
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: false
        schema:
          type: object
          properties:
            server_ids:
              type: array
              items:
                type: integer
              example: [1, 2, 3]
        examples:
          application/json:
            server_ids: [1, 2, 3]
    responses:
      200:
        description: 返回 updated 与 errors 列表
        schema:
          type: object
          properties:
            updated:
              type: array
              items:
                type: string
              example: ["1", "2"]
            errors:
              type: array
              items:
                type: object
                properties:
                  server_id:
                    type: string
                    example: "3"
                  error:
                    type: string
                    example: timed out
      403:
        description: 权限不足（仅管理员可调用）
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 权限不足
    """
    data       = request.get_json(silent=True) or {}
    server_ids = data.get("server_ids")

    blocked = _enforce_batch_safety(server_ids, "vps:probe:batch:fetch")
    if blocked:
        return blocked

    query = Server.query.filter(Server.probe_url != "")
    if server_ids:
        query = query.filter(Server.id.in_(server_ids))
    servers = query.all()

    timeout    = float(current_app.config.get("PROBE_FETCH_TIMEOUT_S", 8))
    max_workers = int(current_app.config.get("PROBE_FETCH_MAX_WORKERS", 10))

    # Pre-extract data snapshots before spawning threads to keep ORM out of workers
    server_snapshots = {
        s.id: {
            "id": s.id, "name": s.name, "probe_url": s.probe_url,
            "cpu_use": s.cpu_use or 0.0, "ram_use": s.ram_use or 0.0,
            "disk_use": s.disk_use or 0.0, "net_up": s.net_up or 0.0,
            "net_down": s.net_down or 0.0, "status": s.status,
            "uptime": s.uptime,
        }
        for s in servers
    }

    # ── 并发 HTTP 抓取阶段（纯 I/O，不写共享状态）────────────────────────────
    def _fetch_one(snap: dict):
        """Worker: 委托共享层执行 HTTP 抓取与解析，不访问 DB / Flask 上下文。"""
        metrics, err = fetch_and_parse_probe(snap["probe_url"], snap, timeout=timeout)
        return snap["id"], metrics, err

    fetch_results: dict = {}   # server_id -> (metrics | None, error | None)

    if server_snapshots:
        with ThreadPoolExecutor(
            max_workers=min(len(server_snapshots), max_workers)
        ) as pool:
            futures = {
                pool.submit(_fetch_one, snap): sid
                for sid, snap in server_snapshots.items()
            }
            for fut in as_completed(futures):
                sid = futures[fut]
                try:
                    _, metrics, err = fut.result()
                    fetch_results[sid] = (metrics, err)
                except Exception as exc:
                    fetch_results[sid] = (None, "probe fetch failed")

    # ── 主线程：整理结果 + DB 更新（安全，不涉及并发写共享状态）─────────────
    updated = []
    errors  = []
    servers_by_id   = {s.id: s for s in servers}
    probe_cache_ttl = current_app.config.get("PROBE_CACHE_TTL", 15)

    for sid, (metrics, err) in fetch_results.items():
        if err is not None:
            current_app.logger.warning(f"探针抓取失败 server_id={sid}: {err}")
            errors.append({"server_id": str(sid), "error": err})
            continue

        s = servers_by_id[sid]
        for k, v in metrics.items():
            setattr(s, k, v)

        db.session.add(ProbeResult(server_id=s.id, **{
            k: metrics.get(k) for k in
            ["cpu_use", "ram_use", "disk_use", "net_up", "net_down", "status"]
        }, latency_ms=None))

        try:
            extensions.redis_client.setex(
                f"vps:server:{s.id}:metrics",
                probe_cache_ttl,
                json.dumps(metrics, ensure_ascii=False),
            )
        except Exception:
            pass

        updated.append(str(s.id))

    db.session.commit()
    try:
        extensions.redis_client.delete("vps:servers:admin", "vps:servers:public")
    except Exception:
        pass

    return jsonify(updated=updated, errors=errors)


def _parse_probe_payload(payload: dict, server: Server) -> dict:
    """将探针 JSON 映射为统一指标字典（接受 ORM 对象，委托共享层处理）。"""
    snap = {
        "id": server.id, "name": server.name,
        "cpu_use": server.cpu_use or 0.0, "ram_use": server.ram_use or 0.0,
        "disk_use": server.disk_use or 0.0, "net_up": server.net_up or 0.0,
        "net_down": server.net_down or 0.0, "status": server.status,
        "uptime": server.uptime,
    }
    return _parse_probe_payload_dict(payload, snap)


# ── IPv4 信息查询 ─────────────────────────────────────────────────────────────

@probe_bp.get("/ip-info")
@limiter.limit(lambda: current_app.config.get("IP_INFO_RATE_LIMIT", "60 per minute"))
def ip_info():
    """
    查询 IP 地理信息（调用 ip-api.com，缓存 1h）
    ?ip=1.2.3.4  留空 = 查询客户端出口 IP
    """
    ip      = request.args.get("ip", "").strip()
    cache_k = f"vps:ipinfo:{IP_GEO_CACHE_VERSION}:{ip or _client_public_ip() or 'self'}"

    if ip and not _is_public_ipv4(ip):
        return jsonify(error="仅支持合法公网 IPv4 地址"), 400

    try:
        cached = extensions.redis_client.get(cache_k)
        if cached:
            resp = jsonify(json.loads(cached))
            resp.headers["X-Cache"] = "HIT"
            resp.headers["Cache-Control"] = f"public, max-age={int(current_app.config.get('IP_INFO_CACHE_TTL', 3600))}"
            return resp
    except Exception:
        pass

    try:
        data = lookup_ip_geo(ip)
        try:
            ttl = int(current_app.config.get("IP_INFO_CACHE_TTL", 3600))
            extensions.redis_client.setex(cache_k, ttl, json.dumps(data, ensure_ascii=False))
        except Exception:
            pass
        resp = jsonify(data)
        resp.headers["X-Cache"] = "MISS"
        resp.headers["Cache-Control"] = f"public, max-age={int(current_app.config.get('IP_INFO_CACHE_TTL', 3600))}"
        return resp
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except Exception:
        return jsonify(error_code="UPSTREAM_UNREACHABLE", message="上游 IP 服务不可用"), 502
