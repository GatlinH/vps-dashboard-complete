# backend/api/traffic.py - 流量管理 API

"""
/api/traffic - 流量统计与管理
"""
from datetime import datetime, timedelta, date
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt
from extensions import db, redis_client
from models.models import Server, ProbeResult
from utils.errors import ValidationError, InternalServerError

traffic_bp = Blueprint("traffic", __name__)


@traffic_bp.get('/')
@jwt_required()
def get_traffic_summary():
    """获取流量总结"""
    try:
        servers = Server.query.all()
        
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
            timestamp=datetime.utcnow().isoformat(),
        )
    
    except Exception as e:
        raise InternalServerError("获取流量汇总失败", str(e))


@traffic_bp.get('/servers')
@jwt_required()
def list_traffic_servers():
    """获取所有服务器流量统计"""
    try:
        servers = Server.query.all()
        
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
@jwt_required()
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
    
    except Exception as e:
        raise InternalServerError("获取服务器流量详情失败", str(e))


@traffic_bp.post('/<int:sid>')
@jwt_required()
def update_server_traffic(sid):
    """更新服务器流量统计"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        from utils.errors import AuthorizationError
        raise AuthorizationError()
    
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
@jwt_required()
def get_traffic_history(sid):
    """获取流量历史数据"""
    try:
        days = min(max(1, int(request.args.get('days', 7))), 30)
        limit = min(max(1, int(request.args.get('limit', 1000))), 10000)
        
        server = Server.query.get_or_404(sid)
        
        # 查询历史数据
        start_date = datetime.utcnow() - timedelta(days=days)
        
        results = ProbeResult.query.filter(
            ProbeResult.server_id == sid,
            ProbeResult.created_at >= start_date
        ).order_by(ProbeResult.created_at).limit(limit).all()
        
        # 格式化数据
        data = []
        for r in results:
            data.append({
                'timestamp': r.created_at.isoformat(),
                'net_up': float(r.net_up) if r.net_up else 0,
                'net_down': float(r.net_down) if r.net_down else 0,
            })
        
        return jsonify(
            server_id=sid,
            days=days,
            data=data,
            count=len(data),
        )
    
    except Exception as e:
        raise InternalServerError("获取流量历史失败", str(e))


def check_monthly_resets():
    """
    检查并重置到达重置日的服务器流量
    返回重置的服务器 ID 列表
    """
    from datetime import date
    from models.models import Server
    
    today = date.today()
    reset_ids = []
    
    try:
        # 查找所有需要在今天重置的服务器
        servers = Server.query.filter(
            Server.traffic_reset_day == today.day
        ).all()
        
        for server in servers:
            # 重置流量计数
            server.traffic_used_gb = 0
            server.traffic_up_gb = 0
            server.traffic_down_gb = 0
            reset_ids.append(server.id)
        
        if reset_ids:
            db.session.commit()
            # 清除缓存
            try:
                redis_client.delete("vps:traffic:summary")
                for sid in reset_ids:
                    redis_client.delete(f"vps:traffic:{sid}")
            except Exception:
                pass
    
    except Exception as e:
        db.session.rollback()
        logger = __import__('logging').getLogger(__name__)
        logger.error(f"月度流量重置失败: {e}")
    
    return reset_ids


def _check_and_fire_traffic_alert(server):
    """
    检查单个服务器的流量超限情况并触发告警
    """
    if server.traffic_limit_gb <= 0:
        return
    
    # 计算使用百分比
    used_percent = (server.traffic_used_gb / server.traffic_limit_gb) * 100
    
    # 告警阈值：80%, 90%, 95%
    thresholds = [
        (95, '🔴 严重警告'),
        (90, '⚠️ 警告'),
        (80, '⚡ 提醒'),
    ]
    
    for threshold, level in thresholds:
        if used_percent >= threshold:
            # 检查冷却期（避免重复告警）
            cache_key = f"vps:traffic_alert:{server.id}:{threshold}"
            
            try:
                if redis_client.exists(cache_key):
                    return  # 冷却期内，跳过
                
                # 发送告警
                from models.models import TelegramConfig
                from api.telegram import send_message, _full_msg
                
                cfg = TelegramConfig.query.first()
                if cfg and cfg.enabled and cfg.bot_token:
                    body = (
                        f"{level} <b>流量超限</b>\n\n"
                        f"服务器: <b>{server.name}</b>\n"
                        f"位置: {server.location}\n"
                        f"流量使用: <b>{used_percent:.1f}%</b>\n"
                        f"已用: {server.traffic_used_gb:.2f} GB / {server.traffic_limit_gb:.2f} GB\n"
                        f"剩余: {server.traffic_limit_gb - server.traffic_used_gb:.2f} GB"
                    )
                    send_message(_full_msg(cfg.prefix, body))
                    
                    # 设置冷却期（1小时）
                    redis_client.setex(cache_key, 3600, "1")
                    
            except Exception as e:
                logger = __import__('logging').getLogger(__name__)
                logger.warning(f"流量告警发送失败: {e}")
            
            break  # 只发送最高级别的告警

