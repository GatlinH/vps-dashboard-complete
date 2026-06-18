# backend/api/traffic.py - 流量管理 API

"""
/api/traffic - 流量统计与管理
"""
import os as _os
import calendar as _calendar
from datetime import datetime, timezone, timedelta, date
from flask import Blueprint, request, jsonify, current_app
from sqlalchemy.orm import load_only
from extensions import db, redis_client
from models.models import Server, ProbeResult
from middleware.rbac import admin_required, viewer_or_admin_required
from werkzeug.exceptions import HTTPException
from utils.errors import ValidationError, InternalServerError

traffic_bp = Blueprint("traffic", __name__)


def _build_traffic_payload(server, include_name=True):
    """Build traffic payload safe for public display."""
    today = date.today()
    reset_day = max(1, min(int(server.traffic_reset_day or 1), 31))

    if today.day <= reset_day:
        reset_date = date(today.year, today.month, min(reset_day, _calendar.monthrange(today.year, today.month)[1]))
    else:
        if today.month == 12:
            year, month = today.year + 1, 1
        else:
            year, month = today.year, today.month + 1
        reset_date = date(year, month, min(reset_day, _calendar.monthrange(year, month)[1]))

    used = round(server.traffic_used_gb or 0, 2)
    limit = round(server.traffic_limit_gb or 0, 2)
    payload = {
        'id': server.id,
        'limit_gb': limit,
        'used_gb': used,
        'up_gb': round(server.traffic_up_gb or 0, 2),
        'down_gb': round(server.traffic_down_gb or 0, 2),
        'used_percent': round((used / limit * 100), 2) if limit > 0 else 0,
        'remaining_gb': round(max(0, limit - used), 2),
        'reset_day': reset_day,
        'next_reset_date': reset_date.isoformat(),
        'days_until_reset': (reset_date - today).days,
    }
    if include_name:
        payload['name'] = server.name
    return payload


@traffic_bp.get('/public/<int:sid>')
def get_public_server_traffic(sid):
    """Public traffic details for display page."""
    try:
        server = Server.query.get_or_404(sid)
        return jsonify(_build_traffic_payload(server))
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError("获取公开流量详情失败", str(e))


