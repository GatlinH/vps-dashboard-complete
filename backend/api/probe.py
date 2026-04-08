"""
/api/probe  —  TCP Ping / IPv4 信息查询 / 批量探针触发
"""
import socket
import time
import json
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required
from extensions import db, redis_client
from models.models import Server, ProbeResult

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
@jwt_required()
def ping():
    """
    Body: { host, port, count }
    返回每次 TCP ping 结果列表 + 统计
    """
    data    = request.get_json(silent=True) or {}
    host    = data.get("host", "").strip()
    port    = int(data.get("port", 80))
    count   = min(int(data.get("count", 5)), 20)
    timeout = float(current_app.config.get("PROBE_TIMEOUT_S", 5))

    if not host:
        return jsonify(msg="host 不能为空"), 400

    results = []
    for i in range(count):
        r = tcp_ping(host, port, timeout)
        r["seq"] = i + 1
        results.append(r)
        time.sleep(0.1)   # 避免请求过于密集

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


@probe_bp.post("/ping/batch")
@jwt_required()
def ping_batch():
    """
    批量 ping 所有 servers 的 IP（80 端口）
    Body: { server_ids?: [1,2,3] }  — 不传则全部
    """
    data       = request.get_json(silent=True) or {}
    server_ids = data.get("server_ids")
    timeout    = float(current_app.config.get("PROBE_TIMEOUT_S", 5))

    query = Server.query
    if server_ids:
        query = query.filter(Server.id.in_(server_ids))
    servers = query.all()

    results = {}
    for s in servers:
        if not s.ip:
            results[s.id] = {"error": "no IP configured"}
            continue
        r = tcp_ping(s.ip, 80, timeout)
        results[s.id] = r

        # 更新 server status
        old_status = s.status
        s.status = "online" if r["success"] else "offline"
        if r.get("latency_ms") and r["latency_ms"] > 300:
            s.status = "warn"

        # 写探针历史
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
        redis_client.delete("vps:servers:list")
    except Exception:
        pass

    return jsonify(results=results)


# ── AFFMAN 探针数据抓取 ───────────────────────────────────────────────────────

@probe_bp.post("/fetch-probe")
@jwt_required()
def fetch_probe():
    """
    从 server.probe_url 抓取 AFFMAN / 哪吒探针 JSON 数据并更新 metrics。
    支持的探针格式：
      - 哪吒探针 v0 API: { servers: [{ id, cpu, mem_used, mem_total, ... }] }
      - 自定义 JSON:      { cpu_use, ram_use, disk_use, net_up, net_down, status }
    """
    data       = request.get_json(silent=True) or {}
    server_ids = data.get("server_ids")

    query = Server.query.filter(Server.probe_url != "")
    if server_ids:
        query = query.filter(Server.id.in_(server_ids))
    servers = query.all()

    updated = []
    errors  = []

    for s in servers:
        try:
            import urllib.request, urllib.error
            req = urllib.request.Request(
                s.probe_url,
                headers={"User-Agent": "VPS-Dashboard/1.0"},
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=8) as resp:
                payload = json.loads(resp.read().decode())

            # 哪吒探针格式解析
            metrics = _parse_probe_payload(payload, s)
            for k, v in metrics.items():
                setattr(s, k, v)

            db.session.add(ProbeResult(server_id=s.id, **{
                k: metrics.get(k) for k in
                ["cpu_use","ram_use","disk_use","net_up","net_down","status"]
            }, latency_ms=None))

            # 写 Redis
            try:
                redis_client.setex(
                    f"vps:server:{s.id}:metrics",
                    current_app.config.get("PROBE_CACHE_TTL", 15),
                    json.dumps(metrics, ensure_ascii=False),
                )
            except Exception:
                pass

            updated.append(s.id)
        except Exception as e:
            errors.append({"server_id": s.id, "error": str(e)})

    db.session.commit()
    try:
        redis_client.delete("vps:servers:list")
    except Exception:
        pass

    return jsonify(updated=updated, errors=errors)


def _parse_probe_payload(payload: dict, server: Server) -> dict:
    """将探针 JSON 映射为统一指标字典"""
    # 哪吒探针 v0 格式
    if "servers" in payload:
        for item in payload["servers"]:
            if str(item.get("id")) == str(server.id) or item.get("name") == server.name:
                cpu  = item.get("cpu", 0)
                mem  = item.get("mem_used", 0) / max(item.get("mem_total", 1), 1) * 100
                disk = item.get("disk_used", 0) / max(item.get("disk_total", 1), 1) * 100
                return {
                    "cpu_use":  round(cpu,  2),
                    "ram_use":  round(mem,  2),
                    "disk_use": round(disk, 2),
                    "net_up":   round(item.get("net_out_speed", 0) / 1024 / 1024, 2),
                    "net_down": round(item.get("net_in_speed",  0) / 1024 / 1024, 2),
                    "status":   "online",
                    "uptime":   str(item.get("uptime", "")),
                }

    # 通用自定义格式
    return {
        "cpu_use":  round(float(payload.get("cpu_use",  server.cpu_use)),  2),
        "ram_use":  round(float(payload.get("ram_use",  server.ram_use)),  2),
        "disk_use": round(float(payload.get("disk_use", server.disk_use)), 2),
        "net_up":   round(float(payload.get("net_up",   server.net_up)),   2),
        "net_down": round(float(payload.get("net_down", server.net_down)), 2),
        "status":   payload.get("status", server.status),
        "uptime":   payload.get("uptime", server.uptime),
    }


# ── IPv4 信息查询 ─────────────────────────────────────────────────────────────

@probe_bp.get("/ip-info")
def ip_info():
    """
    查询 IP 地理信息（调用 ip-api.com，缓存 1h）
    ?ip=1.2.3.4  留空 = 查询客户端出口 IP
    """
    ip      = request.args.get("ip", "").strip()
    cache_k = f"vps:ipinfo:{ip or 'self'}"

    try:
        cached = redis_client.get(cache_k)
        if cached:
            return jsonify(json.loads(cached))
    except Exception:
        pass

    url = f"http://ip-api.com/json/{ip}?fields=status,message,country,regionName,city,lat,lon,isp,org,as,query&lang=zh-CN"
    try:
        import urllib.request
        with urllib.request.urlopen(url, timeout=6) as resp:
            data = json.loads(resp.read().decode())
        try:
            redis_client.setex(cache_k, 3600, json.dumps(data, ensure_ascii=False))
        except Exception:
            pass
        return jsonify(data)
    except Exception as e:
        return jsonify(error=str(e)), 502
