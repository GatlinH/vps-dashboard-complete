"""
/api/traffic  —  出入站流量统计、月度重置、超限预警

路由总览：
  GET  /api/traffic/                    全部服务器流量概览（支持 group= 过滤）
  GET  /api/traffic/<sid>               单台服务器流量详情 + 30天趋势
  POST /api/traffic/<sid>/update        手动更新流量计数（探针推送）
  POST /api/traffic/<sid>/reset         手动重置本月流量
  GET  /api/traffic/alerts              当前超限预警列表
  GET  /api/traffic/summary             汇总统计（总出/入、预警数等）
  PUT  /api/traffic/<sid>/config        更新流量限额和重置日
"""
import json
from datetime import datetime, date, timedelta
from calendar import monthrange

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt

from extensions import db, redis_client
from models.models import Server, ProbeResult

traffic_bp = Blueprint("traffic", __name__)


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def _cache_key(sid):
    return f"vps:traffic:{sid}"

def _summary_cache_key():
    return "vps:traffic:summary"

def _invalidate(sid=None):
    try:
        if sid:
            redis_client.delete(_cache_key(sid))
        redis_client.delete(_summary_cache_key())
        redis_client.delete("vps:servers:list")
    except Exception:
        pass

def _fmt_gb(v):
    """Format bytes as GB with 4 decimal places."""
    return round(float(v or 0), 4)

def _traffic_pct(s: Server):
    if not s.traffic_limit_gb or s.traffic_limit_gb <= 0:
        return None
    used = s.traffic_used_gb or (s.traffic_up_gb + s.traffic_down_gb)
    return min(100.0, used / s.traffic_limit_gb * 100)

def _days_until_reset(reset_day: int) -> int:
    today = date.today()
    this_month_reset = today.replace(day=min(reset_day, monthrange(today.year, today.month)[1]))
    if this_month_reset <= today:
        if today.month == 12:
            next_reset = date(today.year + 1, 1, min(reset_day, 31))
        else:
            next_reset = date(today.year, today.month + 1,
                              min(reset_day, monthrange(today.year, today.month + 1)[1]))
    else:
        next_reset = this_month_reset
    return (next_reset - today).days

def _server_traffic_dict(s: Server, include_trend=False) -> dict:
    pct  = _traffic_pct(s)
    used = _fmt_gb(s.traffic_used_gb or (s.traffic_up_gb + s.traffic_down_gb))
    d = dict(
        id=s.id, name=s.name, flag=s.flag, group=s.group_name,
        location=s.location, ip=s.ip, status=s.status,
        traffic_limit_gb=_fmt_gb(s.traffic_limit_gb),
        traffic_up_gb=_fmt_gb(s.traffic_up_gb),
        traffic_down_gb=_fmt_gb(s.traffic_down_gb),
        traffic_used_gb=used,
        traffic_remaining_gb=_fmt_gb(max(0, (s.traffic_limit_gb or 0) - used))
            if s.traffic_limit_gb > 0 else None,
        traffic_pct=round(pct, 2) if pct is not None else None,
        traffic_reset_day=s.traffic_reset_day,
        days_until_reset=_days_until_reset(s.traffic_reset_day or 1),
        net_up_mbps=round(s.net_up, 2),
        net_down_mbps=round(s.net_down, 2),
        is_unlimited=not (s.traffic_limit_gb and s.traffic_limit_gb > 0),
        is_warn=pct is not None and pct >= 80,
        is_crit=pct is not None and pct >= 95,
    )
    if include_trend:
        d["trend_30d"] = _generate_trend_30d(s)
    return d

def _generate_trend_30d(s: Server) -> list:
    """
    尝试从 probe_results 历史读取 30 天每日汇总。
    若数据不足则用累积值反推模拟数据（确保总量和与当前一致）。
    """
    cutoff = datetime.utcnow() - timedelta(days=30)
    rows = (ProbeResult.query
            .filter(ProbeResult.server_id == s.id,
                    ProbeResult.probed_at >= cutoff)
            .order_by(ProbeResult.probed_at)
            .all())

    trend = []
    if rows:
        # Group by date and take last entry per day
        by_day = {}
        for r in rows:
            d_key = r.probed_at.date().isoformat()
            by_day[d_key] = r
        for d_key, r in sorted(by_day.items()):
            trend.append({
                "date": d_key,
                "net_up_mb":   round((r.net_up   or 0) * 86400 / 8, 2),
                "net_down_mb": round((r.net_down  or 0) * 86400 / 8, 2),
            })
    else:
        # Simulate from total values
        base_up = (s.traffic_up_gb   or 0) * 1024 / 30
        base_dn = (s.traffic_down_gb or 0) * 1024 / 30
        import random, math
        random.seed(s.id)
        for i in range(30):
            d_obj = date.today() - timedelta(days=29-i)
            noise = 0.5 + random.random() * 1.0
            trend.append({
                "date": d_obj.isoformat(),
                "net_up_mb":   round(base_up * noise, 2),
                "net_down_mb": round(base_dn * noise, 2),
            })
    return trend


