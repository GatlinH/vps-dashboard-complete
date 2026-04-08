# backend/api/servers.py - 完整改进版本

import json
from datetime import date, datetime, timedelta
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt
from extensions import db, redis_client
from models.models import Server, ProbeResult
from utils.errors import (
    ValidationError, AuthorizationError, ResourceNotFoundError,
    InternalServerError
)
from middleware.validators import RequestValidator

servers_bp = Blueprint("servers", __name__)

# ── 常量 ──

CACHE_KEY_LIST = "vps:servers:list"
CACHE_TTL = 15

def _metrics_key(server_id):
    return f"vps:server:{server_id}:metrics"

# ── 缓存函数 ──

def _invalidate_list_cache():
    """清除服务器列表缓存"""
    try:
        redis_client.delete(CACHE_KEY_LIST)
    except Exception as e:
        current_app.logger.warning(f"缓存清除失败: {e}")

def _get_cached_list():
    """获取缓存的服务器列表"""
    try:
        raw = redis_client.get(CACHE_KEY_LIST)
        return json.loads(raw) if raw else None
    except Exception as e:
        current_app.logger.warning(f"缓存读取失败: {e}")
        return None

def _set_cached_list(data, ttl=CACHE_TTL):
    """设置服务器列表缓存"""
    try:
        redis_client.setex(CACHE_KEY_LIST, ttl, json.dumps(data, ensure_ascii=False))
    except Exception as e:
        current_app.logger.warning(f"缓存写入失败: {e}")

# ── 路由 ──

@servers_bp.get("/")
def list_servers():
    """
    获取所有服务器列表
    
    查询参数：
      - group: 按分组过滤
      - status: 按状态过滤（online/offline/unknown）
      - sort: 排序字段（name/price/expiry）
      - order: 排序顺序（asc/desc）
    
    返回：
      {
        "servers": [...],
        "from_cache": true/false,
        "count": 10,
        "timestamp": "2026-04-08T10:30:00Z"
      }
    """
    try:
        # 尝试从缓存读取
        cached = _get_cached_list()
        if cached:
            return jsonify(
                servers=cached,
                from_cache=True,
                count=len(cached),
                timestamp=datetime.utcnow().isoformat(),
            )
        
        # 从数据库查询
        query = Server.query
        
        # 过滤条件
        if request.args.get('group'):
            query = query.filter_by(group_name=request.args.get('group'))
        
        if request.args.get('status'):
            query = query.filter_by(status=request.args.get('status'))
        
        # 排序
        sort_field = request.args.get('sort', 'id')
        sort_order = request.args.get('order', 'asc').lower()
        
        if sort_field == 'name':
            query = query.order_by(Server.name.asc() if sort_order == 'asc' else Server.name.desc())
        elif sort_field == 'price':
            query = query.order_by(Server.price.asc() if sort_order == 'asc' else Server.price.desc())
        elif sort_field == 'expiry':
            query = query.order_by(Server.expiry.asc() if sort_order == 'asc' else Server.expiry.desc())
        else:
            query = query.order_by(Server.id.asc() if sort_order == 'asc' else Server.id.desc())
        
        servers = query.all()
        result = []
        
        for s in servers:
            d = s.to_dict()
            
            # 尝试从 Redis 获取实时指标
            try:
                raw = redis_client.get(_metrics_key(s.id))
                if raw:
                    metrics = json.loads(raw)
                    d.update(metrics)
            except Exception as e:
                current_app.logger.debug(f"获取实时指标失败 [{s.id}]: {e}")
            
            result.append(d)
        
        # 缓存结果
        _set_cached_list(result)
        
        return jsonify(
            servers=result,
            from_cache=False,
            count=len(result),
            timestamp=datetime.utcnow().isoformat(),
        )
    
    except Exception as e:
        raise InternalServerError("获取服务器列表失败", str(e))


@servers_bp.get("/<int:sid>")
def get_server(sid):
    """获取单个服务器详情"""
    try:
        s = Server.query.get_or_404(sid)
        d = s.to_dict()
        
        # 获取实时指标
        try:
            raw = redis_client.get(_metrics_key(sid))
            if raw:
                d.update(json.loads(raw))
        except Exception:
            pass
        
        return jsonify(server=d)
    
    except Exception as e:
        raise InternalServerError("获取服务器信息失败", str(e))


