"""Probe fetching and TCP reachability scheduled jobs."""
import ipaddress
import json
import logging
import shutil
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
log = logging.getLogger(__name__)

# Batch size for chunked DELETE operations (retention cleanup fallback).
# Small enough to avoid long row-lock windows; large enough to finish quickly
# without excessive round-trips.  Each batch is committed independently so
# InnoDB releases its row locks after every _CLEANUP_BATCH rows.
# Partial deletions caused by mid-run errors are intentional: the job is
# idempotent and the next scheduled run will clean up any remaining rows.
_CLEANUP_BATCH = 1_000


_LOCAL_METRICS_PREV = {
    "cpu": None,       # (idle, total)
    "net": None,       # (timestamp, rx_bytes, tx_bytes)
}


def _read_cpu_counters():
    try:
        with open("/proc/stat", "r", encoding="utf-8") as fh:
            parts = fh.readline().split()
        vals = [int(v) for v in parts[1:]]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        return idle, total
    except Exception:
        return None


def _read_mem_percent():
    try:
        data = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                key, rest = line.split(":", 1)
                data[key] = float(rest.strip().split()[0])
        total = data.get("MemTotal") or 0.0
        available = data.get("MemAvailable")
        if not total or available is None:
            return None
        return max(0.0, min(100.0, (total - available) / total * 100.0))
    except Exception:
        return None


def _default_net_interface():
    try:
        with open("/proc/net/route", "r", encoding="utf-8") as fh:
            for line in fh.readlines()[1:]:
                parts = line.split()
                if len(parts) >= 4 and parts[1] == "00000000" and int(parts[3], 16) & 2:
                    return parts[0]
    except Exception:
        pass
    return None


def _read_net_bytes():
    iface = _default_net_interface()
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as fh:
            rows = fh.readlines()[2:]
        totals = []
        for row in rows:
            if ":" not in row:
                continue
            name, rest = row.split(":", 1)
            name = name.strip()
            cols = rest.split()
            if len(cols) < 16 or name == "lo":
                continue
            rx = int(cols[0])
            tx = int(cols[8])
            if iface and name == iface:
                return rx, tx
            if not name.startswith(("veth", "br-", "docker")):
                totals.append((rx, tx))
        if totals:
            return max(totals, key=lambda p: p[0] + p[1])
    except Exception:
        return None
    return None


def _format_uptime():
    try:
        seconds = int(float(open("/proc/uptime", "r", encoding="utf-8").read().split()[0]))
        days, rem = divmod(seconds, 86400)
        hours, rem = divmod(rem, 3600)
        minutes, _ = divmod(rem, 60)
        if days:
            return f"{days} days, {hours} hours, {minutes} minutes"
        if hours:
            return f"{hours} hours, {minutes} minutes"
        return f"{minutes} minutes"
    except Exception:
        return None


def _collect_local_host_metrics():
    """Collect real host/container-visible metrics for the local-master node."""
    metrics = {}

    cpu_now = _read_cpu_counters()
    prev_cpu = _LOCAL_METRICS_PREV.get("cpu")
    if cpu_now and prev_cpu:
        idle_delta = cpu_now[0] - prev_cpu[0]
        total_delta = cpu_now[1] - prev_cpu[1]
        if total_delta > 0:
            metrics["cpu_use"] = round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 2)
    _LOCAL_METRICS_PREV["cpu"] = cpu_now

    mem = _read_mem_percent()
    if mem is not None:
        metrics["ram_use"] = round(mem, 2)

    try:
        usage = shutil.disk_usage("/")
        metrics["disk_use"] = round(usage.used / usage.total * 100.0, 2) if usage.total else None
    except Exception:
        pass

    net_now = _read_net_bytes()
    now = time.time()
    prev_net = _LOCAL_METRICS_PREV.get("net")
    if net_now and prev_net:
        dt = max(now - prev_net[0], 0.001)
        rx_delta = max(net_now[0] - prev_net[1], 0)
        tx_delta = max(net_now[1] - prev_net[2], 0)
        # KB/s; frontend labels and traffic accumulator already interpret net_up/down as KB/s.
        metrics["net_down"] = round(rx_delta / 1024.0 / dt, 2)
        metrics["net_up"] = round(tx_delta / 1024.0 / dt, 2)
    if net_now:
        _LOCAL_METRICS_PREV["net"] = (now, net_now[0], net_now[1])

    uptime = _format_uptime()
    if uptime:
        metrics["uptime"] = uptime
    return {k: v for k, v in metrics.items() if v is not None}


