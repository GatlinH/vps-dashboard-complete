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
from models.models import Server, ProbeResult, AgentCommand
from utils.errors import ValidationError, InternalServerError
from middleware.rbac import admin_required, viewer_or_admin_required
from utils.validators import validate_server_name, validate_server_ip
from services.metrics_ingest import ingest_metrics

servers_bp = Blueprint("servers", __name__)
logger = logging.getLogger(__name__)

_CACHE_KEY_ADMIN  = "vps:servers:admin"   # 全量字段（含 IP、价格等）
_CACHE_KEY_PUBLIC = "vps:servers:public"  # 公开字段
_CACHE_TTL = 30  # seconds
# Batch size for the ProbeResult cleanup loop inside delete_server.
# Small enough to avoid long row-lock windows; large enough to finish quickly.
_PROBE_DELETE_BATCH = 1_000

FIELD_MAX_LEN = {
    "name": 128, "ip": 45, "location": 128,
    "flag": 8, "bandwidth": 64, "probe_url": 512,
    "note": 2000, "period": 16, "status": 16, "uptime": 64,
}


def _parse_history_pagination():
    days = request.args.get("days", 1, type=int)
    limit = request.args.get("limit", 100, type=int)
    offset = request.args.get("offset", 0, type=int)
    if days is None or days <= 0 or days > 365:
        raise ValidationError("days 取值范围为 1-365", field="days")
    if limit is None or limit <= 0 or limit > 1000:
        raise ValidationError("limit 取值范围为 1-1000", field="limit")
    if offset is None or offset < 0:
        raise ValidationError("offset 不能为负数", field="offset")
    return days, limit, offset


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
    if not validate_server_name(name):
        raise ValidationError("name 格式无效（2-64 字符，支持中英文/数字/._- 空格）", field="name")
    if not validate_server_ip(ip):
        raise ValidationError("ip 格式无效（仅支持 IP 或主机名，且不能包含 URL）", field="ip")

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

    try:
        cpu_cores = int(data.get("cpu_cores", 1))
        ram_gb = float(data.get("ram_gb", 1.0))
        disk_gb = int(data.get("disk_gb", 20))
        traffic_reset_day = int(data.get("traffic_reset_day", 1))
    except (TypeError, ValueError):
        raise ValidationError("CPU/内存/磁盘/流量重置日参数格式错误")
    if cpu_cores <= 0 or cpu_cores > 1024:
        raise ValidationError("cpu_cores 取值范围为 1-1024", field="cpu_cores")
    if ram_gb <= 0 or ram_gb > 16384:
        raise ValidationError("ram_gb 取值范围为 0-16384", field="ram_gb")
    if disk_gb <= 0 or disk_gb > 1048576:
        raise ValidationError("disk_gb 取值范围为 1-1048576", field="disk_gb")
    if traffic_reset_day < 1 or traffic_reset_day > 31:
        raise ValidationError("traffic_reset_day 取值范围为 1-31", field="traffic_reset_day")

    server = Server(
        name=name,
        ip=ip,
        group_name=data.get("group") or data.get("group_name") or "默认分组",
        location=data.get("location", ""),
        flag=data.get("flag", "🌐"),
        cpu_cores=cpu_cores,
        ram_gb=ram_gb,
        disk_gb=disk_gb,
        bandwidth=data.get("bandwidth", "不限"),
        probe_url=data.get("probe_url", ""),
        note=data.get("note", ""),
        price=price,
        period=data.get("period", "monthly"),
        expiry=expiry,
        status=data.get("status", "unknown"),
        traffic_limit_gb=data.get("traffic_limit_gb", 0),
        traffic_reset_day=traffic_reset_day,
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
    if "name" in data and data["name"] is not None and not validate_server_name(str(data["name"])):
        raise ValidationError("name 格式无效（2-64 字符，支持中英文/数字/._- 空格）", field="name")
    if "ip" in data and data["ip"] is not None and not validate_server_ip(str(data["ip"])):
        raise ValidationError("ip 格式无效（仅支持 IP 或主机名，且不能包含 URL）", field="ip")

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
        cpu = int(data["cpu_cores"])
        if cpu <= 0 or cpu > 1024:
            raise ValidationError("cpu_cores 取值范围为 1-1024", field="cpu_cores")
        server.cpu_cores = cpu
    if "ram_gb" in data:
        ram = float(data["ram_gb"])
        if ram <= 0 or ram > 16384:
            raise ValidationError("ram_gb 取值范围为 0-16384", field="ram_gb")
        server.ram_gb = ram
    if "disk_gb" in data:
        disk = int(data["disk_gb"])
        if disk <= 0 or disk > 1048576:
            raise ValidationError("disk_gb 取值范围为 1-1048576", field="disk_gb")
        server.disk_gb = disk
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

    # MySQL partitioned tables have no FK cascade; explicitly delete probe results
    # for this server.  Use batched DELETEs to avoid a single large row-lock
    # window (and slow partition-scan) on tables with many historical rows.
    deleted_batch = _PROBE_DELETE_BATCH
    while deleted_batch == _PROBE_DELETE_BATCH:
        # Subquery-based LIMIT works on both SQLite and MySQL.
        id_q = (
            db.session.query(ProbeResult.id)
            .filter(ProbeResult.server_id == sid)
            .limit(_PROBE_DELETE_BATCH)
        )
        deleted_batch = (
            ProbeResult.query
            .filter(ProbeResult.id.in_(id_q))
            .delete(synchronize_session=False)
        )
        db.session.flush()
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


@servers_bp.get("/<int:sid>/agent-overview")
@admin_required
def get_agent_overview(sid):
    """获取 Agent 绑定、密钥与配置概览（不返回明文 key）"""
    server = Server.query.get_or_404(sid)
    pending_count = (
        AgentCommand.query
        .filter(AgentCommand.server_id == sid, AgentCommand.status == "pending")
        .count()
    )
    return jsonify({
        "server_id": sid,
        "uuid": server.uuid,
        "agent_key_created_at": server.agent_key_created_at.isoformat() if server.agent_key_created_at else None,
        "agent_key_last_used": server.agent_key_last_used.isoformat() if server.agent_key_last_used else None,
        "agent_key_prev_expires_at": server.agent_key_prev_expires_at.isoformat() if server.agent_key_prev_expires_at else None,
        "agent_config": server.agent_config or {},
        "pending_commands": pending_count,
    })


@servers_bp.post("/<int:sid>/agent-commands")
@admin_required
def enqueue_agent_command(sid):
    """向指定服务器下发 Agent 命令，供 /agent/poll 拉取"""
    server = Server.query.get_or_404(sid)
    data = request.get_json(silent=True) or {}
    command_type = (data.get("command_type") or "").strip()
    if not command_type:
        raise ValidationError("command_type 必填", field="command_type")
    if len(command_type) > 32:
        raise ValidationError("command_type 不能超过 32 个字符", field="command_type")

    payload = data.get("payload", {})
    if payload is None:
        payload = {}
    if not isinstance(payload, dict):
        raise ValidationError("payload 必须是 JSON 对象", field="payload")

    ttl_seconds = data.get("ttl_seconds")
    expires_at = None
    if ttl_seconds is not None:
        try:
            ttl_seconds = int(ttl_seconds)
        except (TypeError, ValueError):
            raise ValidationError("ttl_seconds 必须是整数", field="ttl_seconds")
        if ttl_seconds <= 0 or ttl_seconds > 86400:
            raise ValidationError("ttl_seconds 取值范围为 1-86400", field="ttl_seconds")
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)

    cmd = AgentCommand(
        server_id=server.id,
        command_type=command_type,
        payload=payload,
        status="pending",
        expires_at=expires_at,
    )
    db.session.add(cmd)
    db.session.commit()
    return jsonify({"ok": True, "server_id": server.id, "command": cmd.to_dict()}), 201


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

    # 校验、写库、ProbeResult 均由共享入口处理（strict=True 在字段非法时抛 ValidationError）
    metrics = ingest_metrics(server, data, strict=True, source="admin")
    db.session.commit()
    _clear_cache()
    return jsonify(metrics=metrics)


