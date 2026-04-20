"""
/api/servers  —  服务器 CRUD、指标推送、历史查询
"""
import json
import logging
import secrets
from datetime import datetime, timezone, date, timedelta

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt_identity
from werkzeug.exceptions import HTTPException
from werkzeug.security import generate_password_hash

from extensions import db
import extensions
from models.models import Server, ProbeResult
from utils.errors import ValidationError, InternalServerError
from middleware.rbac import admin_required

servers_bp = Blueprint("servers", __name__)
logger = logging.getLogger(__name__)

_CACHE_KEY_ADMIN  = "vps:servers:admin"   # 全量字段（含 IP、价格等）
_CACHE_KEY_PUBLIC = "vps:servers:public"  # 公开字段
_CACHE_TTL = 30  # seconds

FIELD_MAX_LEN = {
    "name": 128, "ip": 45, "location": 128,
    "flag": 8, "bandwidth": 64, "probe_url": 512,
    "note": 2000, "period": 16, "status": 16, "uptime": 64,
}


# ── 列表 ──────────────────────────────────────────────────────────────────────

@servers_bp.get("/")
@jwt_required(optional=True)
def list_servers():
    """列出所有服务器；未登录时过滤敏感字段"""
    uid = get_jwt_identity()
    is_auth = uid is not None
    cache_key = _CACHE_KEY_ADMIN if is_auth else _CACHE_KEY_PUBLIC

    # 查缓存
    try:
        cached = extensions.redis_client.get(cache_key)
        if cached:
            data = json.loads(cached)
            return jsonify(servers=data, from_cache=True, count=len(data))
    except Exception:
        pass

    servers = Server.query.order_by(Server.group_name, Server.name).all()
    data = [s.to_dict(public_only=not is_auth) for s in servers]

    # 写缓存
    try:
        extensions.redis_client.setex(
            cache_key, _CACHE_TTL,
            json.dumps(data, ensure_ascii=False, default=str),
        )
    except Exception:
        pass

    return jsonify(servers=data, from_cache=False, count=len(data))


# ── 创建 ──────────────────────────────────────────────────────────────────────

@servers_bp.post("/")
@admin_required
def create_server():
    """创建服务器"""
    data = request.get_json(silent=True) or {}

    name = (data.get("name") or "").strip()
    ip   = (data.get("ip")   or "").strip()

    if not name:
        raise ValidationError("缺少必填字段: name", field="name")
    if not ip:
        raise ValidationError("缺少必填字段: ip", field="ip")

    # 长度校验
    for field, max_len in FIELD_MAX_LEN.items():
        if field in data and data[field] is not None:
            if len(str(data[field])) > max_len:
                raise ValidationError(f"{field} 超过最大长度 {max_len} 个字符", field=field)

    price = data.get("price", 0)
    try:
        price = float(price) if price else 0.0
    except (TypeError, ValueError):
        raise ValidationError("价格必须是数字", field="price")
    if price < 0:
        raise ValidationError("价格不能为负数", field="price")

    expiry = None
    if data.get("expiry"):
        try:
            expiry = date.fromisoformat(data["expiry"])
        except (ValueError, TypeError):
            raise ValidationError("到期日格式无效（应为 YYYY-MM-DD）", field="expiry")

    server = Server(
        name=name,
        ip=ip,
        group_name=data.get("group") or data.get("group_name") or "默认分组",
        location=data.get("location", ""),
        flag=data.get("flag", "🌐"),
        cpu_cores=int(data.get("cpu_cores", 1)),
        ram_gb=float(data.get("ram_gb", 1.0)),
        disk_gb=int(data.get("disk_gb", 20)),
        bandwidth=data.get("bandwidth", "不限"),
        probe_url=data.get("probe_url", ""),
        note=data.get("note", ""),
        price=price,
        period=data.get("period", "monthly"),
        expiry=expiry,
        status=data.get("status", "unknown"),
        traffic_limit_gb=data.get("traffic_limit_gb", 0),
        traffic_reset_day=int(data.get("traffic_reset_day", 1)),
    )
    db.session.add(server)
    db.session.commit()

    _clear_cache()
    return jsonify(server.to_dict()), 201


