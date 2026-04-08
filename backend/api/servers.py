"""
/api/servers  —  服务器 CRUD + 实时指标更新
Redis 缓存键：
  vps:servers:list          →  JSON 列表（TTL 15s）
  vps:server:{id}:metrics   →  单台实时指标（TTL 15s）
"""
import json
from datetime import date
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt
from extensions import db, redis_client
from models.models import Server, ProbeResult

servers_bp = Blueprint("servers", __name__)

# ── 缓存工具 ─────────────────────────────────────────────────────────────────

CACHE_KEY_LIST = "vps:servers:list"

def _invalidate_list_cache():
    try:
        redis_client.delete(CACHE_KEY_LIST)
    except Exception:
        pass


def _metrics_key(server_id):
    return f"vps:server:{server_id}:metrics"


def _get_cached_list():
    try:
        raw = redis_client.get(CACHE_KEY_LIST)
        return json.loads(raw) if raw else None
    except Exception:
        return None


def _set_cached_list(data, ttl=15):
    try:
        redis_client.setex(CACHE_KEY_LIST, ttl, json.dumps(data, ensure_ascii=False))
    except Exception:
        pass


# ── 路由 ─────────────────────────────────────────────────────────────────────

@servers_bp.get("/")
def list_servers():
    """获取所有服务器（含 Redis 缓存的实时指标）"""
    cached = _get_cached_list()
    if cached:
        return jsonify(servers=cached, from_cache=True)

    servers = Server.query.order_by(Server.id).all()
    result  = []
    for s in servers:
        d = s.to_dict()
        # 尝试从 Redis 覆盖实时指标
        try:
            raw = redis_client.get(_metrics_key(s.id))
            if raw:
                d.update(json.loads(raw))
        except Exception:
            pass
        result.append(d)

    _set_cached_list(result)
    return jsonify(servers=result, from_cache=False)


@servers_bp.get("/<int:sid>")
def get_server(sid):
    s = Server.query.get_or_404(sid)
    d = s.to_dict()
    try:
        raw = redis_client.get(_metrics_key(sid))
        if raw:
            d.update(json.loads(raw))
    except Exception:
        pass
    return jsonify(server=d)


@servers_bp.post("/")
@jwt_required()
def create_server():
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    data = request.get_json(silent=True) or {}

    # 基本校验
    if not data.get("name"):
        return jsonify(msg="name 不能为空"), 400

    expiry = None
    if data.get("expiry"):
        try:
            expiry = date.fromisoformat(data["expiry"])
        except ValueError:
            return jsonify(msg="expiry 格式错误，应为 YYYY-MM-DD"), 400

    s = Server(
        name       = data["name"],
        group_name = data.get("group", "默认分组"),
        flag       = data.get("flag", "🌐"),
        location   = data.get("location", ""),
        ip         = data.get("ip", ""),
        cpu_cores  = int(data.get("cpu", 1)),
        ram_gb     = float(data.get("ram", 1)),
        disk_gb    = int(data.get("disk", 20)),
        bandwidth  = data.get("bw", "不限"),
        probe_url  = data.get("probe", ""),
        note       = data.get("note", ""),
        price      = float(data.get("price", 0)),
        period     = data.get("period", "monthly"),
        expiry     = expiry,
        status     = "unknown",
    )
    db.session.add(s)
    db.session.commit()
    _invalidate_list_cache()
    return jsonify(server=s.to_dict()), 201


@servers_bp.put("/<int:sid>")
@jwt_required()
def update_server(sid):
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    s    = Server.query.get_or_404(sid)
    data = request.get_json(silent=True) or {}

    fields = {
        "name": "name", "group": "group_name", "flag": "flag",
        "location": "location", "ip": "ip", "bw": "bandwidth",
        "probe": "probe_url", "note": "note",
        "period": "period",
    }
    for api_key, col in fields.items():
        if api_key in data:
            setattr(s, col, data[api_key])

    if "cpu"   in data: s.cpu_cores = int(data["cpu"])
    if "ram"   in data: s.ram_gb    = float(data["ram"])
    if "disk"  in data: s.disk_gb   = int(data["disk"])
    if "price" in data: s.price     = float(data["price"])
    if "expiry" in data:
        try:
            s.expiry = date.fromisoformat(data["expiry"])
        except (ValueError, TypeError):
            pass

    db.session.commit()
    _invalidate_list_cache()
    return jsonify(server=s.to_dict())