@servers_bp.post("/")
@jwt_required()
@RequestValidator.validate_json(
    'name',
    optional_fields=['group', 'flag', 'location', 'ip', 'cpu', 'ram', 'disk', 'bw', 'probe', 'note', 'price', 'period', 'expiry'],
    type_checks={'cpu': int, 'ram': (int, float), 'disk': int, 'price': (int, float)}
)
def create_server():
    """创建服务器"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError(required_role='admin')
    
    try:
        data = request.validated_data
        
        # 验证名称
        if not data.get('name') or not data['name'].strip():
            raise ValidationError("服务器名称不能为空", field='name')
        
        if len(data['name']) > 100:
            raise ValidationError("服务器名称长度不能超过 100", field='name')
        
        # 验证过期日期
        expiry = None
        if data.get('expiry'):
            try:
                expiry = date.fromisoformat(data['expiry'])
                if expiry < date.today():
                    raise ValidationError("过期日期不能早于今天", field='expiry')
            except ValueError:
                raise ValidationError("过期日期格式错误，应为 YYYY-MM-DD", field='expiry')
        
        # 验证价格
        price = float(data.get('price', 0))
        if price < 0:
            raise ValidationError("价格不能为负数", field='price')
        
        # 创建服务器
        s = Server(
            name=data['name'].strip(),
            group_name=data.get('group', '默认分组').strip() or '默认分组',
            flag=data.get('flag', '🌐'),
            location=data.get('location', '').strip(),
            ip=data.get('ip', '').strip(),
            cpu_cores=max(1, int(data.get('cpu', 1))),
            ram_gb=max(0.5, float(data.get('ram', 1))),
            disk_gb=max(1, int(data.get('disk', 20))),
            bandwidth=data.get('bw', '不限').strip(),
            probe_url=data.get('probe', '').strip(),
            note=data.get('note', '').strip(),
            price=price,
            period=data.get('period', 'monthly'),
            expiry=expiry,
            status='unknown',
        )
        
        db.session.add(s)
        db.session.commit()
        
        _invalidate_list_cache()
        
        current_app.logger.info(f"创建服务器: {s.id} - {s.name}")
        
        return jsonify(server=s.to_dict()), 201
    
    except ValidationError:
        raise
    except Exception as e:
        db.session.rollback()
        raise InternalServerError("创建服务器失败", str(e))


@servers_bp.put("/<int:sid>")
@jwt_required()
def update_server(sid):
    """更新服务器信息"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError(required_role='admin')
    
    try:
        s = Server.query.get_or_404(sid)
        data = request.get_json(silent=True) or {}
        
        # 记录原始值
        old_values = s.to_dict()
        
        # 更新字段
        updatable_fields = {
            'name': 'name',
            'group': 'group_name',
            'flag': 'flag',
            'location': 'location',
            'ip': 'ip',
            'cpu': 'cpu_cores',
            'ram': 'ram_gb',
            'disk': 'disk_gb',
            'bw': 'bandwidth',
            'probe': 'probe_url',
            'note': 'note',
            'price': 'price',
            'period': 'period',
        }
        
        for api_key, db_field in updatable_fields.items():
            if api_key in data:
                value = data[api_key]
                
                if api_key == 'name':
                    if not value or not str(value).strip():
                        raise ValidationError("服务器名称不能为空", field='name')
                    value = str(value).strip()
                
                elif api_key == 'cpu':
                    value = max(1, int(value))
                
                elif api_key in ['ram']:
                    value = max(0.5, float(value))
                
                elif api_key in ['disk']:
                    value = max(1, int(value))
                
                elif api_key == 'price':
                    value = max(0, float(value))
                
                setattr(s, db_field, value)
        
        # 更新过期日期
        if 'expiry' in data:
            if data['expiry']:
                try:
                    s.expiry = date.fromisoformat(data['expiry'])
                except ValueError:
                    raise ValidationError("过期日期格式错误，应为 YYYY-MM-DD", field='expiry')
            else:
                s.expiry = None
        
        db.session.commit()
        _invalidate_list_cache()
        
        current_app.logger.info(f"更新服务器: {sid} - {s.name}")
        
        return jsonify(server=s.to_dict())
    
    except ValidationError:
        raise
    except Exception as e:
        db.session.rollback()
        raise InternalServerError("更新服务器失败", str(e))