# ── 历史数据 ──────────────────────────────────────────────────────────────────

@servers_bp.get("/<int:sid>/history")
@viewer_or_admin_required
def get_history(sid):
    """获取服务器历史数据"""
    try:
        Server.query.get_or_404(sid)
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError(error_detail=str(e))

    days, limit, offset = _parse_history_pagination()
    export = (request.args.get("export", "") or "").strip().lower()
    since = datetime.now(timezone.utc) - timedelta(days=days)

    base_query = (
        ProbeResult.query
        .filter(ProbeResult.server_id == sid, ProbeResult.created_at >= since)
        .order_by(ProbeResult.created_at.desc())
    )
    total = base_query.count()
    results = (
        base_query
        .offset(offset)
        .limit(limit)
        .all()
    )

    rows = [r.to_dict() for r in results]
    if export == "csv":
        import csv
        from io import StringIO
        csv_buffer = StringIO()
        writer = csv.DictWriter(csv_buffer, fieldnames=[
            "id", "server_id", "cpu_use", "ram_use", "disk_use",
            "net_up", "net_down", "status", "latency_ms", "created_at"
        ])
        writer.writeheader()
        for row in rows:
            writer.writerow({key: row.get(key) for key in writer.fieldnames})
        return (
            csv_buffer.getvalue(),
            200,
            {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": f'attachment; filename="server-{sid}-history.csv"',
            },
        )

    return jsonify(data=rows, total=total, days=days, limit=limit, offset=offset)


# ── 辅助 ──────────────────────────────────────────────────────────────────────

def _clear_cache():
    try:
        extensions.redis_client.delete(_CACHE_KEY_ADMIN, _CACHE_KEY_PUBLIC)
    except Exception:
        pass