def _is_local_master_server(server):
    provider = str(getattr(server, "provider", "") or "").lower()
    name = str(getattr(server, "name", "") or "").lower()
    return provider == "local-master" or name == "192-vps-agent-01"


def _tcp_ping_one(server_id: int, ip: str, timeout: float) -> dict:
    """对单台服务器执行一次 TCP ping，纯 I/O 操作，不访问数据库。

    IPv6-only nodes must not be marked offline just because the monitor host has
    no IPv6 route. In that case we return ``unknown``: the dashboard cannot
    prove online/offline until an agent/probe URL is installed.
    """
    start      = time.perf_counter()
    status     = "offline"
    latency_ms = None
    err        = None
    try:
        parsed = ipaddress.ip_address(str(ip).strip())
        family = socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
        address = (str(parsed), 80, 0, 0) if family == socket.AF_INET6 else (str(parsed), 80)
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex(address)
        elapsed = (time.perf_counter() - start) * 1000
        sock.close()
        if result == 0:
            status     = "warn" if elapsed > 300 else "online"
            latency_ms = round(elapsed, 2)
        elif family == socket.AF_INET6 and result in {101, 99, 97, 96}:  # no route / cannot assign addr / addr family
            status = "unknown"
            err = "monitor_ipv6_unreachable"
    except OSError as exc:
        if ':' in str(ip):
            status = "unknown"
            err = "monitor_ipv6_unreachable"
        else:
            err = type(exc).__name__
    except Exception as exc:
        err = type(exc).__name__
    return {"server_id": server_id, "status": status, "latency_ms": latency_ms, "error": err}


def _job_tcp_ping(app):
    """TCP ping 所有有 IP 的服务器并更新状态（并发执行）"""
    from extensions import db, redis_client
    from models.models import Server, ProbeResult
    from middleware.metrics_middleware import (vps_servers_total, vps_servers_online,
                                              vps_servers_offline, vps_probe_latency_ms)

    with app.app_context():
        servers = Server.query.filter(Server.ip != "").all()
        if not servers:
            return

        timeout     = float(app.config.get("PROBE_TIMEOUT_S", 5))
        max_workers = int(app.config.get("PROBE_PING_MAX_WORKERS", 10))

        # ── 并发 TCP ping（纯 I/O，不持有 DB session）──────────────────────
        ping_args = [(s.id, s.ip, timeout) for s in servers]
        results   = {}  # server_id -> {status, latency_ms}

        with ThreadPoolExecutor(max_workers=min(len(servers), max_workers)) as pool:
            futures = {
                pool.submit(_tcp_ping_one, sid, ip, to): sid
                for sid, ip, to in ping_args
            }
            for fut in as_completed(futures):
                try:
                    r = fut.result()
                    results[r["server_id"]] = r
                except Exception as exc:
                    sid = futures[fut]
                    log.warning("tcp_ping worker error server_id=%s: %s", sid, exc)
                    results[sid] = {"server_id": sid, "status": "offline", "latency_ms": None}

        # ── 写库（主线程，单一 DB session）────────────────────────────────
        server_map = {s.id: s for s in servers}
        now = datetime.now(timezone.utc)
        agent_fresh_seconds = int(app.config.get("AGENT_STATUS_FRESH_SECONDS") or 180)
        for sid, r in results.items():
            s          = server_map[sid]
            status     = r["status"]
            latency_ms = r["latency_ms"]

            # Agent push is authoritative when fresh. This prevents the central
            # monitor from overwriting IPv6-only agents as offline/unknown when
            # the monitor host has no IPv6 route, while the VPS itself is alive
            # and actively reporting signed metrics.
            last_agent = s.agent_key_last_used
            if last_agent is not None:
                if last_agent.tzinfo is None:
                    last_agent = last_agent.replace(tzinfo=timezone.utc)
                if (now - last_agent).total_seconds() <= agent_fresh_seconds:
                    status = "online"
                    latency_ms = None

            s.status = status
            is_local_master = _is_local_master_server(s)
            telemetry_snapshot = None
            if is_local_master:
                local_metrics = _collect_local_host_metrics()
                for k, v in local_metrics.items():
                    setattr(s, k, v)
                telemetry_snapshot = {
                    "cpu_use": s.cpu_use,
                    "ram_use": s.ram_use,
                    "disk_use": s.disk_use,
                    "net_up": s.net_up,
                    "net_down": s.net_down,
                }

            # IMPORTANT: the TCP/PING scheduler is not a telemetry source for
            # normal agent nodes.  Copying Server.cpu/net fields here creates
            # fake historical flat lines whenever an agent stops changing or
            # only reports through the signed push path.  Persist only
            # status/latency for central probes; real telemetry history is
            # written by ingest_metrics(agent/admin) or fetch_probes.
            db.session.add(ProbeResult(
                server_id=s.id,
                latency_ms=latency_ms,
                status=status,
                **(telemetry_snapshot or {}),
            ))

            # 记录延迟指标
            if latency_ms is not None:
                try:
                    vps_probe_latency_ms.observe(latency_ms)
                except Exception:
                    pass

        # 更新服务器状态指标
        try:
            total  = len(servers)
            online = sum(1 for s in servers if results.get(s.id, {}).get("status") == "online")
            vps_servers_total.set(total)
            vps_servers_online.set(online)
            vps_servers_offline.set(total - online)
        except Exception:
            pass

        try:
            db.session.commit()
            redis_client.delete("vps:servers:admin", "vps:servers:public")
        except Exception as e:
            db.session.rollback()
            log.error(f"tcp_ping 写库失败: {e}")