@servers_bp.delete("/<int:sid>")
@jwt_required()
def delete_server(sid):
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    s = Server.query.get_or_404(sid)
    db.session.delete(s)
    db.session.commit()
    _invalidate_list_cache()
    try:
        redis_client.delete(_metrics_key(sid))
    except Exception:
        pass
    return jsonify(msg=f"服务器 {sid} 已删除")


@servers_bp.post("/<int:sid>/metrics")
@jwt_required()
def push_metrics(sid):
    """
    探针服务推送实时指标（写入 Redis + 更新 MySQL + 写 probe_results 历史）
    Body: { cpu_use, ram_use, disk_use, net_up, net_down, status, uptime, latency_ms }
    """
    s    = Server.query.get_or_404(sid)
    data = request.get_json(silent=True) or {}

    metrics = {
        "cpu_use":  round(float(data.get("cpu_use",  s.cpu_use)),  2),
        "ram_use":  round(float(data.get("ram_use",  s.ram_use)),  2),
        "disk_use": round(float(data.get("disk_use", s.disk_use)), 2),
        "net_up":   round(float(data.get("net_up",   s.net_up)),   2),
        "net_down": round(float(data.get("net_down", s.net_down)), 2),
        "status":   data.get("status",  s.status),
        "uptime":   data.get("uptime",  s.uptime),
    }

    # Redis（短 TTL，前端读）
    ttl = current_app.config.get("PROBE_CACHE_TTL", 15)
    try:
        redis_client.setex(_metrics_key(sid), ttl,
                           json.dumps(metrics, ensure_ascii=False))
    except Exception:
        pass

    # MySQL（持久化当前值）
    for k, v in metrics.items():
        setattr(s, k, v)
    db.session.add(ProbeResult(
        server_id  = sid,
        cpu_use    = metrics["cpu_use"],
        ram_use    = metrics["ram_use"],
        disk_use   = metrics["disk_use"],
        net_up     = metrics["net_up"],
        net_down   = metrics["net_down"],
        latency_ms = float(data.get("latency_ms", 0)),
        status     = metrics["status"],
    ))
    db.session.commit()
    _invalidate_list_cache()
    return jsonify(msg="ok", metrics=metrics)


@servers_bp.get("/<int:sid>/history")
@jwt_required()
def get_history(sid):
    """获取最近 N 条探针历史（用于折线图）"""
    limit = min(int(request.args.get("limit", 100)), 1000)
    rows  = (ProbeResult.query
             .filter_by(server_id=sid)
             .order_by(ProbeResult.probed_at.desc())
             .limit(limit).all())
    return jsonify(history=[r.to_dict() for r in reversed(rows)])


@servers_bp.get("/groups")
def list_groups():
    """返回所有分组列表"""
    rows = db.session.query(Server.group_name).distinct().all()
    return jsonify(groups=[r[0] for r in rows])
# backend/api/servers.py 中添加

@servers_bp.get("/<int:sid>/history")
@jwt_required()
def get_server_history(sid):
    """
    获取服务器历史数据
    查询参数：
      - days: 1-30（默认 1）
      - metric: cpu|memory|disk|traffic（默认 cpu）
    """
    days = request.args.get('days', 1, type=int)
    metric = request.args.get('metric', 'cpu', type=str)
    
    server = Server.query.get_or_404(sid)
    
    # 获取过去 N 天的 ProbeResult
    from datetime import datetime, timedelta
    start_date = datetime.utcnow() - timedelta(days=days)
    
    results = ProbeResult.query.filter(
        ProbeResult.server_id == sid,
        ProbeResult.created_at >= start_date
    ).order_by(ProbeResult.created_at).all()
    
    data = [{
        'timestamp': r.created_at.isoformat(),
        'cpu_use': r.cpu_use,
        'ram_use': r.ram_use,
        'disk_use': r.disk_use,
        'net_up': r.net_up,
        'net_down': r.net_down,
    } for r in results]
    
    return jsonify(data=data, count=len(data))