# ── 单个服务器 ────────────────────────────────────────────────────────────────

@servers_bp.get("/<int:sid>")
@jwt_required(optional=True)
def get_server(sid):
    """获取单个服务器；未登录时过滤敏感字段"""
    uid = get_jwt_identity()
    is_auth = uid is not None

    try:
        server = Server.query.get_or_404(sid)
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError(error_detail=str(e))

    return jsonify(server.to_dict(public_only=not is_auth))


@servers_bp.put("/<int:sid>")
@admin_required
def update_server(sid):
    """更新服务器"""
    try:
        server = Server.query.get_or_404(sid)
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError(error_detail=str(e))

    data = request.get_json(silent=True) or {}

    price = data.get("price")
    if price is not None:
        try:
            price = float(price)
        except (TypeError, ValueError):
            raise ValidationError("价格必须是数字", field="price")
        if price < 0:
            raise ValidationError("价格不能为负数", field="price")
        server.price = price

    for field in ["name", "ip", "location", "flag", "bandwidth",
                  "probe_url", "note", "period", "status", "uptime"]:
        if field in data:
            val = data[field]
            max_len = FIELD_MAX_LEN.get(field)
            if max_len and val is not None and len(str(val)) > max_len:
                raise ValidationError(f"{field} 超过最大长度 {max_len} 个字符", field=field)
            setattr(server, field, val)

    if "group" in data:
        server.group_name = data["group"]
    if "group_name" in data:
        server.group_name = data["group_name"]
    if "cpu_cores" in data:
        server.cpu_cores = int(data["cpu_cores"])
    if "ram_gb" in data:
        server.ram_gb = float(data["ram_gb"])
    if "disk_gb" in data:
        server.disk_gb = int(data["disk_gb"])
    if "traffic_limit_gb" in data:
        server.traffic_limit_gb = float(data["traffic_limit_gb"])
    if "traffic_reset_day" in data:
        server.traffic_reset_day = int(data["traffic_reset_day"])

    if "expiry" in data:
        if data["expiry"]:
            try:
                server.expiry = date.fromisoformat(data["expiry"])
            except (ValueError, TypeError):
                raise ValidationError("到期日格式无效", field="expiry")
        else:
            server.expiry = None

    db.session.commit()
    _clear_cache()
    return jsonify(server.to_dict())


@servers_bp.delete("/<int:sid>")
@admin_required
def delete_server(sid):
    """删除服务器"""
    try:
        server = Server.query.get_or_404(sid)
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError(error_detail=str(e))

    db.session.delete(server)
    db.session.commit()
    _clear_cache()
    return jsonify(msg="已删除")


@servers_bp.post("/<int:sid>/agent-key/generate")
@admin_required
def generate_agent_key(sid):
    server = Server.query.get_or_404(sid)
    raw_key = secrets.token_urlsafe(32)
    server.agent_key_hash = generate_password_hash(raw_key)
    server.agent_key_prev_hash = None
    server.agent_key_prev_expires_at = None
    now = datetime.now(timezone.utc)
    server.agent_key_created_at = now
    server.agent_key_last_used = None
    db.session.commit()
    return jsonify({"server_id": sid, "agent_key": raw_key, "created_at": now.isoformat()})


@servers_bp.post("/<int:sid>/agent-key/rotate")
@admin_required
def rotate_agent_key(sid):
    server = Server.query.get_or_404(sid)
    raw_key = secrets.token_urlsafe(32)
    if server.agent_key_hash:
        server.agent_key_prev_hash = server.agent_key_hash
        server.agent_key_prev_expires_at = datetime.now(timezone.utc) + timedelta(minutes=5)
    server.agent_key_hash = generate_password_hash(raw_key)
    server.agent_key_created_at = datetime.now(timezone.utc)
    db.session.commit()
    return jsonify({
        "server_id": sid,
        "agent_key": raw_key,
        "overlap_until": server.agent_key_prev_expires_at.isoformat() if server.agent_key_prev_expires_at else None,
    })