@servers_bp.delete("/<int:sid>")
@jwt_required()
def delete_server(sid):
    """删除服务器"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError(required_role='admin')
    
    try:
        s = Server.query.get_or_404(sid)
        server_name = s.name
        
        db.session.delete(s)
        db.session.commit()
        
        _invalidate_list_cache()
        
        try:
            redis_client.delete(_metrics_key(sid))
        except Exception:
            pass
        
        current_app.logger.info(f"删除服务器: {sid} - {server_name}")
        
        return jsonify(msg=f"服务器 '{server_name}' 已删除", id=sid)
    
    except Exception as e:
        db.session.rollback()
        raise InternalServerError("删除服务器失败", str(e))


@servers_bp.post("/<int:sid>/metrics")
@jwt_required()
def push_metrics(sid):
    """
    推送实时指标
    
    Body:
      {
        "cpu_use": 45.2,
        "ram_use": 62.1,
        "disk_use": 78.5,
        "net_up": 125.4,
        "net_down": 456.8,
        "status": "online",
        "uptime": "10 days 5:30",
        "latency_ms": 25
      }
    """
    try:
        s = Server.query.get_or_404(sid)
        data = request.get_json(silent=True) or {}
        
        # 验证数据
        try:
            metrics = {
                "cpu_use": round(float(data.get("cpu_use", s.cpu_use)), 2),
                "ram_use": round(float(data.get("ram_use", s.ram_use)), 2),
                "disk_use": round(float(data.get("disk_use", s.disk_use)), 2),
                "net_up": round(float(data.get("net_up", s.net_up)), 2),
                "net_down": round(float(data.get("net_down", s.net_down)), 2),
                "status": str(data.get("status", s.status)),
                "uptime": str(data.get("uptime", s.uptime) or ""),
            }
            
            latency = float(data.get("latency_ms", 0))
        
        except (ValueError, TypeError) as e:
            raise ValidationError(f"指标数据类型错误: {str(e)}")
        
        # 验证范围
        if not (0 <= metrics["cpu_use"] <= 100):
            raise ValidationError("CPU 使用率必须在 0-100 之间", field='cpu_use')
        if not (0 <= metrics["ram_use"] <= 100):
            raise ValidationError("内存使用率必须在 0-100 之间", field='ram_use')
        if not (0 <= metrics["disk_use"] <= 100):
            raise ValidationError("磁盘使用率必须在 0-100 之间", field='disk_use')
        
        # 存储到 Redis（短期缓存）
        ttl = current_app.config.get("PROBE_CACHE_TTL", 15)
        try:
            redis_client.setex(
                _metrics_key(sid),
                ttl,
                json.dumps(metrics, ensure_ascii=False)
            )
        except Exception as e:
            current_app.logger.warning(f"Redis 写入失败: {e}")
        
        # 存储到 MySQL（持久化）
        try:
            for k, v in metrics.items():
                setattr(s, k, v)
            
            probe_result = ProbeResult(
                server_id=sid,
                cpu_use=metrics["cpu_use"],
                ram_use=metrics["ram_use"],
                disk_use=metrics["disk_use"],
                net_up=metrics["net_up"],
                net_down=metrics["net_down"],
                latency_ms=latency,
                status=metrics["status"],
            )
            
            db.session.add(probe_result)
            db.session.commit()
            
            _invalidate_list_cache()
        
        except Exception as e:
            db.session.rollback()
            raise InternalServerError("保存指标失败", str(e))
        
        return jsonify(msg="ok", metrics=metrics)
    
    except ValidationError:
        raise
    except Exception as e:
        raise InternalServerError("推送指标失败", str(e))


@servers_bp.get("/<int:sid>/history")
@jwt_required()
def get_server_history(sid):
    """
    获取服务器历史数据
    
    查询参数：
      - days: 天数（1-30，默认 1）
      - limit: 结果数限制（1-10000，默认 1000）
      - metric: 指标类型（cpu|memory|disk|traffic，可选）
    
    返回：
      {
        "data": [
          {
            "timestamp": "2026-04-08T10:30:00Z",
            "cpu_use": 45.2,
            "ram_use": 62.1,
            "disk_use": 78.5,
            "net_up": 125.4,
            "net_down": 456.8
          }
        ],
        "count": 100,
        "from_cache": false
      }
    """
    try:
        # 验证参数
        try:
            days = max(1, min(int(request.args.get('days', 1)), 30))
            limit = max(1, min(int(request.args.get('limit', 1000)), 10000))
        except ValueError:
            raise ValidationError("days 和 limit 必须是整数")
        
        # 检查服务器是否存在
        server = Server.query.get_or_404(sid)
        
        # 计算时间范围
        start_date = datetime.utcnow() - timedelta(days=days)
        
        # 查询历史数据
        results = ProbeResult.query.filter(
            ProbeResult.server_id == sid,
            ProbeResult.created_at >= start_date
        ).order_by(ProbeResult.created_at).limit(limit).all()
        
        # 格式化数据
        data = []
        for r in results:
            try:
                data.append({
                    'timestamp': r.created_at.isoformat() if hasattr(r.created_at, 'isoformat') else str(r.created_at),
                    'cpu_use': float(r.cpu_use) if r.cpu_use is not None else 0,
                    'ram_use': float(r.ram_use) if r.ram_use is not None else 0,
                    'disk_use': float(r.disk_use) if r.disk_use is not None else 0,
                    'net_up': float(r.net_up) if r.net_up is not None else 0,
                    'net_down': float(r.net_down) if r.net_down is not None else 0,
                })
            except Exception as e:
                current_app.logger.warning(f"数据格式化失败: {e}")
                continue
        
        return jsonify(
            data=data,
            count=len(data),
            from_cache=False,
            server_id=sid,
            days=days,
        )
    
    except ValidationError:
        raise
    except Exception as e:
        raise InternalServerError("获取历史数据失败", str(e))


@servers_bp.get("/groups")
def list_groups():
    """获取所有分组"""
    try:
        rows = db.session.query(Server.group_name).distinct().order_by(Server.group_name).all()
        groups = [r[0] for r in rows if r[0]]
        
        return jsonify(
            groups=groups,
            count=len(groups),
        )
    
    except Exception as e:
        raise InternalServerError("获取分组列表失败", str(e))