def _job_fetch_probes(app):
    """抓取有 probe_url 的服务器探针数据（复用共享层 fetch_and_parse_probe）"""
    from extensions import db, redis_client
    from models.models import Server, ProbeResult
    from services.probe_fetcher import fetch_and_parse_probe

    with app.app_context():
        servers = Server.query.filter(Server.probe_url != "").all()
        updated_ids = []

        for s in servers:
            fail_key = f"vps:probe_fail:{s.id}"
            snap = {
                "id": s.id, "name": s.name,
                "cpu_use": s.cpu_use or 0.0, "ram_use": s.ram_use or 0.0,
                "disk_use": s.disk_use or 0.0, "net_up": s.net_up or 0.0,
                "net_down": s.net_down or 0.0, "status": s.status,
                "uptime": s.uptime,
            }
            try:
                metrics, err = fetch_and_parse_probe(
                    s.probe_url, snap,
                    timeout=app.config.get("PROBE_FETCH_TIMEOUT_S", 8),
                )
            except Exception as e:
                # Safety net: fetch_and_parse_probe returns (None, err) for all
                # expected errors; this catches only unexpected exceptions (e.g.,
                # bugs inside probe_fetcher itself).
                err = str(e)
                metrics = None

            if err is not None:
                log.warning(f"探针抓取失败 server_id={s.id}: {err}")
                try:
                    fail_count = redis_client.incr(fail_key)
                    redis_client.expire(fail_key, 300)  # 5分钟窗口
                    if fail_count >= 3 and s.status != "offline":
                        s.status = "offline"
                        log.warning(f"服务器 {s.id}({s.name}) 连续 {fail_count} 次探针失败，标记 offline")
                except Exception:
                    pass
                continue

            for k, v in metrics.items():
                setattr(s, k, v)

            db.session.add(ProbeResult(server_id=s.id, **{
                k: metrics.get(k) for k in
                ["cpu_use", "ram_use", "disk_use", "net_up", "net_down", "process_count", "status"]
            }, latency_ms=None))

            try:
                redis_client.setex(
                    f"vps:server:{s.id}:metrics",
                    app.config.get("PROBE_CACHE_TTL", 15),
                    json.dumps(metrics, ensure_ascii=False),
                )
                # 成功：清除失败计数
                redis_client.delete(fail_key)
            except Exception:
                pass

            updated_ids.append(str(s.id))

        try:
            db.session.commit()
            if updated_ids:
                redis_client.delete("vps:servers:admin", "vps:servers:public")
        except Exception as e:
            db.session.rollback()
            log.error(f"fetch_probes 写库失败: {e}")