@servers_bp.put("/<int:sid>/agent-config")
@admin_required
def update_agent_config(sid):
    server = Server.query.get_or_404(sid)
    data = request.get_json(silent=True) or {}
    if not isinstance(data, dict):
        raise ValidationError("agent_config 必须是 JSON 对象", field="agent_config")
    server.agent_config = data
    db.session.commit()
    return jsonify({"server_id": sid, "agent_config": server.agent_config})


# ── 指标推送 ──────────────────────────────────────────────────────────────────

@servers_bp.post("/<int:sid>/metrics")
@admin_required
def push_metrics(sid):
    """推送实时指标"""
    try:
        server = Server.query.get_or_404(sid)
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError(error_detail=str(e))

    data = request.get_json(silent=True) or {}

    # 验证 0-100 范围的字段
    for field in ["cpu_use", "ram_use", "disk_use"]:
        val = data.get(field)
        if val is not None:
            try:
                fval = float(val)
            except (TypeError, ValueError):
                raise ValidationError(f"{field} 必须是数字", field=field)
            if not (0.0 <= fval <= 100.0):
                raise ValidationError(f"{field} 必须在 0-100 之间", field=field)

    # 更新字段
    metrics = {}
    for field in ["cpu_use", "ram_use", "disk_use", "net_up", "net_down", "status", "uptime"]:
        if field in data:
            setattr(server, field, data[field])
            metrics[field] = data[field]

    # 精确流量：支持 bytes_out_total / bytes_in_total 差值计算
    bytes_out = data.get("bytes_out_total")
    bytes_in  = data.get("bytes_in_total")
    if bytes_out is not None and bytes_in is not None:
        try:
            bytes_out = int(bytes_out)
            bytes_in  = int(bytes_in)
            prev_out  = server.bytes_out_snapshot or 0
            prev_in   = server.bytes_in_snapshot  or 0
            if prev_out > 0 and bytes_out >= prev_out:
                delta_up_gb = (bytes_out - prev_out) / 1024 / 1024 / 1024
                server.traffic_up_gb   = round((server.traffic_up_gb   or 0) + delta_up_gb, 6)
            if prev_in > 0 and bytes_in >= prev_in:
                delta_dn_gb = (bytes_in - prev_in) / 1024 / 1024 / 1024
                server.traffic_down_gb = round((server.traffic_down_gb or 0) + delta_dn_gb, 6)
            server.traffic_used_gb = server.traffic_up_gb + server.traffic_down_gb
            server.bytes_out_snapshot = bytes_out
            server.bytes_in_snapshot  = bytes_in
        except (TypeError, ValueError):
            pass

    # 写探针历史
    db.session.add(ProbeResult(
        server_id=server.id,
        cpu_use=data.get("cpu_use", server.cpu_use),
        ram_use=data.get("ram_use", server.ram_use),
        disk_use=data.get("disk_use", server.disk_use),
        net_up=data.get("net_up", server.net_up),
        net_down=data.get("net_down", server.net_down),
        status=data.get("status", server.status),
        latency_ms=data.get("latency_ms"),
    ))
    db.session.commit()
    _clear_cache()
    return jsonify(metrics=metrics)


# ── 历史数据 ──────────────────────────────────────────────────────────────────

@servers_bp.get("/<int:sid>/history")
@admin_required
def get_history(sid):
    """获取服务器历史数据"""
    try:
        Server.query.get_or_404(sid)
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError(error_detail=str(e))

    days  = request.args.get("days",  1,   type=int)
    limit = min(request.args.get("limit", 100, type=int), 1000)
    since = datetime.now(timezone.utc) - timedelta(days=days)

    results = (
        ProbeResult.query
        .filter(ProbeResult.server_id == sid, ProbeResult.created_at >= since)
        .order_by(ProbeResult.created_at.desc())
        .limit(limit)
        .all()
    )

    return jsonify(data=[r.to_dict() for r in results])


# ── 辅助 ──────────────────────────────────────────────────────────────────────

def _clear_cache():
    try:
        extensions.redis_client.delete(_CACHE_KEY_ADMIN, _CACHE_KEY_PUBLIC)
    except Exception:
        pass