@traffic_bp.get('/public/<int:sid>/history')
def get_public_traffic_history(sid):
    """Public traffic history for display page."""
    try:
        days = min(max(1, int(request.args.get('days', 7))), 30)
        limit = min(max(1, int(request.args.get('limit', 1000))), 10000)
        offset = max(0, int(request.args.get('offset', 0)))

        Server.query.get_or_404(sid)
        start_date = datetime.now(timezone.utc) - timedelta(days=days)
        base_query = ProbeResult.query.filter(
            ProbeResult.server_id == sid,
            ProbeResult.created_at >= start_date
        )
        total = base_query.count()
        # Return the newest window, not the oldest rows from the last 24h.
        # The frontend chart expects recent telemetry and will sort ascending.
        results = (
            base_query
            .order_by(ProbeResult.created_at.desc())
            .offset(offset)
            .limit(limit)
            .all()
        )
        results = list(reversed(results))

        data = [{
            'timestamp': r.created_at.isoformat(),
            'net_up': float(r.net_up) if r.net_up else 0,
            'net_down': float(r.net_down) if r.net_down else 0,
        } for r in results]

        return jsonify(
            server_id=sid,
            days=days,
            total=total,
            limit=limit,
            offset=offset,
            data=data,
            count=len(data),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError("获取公开流量历史失败", str(e))


@traffic_bp.get('/')
@viewer_or_admin_required
def get_traffic_summary():
    """获取流量总结"""
    try:
        servers = Server.query.options(
            load_only(
                Server.id, Server.traffic_limit_gb,
                Server.traffic_used_gb, Server.traffic_up_gb,
                Server.traffic_down_gb,
            )
        ).all()
        
        total_limit = sum(s.traffic_limit_gb for s in servers if s.traffic_limit_gb > 0)
        total_used = sum(s.traffic_used_gb for s in servers if s.traffic_used_gb > 0)
        total_up = sum(s.traffic_up_gb for s in servers)
        total_down = sum(s.traffic_down_gb for s in servers)
        
        return jsonify(
            total_limit_gb=round(total_limit, 2),
            total_used_gb=round(total_used, 2),
            total_up_gb=round(total_up, 2),
            total_down_gb=round(total_down, 2),
            server_count=len(servers),
            timestamp=datetime.now(timezone.utc).isoformat(),
        )
    
    except Exception as e:
        raise InternalServerError("获取流量汇总失败", str(e))


@traffic_bp.get('/servers')
@viewer_or_admin_required
def list_traffic_servers():
    """获取所有服务器流量统计"""
    try:
        servers = Server.query.options(
            load_only(
                Server.id, Server.name, Server.traffic_limit_gb,
                Server.traffic_used_gb, Server.traffic_up_gb,
                Server.traffic_down_gb, Server.traffic_reset_day,
                Server.updated_at,
            )
        ).all()
        
        result = []
        for s in servers:
            result.append({
                'id': s.id,
                'name': s.name,
                'limit_gb': round(s.traffic_limit_gb, 2),
                'used_gb': round(s.traffic_used_gb, 2),
                'up_gb': round(s.traffic_up_gb, 2),
                'down_gb': round(s.traffic_down_gb, 2),
                'used_percent': round((s.traffic_used_gb / s.traffic_limit_gb * 100), 2) if s.traffic_limit_gb > 0 else 0,
                'reset_day': s.traffic_reset_day,
                'updated_at': s.updated_at.isoformat() if s.updated_at else None,
            })
        
        return jsonify(servers=result, count=len(result))
    
    except Exception as e:
        raise InternalServerError("获取服务器流量列表失败", str(e))


@traffic_bp.get('/<int:sid>')
@viewer_or_admin_required
def get_server_traffic(sid):
    """获取单个服务器流量详情"""
    try:
        server = Server.query.get_or_404(sid)
        
        # 计算重置日期
        today = date.today()
        reset_day = server.traffic_reset_day
        
        if today.day <= reset_day:
            reset_date = date(today.year, today.month, reset_day)
        else:
            # 下个月
            if today.month == 12:
                reset_date = date(today.year + 1, 1, min(reset_day, 31))
            else:
                reset_date = date(today.year, today.month + 1, min(reset_day, 31))
        
        days_until_reset = (reset_date - today).days
        
        return jsonify(
            id=server.id,
            name=server.name,
            limit_gb=round(server.traffic_limit_gb, 2),
            used_gb=round(server.traffic_used_gb, 2),
            up_gb=round(server.traffic_up_gb, 2),
            down_gb=round(server.traffic_down_gb, 2),
            used_percent=round((server.traffic_used_gb / server.traffic_limit_gb * 100), 2) if server.traffic_limit_gb > 0 else 0,
            remaining_gb=round(max(0, server.traffic_limit_gb - server.traffic_used_gb), 2),
            reset_day=server.traffic_reset_day,
            next_reset_date=reset_date.isoformat(),
            days_until_reset=days_until_reset,
        )
    
    except HTTPException:
        raise
    except Exception as e:
        raise InternalServerError("获取服务器流量详情失败", str(e))


@traffic_bp.post('/<int:sid>')
@admin_required
def update_server_traffic(sid):
    """更新服务器流量统计"""
    try:
        server = Server.query.get_or_404(sid)
        data = request.get_json(silent=True) or {}
        
        # 验证并更新
        if 'limit_gb' in data:
            server.traffic_limit_gb = max(0, float(data['limit_gb']))
        
        if 'used_gb' in data:
            server.traffic_used_gb = max(0, float(data['used_gb']))
        
        if 'up_gb' in data:
            server.traffic_up_gb = max(0, float(data['up_gb']))
        
        if 'down_gb' in data:
            server.traffic_down_gb = max(0, float(data['down_gb']))
        
        if 'reset_day' in data:
            server.traffic_reset_day = max(1, min(31, int(data['reset_day'])))
        
        db.session.commit()
        
        return jsonify(
            msg="流量统计已更新",
            server_id=sid,
        )
    
    except ValidationError:
        raise
    except Exception as e:
        db.session.rollback()
        raise InternalServerError("更新流量统计失败", str(e))


@traffic_bp.get('/<int:sid>/history')
@viewer_or_admin_required
def get_traffic_history(sid):
    """获取流量历史数据"""
    try:
        days = min(max(1, int(request.args.get('days', 7))), 30)
        limit = min(max(1, int(request.args.get('limit', 1000))), 10000)
        offset = max(0, int(request.args.get('offset', 0)))
        export = (request.args.get('export', '') or '').strip().lower()
        
        server = Server.query.get_or_404(sid)
        
        # 查询历史数据
        start_date = datetime.now(timezone.utc) - timedelta(days=days)
        
        base_query = ProbeResult.query.filter(
            ProbeResult.server_id == sid,
            ProbeResult.created_at >= start_date
        ).order_by(ProbeResult.created_at)
        total = base_query.count()
        results = base_query.offset(offset).limit(limit).all()
        
        # 格式化数据
        data = []
        for r in results:
            data.append({
                'timestamp': r.created_at.isoformat(),
                'net_up': float(r.net_up) if r.net_up else 0,
                'net_down': float(r.net_down) if r.net_down else 0,
            })
        
        if export == 'csv':
            import csv
            from io import StringIO
            csv_buffer = StringIO()
            writer = csv.DictWriter(csv_buffer, fieldnames=['timestamp', 'net_up', 'net_down'])
            writer.writeheader()
            writer.writerows(data)
            return (
                csv_buffer.getvalue(),
                200,
                {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': f'attachment; filename="server-{sid}-traffic-history.csv"',
                },
            )

        return jsonify(
            server_id=sid,
            days=days,
            total=total,
            limit=limit,
            offset=offset,
            data=data,
            count=len(data),
        )
    
    except Exception as e:
        raise InternalServerError("获取流量历史失败", str(e))

# ── 月度重置与告警辅助（供 scheduler.py 调用） ────────────────────────────────

def check_monthly_resets(today=None):
    """检查并重置到达重置日的服务器流量，返回被重置的 server_id 列表。

    当 traffic_reset_day 超过当月最后一天（如 31 号配置而当月仅 28/30 天），
    则在当月最后一天执行重置，避免该月永远不重置的问题。

    Args:
        today: 用于判断的日期（date 对象）。默认为 None，此时使用系统本地日期
               date.today()。scheduler 调用时应传入调度器所在时区的当前日期，
               以避免系统时区与调度器时区不一致导致的语义偏差。
    """
    if today is None:
        today = date.today()
    _, last_day = _calendar.monthrange(today.year, today.month)
    reset_ids = []
    try:
        servers = Server.query.filter(Server.traffic_reset_day > 0).all()
        for s in servers:
            effective_reset_day = min(s.traffic_reset_day, last_day)
            if today.day == effective_reset_day:
                s.traffic_up_gb   = 0.0
                s.traffic_down_gb = 0.0
                s.traffic_used_gb = 0.0
                reset_ids.append(s.id)
        if reset_ids:
            db.session.commit()
    except Exception:
        db.session.rollback()
    return reset_ids


_TRAFFIC_ALERT_LEVELS = [
    (95, "🔴严重", "流量已使用 {pct:.1f}%，即将耗尽！"),
    (90, "⚠️警告", "流量已使用 {pct:.1f}%，请注意！"),
    (80, "⚡提醒", "流量已使用 {pct:.1f}%。"),
]
# 默认 1 小时冷却，可通过 TRAFFIC_ALERT_COOLDOWN_S 环境变量覆盖
_TRAFFIC_ALERT_COOLDOWN_S = int(_os.getenv("TRAFFIC_ALERT_COOLDOWN_S", "3600"))


def _check_and_fire_traffic_alert(server):
    """检查单台服务器流量超限，触发 Telegram 告警（带冷却）"""
    if not server.traffic_limit_gb or server.traffic_limit_gb <= 0:
        return
    pct = server.traffic_used_gb / server.traffic_limit_gb * 100

    for threshold, label, tmpl in _TRAFFIC_ALERT_LEVELS:
        if pct >= threshold:
            cooldown_key = f"vps:traffic_alert:{server.id}:{threshold}"
            try:
                if redis_client.get(cooldown_key):
                    break  # 冷却中，不重复告警
                redis_client.setex(cooldown_key, _TRAFFIC_ALERT_COOLDOWN_S, "1")
            except Exception:
                pass

            try:
                from models.models import TelegramConfig
                from api.telegram import send_message, _full_msg
                cfg = TelegramConfig.query.first()
                if cfg and cfg.enabled and cfg.bot_token:
                    body = (
                        f"{label} <b>{server.name}</b> 流量告警\n"
                        + tmpl.format(pct=pct)
                        + f"\n已用: {server.traffic_used_gb:.2f} GB / 限额: {server.traffic_limit_gb:.2f} GB"
                    )
                    send_message(_full_msg(cfg.prefix, body))
            except Exception:
                pass
            break
