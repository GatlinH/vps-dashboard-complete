"""
/api/probe  —  TCP Ping / IPv4 信息查询 / 批量探针触发
"""
import socket
import time
import json
from concurrent.futures import ThreadPoolExecutor, as_completed
from flask import Blueprint, request, jsonify, current_app
from extensions import db
import extensions
from models.models import Server, ProbeResult
from middleware.rbac import admin_required
from middleware.rate_limit import limiter
from utils.validators import validate_port, validate_ip_or_hostname
from services.probe_fetcher import fetch_and_parse_probe, _parse_probe_payload_dict

probe_bp = Blueprint("probe", __name__)


# ── TCP Ping ─────────────────────────────────────────────────────────────────

def tcp_ping(host: str, port: int, timeout: float = 5.0) -> dict:
    """
    单次 TCP 连接测试。
    返回 { success, latency_ms, error }
    """
    start = time.perf_counter()
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((host, port))
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


@probe_bp.post("/ping")
@admin_required
def ping():
    """
    Body: { host, port, count }
    返回每次 TCP ping 结果列表 + 统计（并发执行）
    """
    data    = request.get_json(silent=True) or {}
    host    = data.get("host", "").strip()
    port_raw = data.get("port", 80)
    count   = min(int(data.get("count", 5)), 20)
    timeout = float(current_app.config.get("PROBE_TIMEOUT_S", 5))

    if not host:
        return jsonify(msg="host 不能为空"), 400
    if not validate_ip_or_hostname(host):
        return jsonify(msg="host 格式不合法"), 400

    try:
        port = int(port_raw)
    except (TypeError, ValueError):
        return jsonify(msg="port 必须是数字"), 400
    if not validate_port(port):
        return jsonify(msg="port 必须在 1-65535"), 400

    def _ping_once(seq):
        r = tcp_ping(host, port, timeout)
        r["seq"] = seq + 1
        return r

    results = []
    max_workers = current_app.config.get("PROBE_PING_MAX_WORKERS", 20)
    with ThreadPoolExecutor(max_workers=min(count, max_workers)) as pool:
        futures = {pool.submit(_ping_once, i): i for i in range(count)}
        for fut in as_completed(futures):
            try:
                results.append(fut.result())
            except Exception as e:
                # Limit error message to avoid exposing internal details
                err_msg = type(e).__name__
                results.append({"seq": futures[fut] + 1, "success": False, "error": err_msg})

    results.sort(key=lambda r: r["seq"])

    latencies = [r["latency_ms"] for r in results if r["success"]]
    stats = {
        "host": host, "port": port, "count": count,
        "success": len(latencies),
        "loss_pct": round((count - len(latencies)) / count * 100, 1),
        "avg_ms":   round(sum(latencies) / len(latencies), 2) if latencies else None,
        "min_ms":   round(min(latencies), 2) if latencies else None,
        "max_ms":   round(max(latencies), 2) if latencies else None,
    }
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
    cache_k = f"vps:ipinfo:{ip or 'self'}"

    if ip:
        try:
            socket.inet_pton(socket.AF_INET, ip)
        except OSError:
            return jsonify(error="仅支持合法 IPv4 地址"), 400

    try:
        cached = extensions.redis_client.get(cache_k)
        if cached:
            resp = jsonify(json.loads(cached))
            resp.headers["X-Cache"] = "HIT"
            resp.headers["Cache-Control"] = f"public, max-age={int(current_app.config.get('IP_INFO_CACHE_TTL', 3600))}"
            return resp
    except Exception:
        pass

    url = f"http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,lat,lon,isp,org,as,query&lang=zh-CN"
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=6) as resp:
            data = json.loads(resp.read().decode())
        try:
            ttl = int(current_app.config.get("IP_INFO_CACHE_TTL", 3600))
            extensions.redis_client.setex(cache_k, ttl, json.dumps(data, ensure_ascii=False))
        except Exception:
            pass
        resp = jsonify(data)
        resp.headers["X-Cache"] = "MISS"
        resp.headers["Cache-Control"] = f"public, max-age={int(current_app.config.get('IP_INFO_CACHE_TTL', 3600))}"
        return resp
    except Exception:
        return jsonify(error_code="UPSTREAM_UNREACHABLE", message="上游 IP 服务不可用"), 502