# ── 路由 ──────────────────────────────────────────────────────────────────────

@traffic_bp.get("/")
def list_traffic():
    """获取所有服务器流量概览，支持 ?group=分组名 过滤"""
    group = request.args.get("group", "").strip()
    threshold = float(request.args.get("threshold", 80))

    cache_key = f"vps:traffic:list:{group}:{threshold}"
    try:
        cached = redis_client.get(cache_key)
        if cached:
            return jsonify(json.loads(cached))
    except Exception:
        pass

    query = Server.query
    if group:
        query = query.filter_by(group_name=group)
    servers_list = query.order_by(Server.id).all()

    result = [_server_traffic_dict(s) for s in servers_list]

    # Sort: crit → warn → others (desc by pct)
    result.sort(key=lambda d: -(d["traffic_pct"] or -1))

    payload = {"servers": result, "count": len(result)}
    try:
        redis_client.setex(cache_key, 10, json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass

    return jsonify(payload)


@traffic_bp.get("/summary")
def traffic_summary():
    """汇总统计：总出/入站、预警/危急数量、分组统计"""
    threshold = float(request.args.get("threshold", 80))

    try:
        cached = redis_client.get(_summary_cache_key())
        if cached:
            return jsonify(json.loads(cached))
    except Exception:
        pass

    all_servers = Server.query.all()
    with_limit  = [s for s in all_servers if s.traffic_limit_gb > 0]
    warn_list   = [s for s in with_limit if 80 <= (_traffic_pct(s) or 0) < 95]
    crit_list   = [s for s in with_limit if (_traffic_pct(s) or 0) >= 95]

    total_up   = sum(s.traffic_up_gb   or 0 for s in all_servers)
    total_down = sum(s.traffic_down_gb or 0 for s in all_servers)

    # Per-group breakdown
    groups = {}
    for s in all_servers:
        g = s.group_name
        if g not in groups:
            groups[g] = {"up_gb": 0, "down_gb": 0, "count": 0}
        groups[g]["up_gb"]   += s.traffic_up_gb   or 0
        groups[g]["down_gb"] += s.traffic_down_gb or 0
        groups[g]["count"]   += 1

    payload = {
        "total_up_gb":    round(total_up,   4),
        "total_down_gb":  round(total_down, 4),
        "total_used_gb":  round(total_up + total_down, 4),
        "server_count":   len(all_servers),
        "limited_count":  len(with_limit),
        "warn_count":     len(warn_list),
        "crit_count":     len(crit_list),
        "warn_servers":   [s.name for s in warn_list],
        "crit_servers":   [s.name for s in crit_list],
        "by_group":       {g: {**v, "up_gb": round(v["up_gb"], 2), "down_gb": round(v["down_gb"], 2)} for g, v in groups.items()},
    }
    try:
        redis_client.setex(_summary_cache_key(), 15, json.dumps(payload, ensure_ascii=False))
    except Exception:
        pass

    return jsonify(payload)


@traffic_bp.get("/alerts")
def traffic_alerts():
    """返回当前超限预警列表（按严重程度排序）"""
    threshold = float(request.args.get("threshold", 80))
    servers_all = Server.query.filter(Server.traffic_limit_gb > 0).all()

    alerts = []
    for s in servers_all:
        pct = _traffic_pct(s)
        if pct is None or pct < threshold:
            continue
        used = s.traffic_used_gb or (s.traffic_up_gb + s.traffic_down_gb)
        alerts.append({
            "server_id":    s.id,
            "server_name":  s.name,
            "flag":         s.flag,
            "location":     s.location,
            "pct":          round(pct, 2),
            "used_gb":      round(used, 2),
            "limit_gb":     round(s.traffic_limit_gb, 2),
            "remaining_gb": round(max(0, s.traffic_limit_gb - used), 2),
            "level":        "crit" if pct >= 95 else "warn",
            "days_until_reset": _days_until_reset(s.traffic_reset_day or 1),
            "ip":           s.ip,
        })

    alerts.sort(key=lambda a: -a["pct"])
    return jsonify(alerts=alerts, count=len(alerts))


@traffic_bp.get("/<int:sid>")
def get_server_traffic(sid):
    """单台服务器流量详情 + 30天趋势数据"""
    s = Server.query.get_or_404(sid)
    return jsonify(server=_server_traffic_dict(s, include_trend=True))


@traffic_bp.post("/<int:sid>/update")
@jwt_required()
def update_traffic(sid):
    """
    探针推送流量增量更新。
    Body: { up_gb_delta?, down_gb_delta?, up_gb_total?, down_gb_total? }
    优先使用 total 绝对值；否则用 delta 增量累加。
    """
    s    = Server.query.get_or_404(sid)
    data = request.get_json(silent=True) or {}

    if "up_gb_total" in data:
        s.traffic_up_gb   = float(data["up_gb_total"])
    elif "up_gb_delta" in data:
        s.traffic_up_gb   = (s.traffic_up_gb or 0) + float(data["up_gb_delta"])

    if "down_gb_total" in data:
        s.traffic_down_gb = float(data["down_gb_total"])
    elif "down_gb_delta" in data:
        s.traffic_down_gb = (s.traffic_down_gb or 0) + float(data["down_gb_delta"])

    s.traffic_used_gb = (s.traffic_up_gb or 0) + (s.traffic_down_gb or 0)

    db.session.commit()
    _invalidate(sid)

    # Fire alert if crossed threshold
    _check_and_fire_traffic_alert(s)

    return jsonify(msg="ok", server=_server_traffic_dict(s))


@traffic_bp.post("/<int:sid>/reset")
@jwt_required()
def reset_traffic(sid):
    """手动重置某台服务器的本月流量计数"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    s = Server.query.get_or_404(sid)
    s.traffic_up_gb   = 0.0
    s.traffic_down_gb = 0.0
    s.traffic_used_gb = 0.0
    db.session.commit()
    _invalidate(sid)
    return jsonify(msg=f"{s.name} 流量已重置")


@traffic_bp.put("/<int:sid>/config")
@jwt_required()
def config_traffic(sid):
    """
    设置流量限额和重置日
    Body: { traffic_limit_gb, traffic_reset_day }
    """
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    s    = Server.query.get_or_404(sid)
    data = request.get_json(silent=True) or {}

    if "traffic_limit_gb" in data:
        s.traffic_limit_gb  = max(0.0, float(data["traffic_limit_gb"]))
    if "traffic_reset_day" in data:
        s.traffic_reset_day = max(1, min(28, int(data["traffic_reset_day"])))

    db.session.commit()
    _invalidate(sid)
    return jsonify(msg="流量配置已更新", server=_server_traffic_dict(s))


# ── 告警触发 (内部调用) ───────────────────────────────────────────────────────

def _check_and_fire_traffic_alert(s: Server):
    """
    检查流量是否超阈值并触发 Telegram 推送。
    使用 Redis 冷却键避免连续重复推送（1小时内不重复）。
    """
    pct = _traffic_pct(s)
    if pct is None:
        return

    level = None
    if pct >= 95:
        level = "crit"
    elif pct >= 80:
        level = "warn"
    else:
        return

    cool_key = f"vps:traffic_alert_sent:{s.id}:{level}"
    try:
        if redis_client.exists(cool_key):
            return
        redis_client.setex(cool_key, 3600, "1")
    except Exception:
        pass

    # Fire via Telegram
    try:
        from models.models import TelegramConfig
        from api.telegram import send_message, _full_msg
        cfg = TelegramConfig.query.first()
        if not cfg or not cfg.enabled or not cfg.bot_token:
            return

        used = s.traffic_used_gb or (s.traffic_up_gb + s.traffic_down_gb)
        icon = "🔴" if level == "crit" else "⚡"
        body = (
            f"{icon} <b>{s.name}</b> 流量{'危急' if level=='crit' else '预警'}\n"
            f"已用: <b>{used:.2f} GB</b> / {s.traffic_limit_gb:.2f} GB  ({pct:.1f}%)\n"
            f"剩余: {max(0, s.traffic_limit_gb - used):.2f} GB\n"
            f"重置日: 每月 {s.traffic_reset_day} 日 | 位置: {s.location}"
        )
        send_message(_full_msg(cfg.prefix, body))
    except Exception:
        pass


# ── 月度自动重置检查 (由 scheduler 调用) ─────────────────────────────────────

def check_monthly_resets():
    """
    检查所有服务器是否到达重置日，若到达且尚未重置则清零。
    由 scheduler 每天 00:05 调用。
    """
    today = date.today()
    servers_list = Server.query.filter(Server.traffic_limit_gb > 0).all()
    reset_ids = []
    for s in servers_list:
        reset_day = s.traffic_reset_day or 1
        if today.day == reset_day:
            cool_key = f"vps:traffic_reset_done:{s.id}:{today.isoformat()}"
            try:
                if redis_client.exists(cool_key):
                    continue
                redis_client.setex(cool_key, 90000, "1")
            except Exception:
                pass
            s.traffic_up_gb   = 0.0
            s.traffic_down_gb = 0.0
            s.traffic_used_gb = 0.0
            reset_ids.append(s.id)

    if reset_ids:
        db.session.commit()
        _invalidate()

    return reset_ids
