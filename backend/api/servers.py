# backend/api/servers.py - 完整版本
# 服务器管理 API：CRUD + 实时指标 + 缓存 + 验证

"""
/api/servers - 服务器管理 API
支持：
  - 列表查询（过滤、排序、缓存）
  - 单体查询
  - 创建服务器
  - 更新服务器信息
  - 删除服务器
  - 推送实时指标
  - 查询历史数据
  - 获取分组列表
"""

import json
import logging
from datetime import date, datetime, timedelta
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt, get_jwt_identity
from werkzeug.exceptions import HTTPException
from extensions import db, redis_client
from models.models import Server, ProbeResult
from utils.errors import (
    ValidationError, AuthorizationError, ResourceNotFoundError,
    InternalServerError
)
from middleware.validators import RequestValidator

# 初始化日志
logger = logging.getLogger(__name__)

# 创建蓝图
servers_bp = Blueprint("servers", __name__)

# ===== 常量定义 =====

CACHE_KEY_LIST = "vps:servers:list"
CACHE_TTL = 15  # 缓存 TTL（秒）

# 实时指标中属于敏感信息的字段（仅用于过滤 Redis metrics 合并时的流量字段）。
# 注：IP / probe / note / price / expiry 等字段由 Server.to_dict(public_only=True)
# 在 ORM 层面过滤；流量字段（traffic_*）在实时指标合并时需单独过滤，因为它们
# 来自 Redis 而非通过 to_dict() 返回。
_PUBLIC_SENSITIVE_METRIC_FIELDS = frozenset({
    'traffic_limit_gb', 'traffic_up_gb',
    'traffic_down_gb', 'traffic_used_gb',
})

def _metrics_key(server_id):
    """获取服务器指标缓存键"""
    return f"vps:server:{server_id}:metrics"

def _groups_key():
    """获取分组列表缓存键"""
    return "vps:server:groups"

# ===== 缓存管理函数 =====

def _invalidate_list_cache():
    """清除服务器列表缓存"""
    try:
        redis_client.delete(CACHE_KEY_LIST)
        logger.debug(f"✓ 已清除列表缓存")
    except Exception as e:
        logger.warning(f"⚠️ 缓存清除失败: {e}")

def _invalidate_groups_cache():
    """清除分组列表缓存"""
    try:
        redis_client.delete(_groups_key())
        logger.debug(f"✓ 已清除分组缓存")
    except Exception as e:
        logger.warning(f"⚠️ 分组缓存清除失败: {e}")

def _get_cached_list():
    """从缓存获取服务器列表"""
    try:
        raw = redis_client.get(CACHE_KEY_LIST)
        if raw:
            return json.loads(raw)
    except Exception as e:
        logger.warning(f"⚠️ 缓存读取失败: {e}")
    return None

def _set_cached_list(data, ttl=CACHE_TTL):
    """将服务器列表存入缓存"""
    try:
        redis_client.setex(
            CACHE_KEY_LIST,
            ttl,
            json.dumps(data, ensure_ascii=False, default=str)
        )
        logger.debug(f"✓ 列表已缓存 (TTL={ttl}s)")
    except Exception as e:
        logger.warning(f"⚠️ 缓存写入失败: {e}")

# ===== API 路由 =====

@servers_bp.get("/")
@jwt_required(optional=True)
def list_servers():
    """
    获取所有服务器列表
    
    查询参数：
      - group: 按分组过滤（如：?group=生产环境）
      - status: 按状态过滤（online|offline|warn|unknown）
      - sort: 排序字段（id|name|price|expiry|status）
      - order: 排序顺序（asc|desc，默认 asc）
    
    响应：
      {
        "servers": [
          {
            "id": 1,
            "name": "Server-01",
            "status": "online",
            "cpu_use": 45.2,
            "ram_use": 62.1,
            ...
          }
        ],
        "from_cache": true,
        "count": 10,
        "timestamp": "2026-04-08T10:30:00"
      }
    
    鉴权：
      - 已登录用户：返回完整数据（含 ip、probe、note、price 等敏感字段）
      - 未登录访客：返回脱敏数据（敏感字段已剔除）
    
    缓存：
      - 仅对已登录用户缓存
      - 15 秒过期
      - 修改操作后自动清除
    """
    is_authenticated = get_jwt_identity() is not None
    public_only = not is_authenticated
    try:
        # 1️⃣ 尝试从缓存读取（仅限已登录用户）
        if is_authenticated:
            cached = _get_cached_list()
            if cached:
                return jsonify(
                    servers=cached,
                    from_cache=True,
                    count=len(cached),
                    timestamp=datetime.utcnow().isoformat(),
                ), 200
        
        # 2️⃣ 从数据库查询
        query = Server.query
        
        # 过滤条件：分组
        if request.args.get('group'):
            group_filter = request.args.get('group').strip()
            query = query.filter_by(group_name=group_filter)
            logger.debug(f"🔍 按分组过滤: {group_filter}")
        
        # 过滤条件：状态
        if request.args.get('status'):
            status_filter = request.args.get('status').strip().lower()
            if status_filter not in ['online', 'offline', 'warn', 'unknown']:
                raise ValidationError(
                    f"状态值无效，应为：online|offline|warn|unknown",
                    field='status'
                )
            query = query.filter_by(status=status_filter)
            logger.debug(f"🔍 按状态过滤: {status_filter}")
        
        # 排序
        sort_field = request.args.get('sort', 'id').strip().lower()
        sort_order = request.args.get('order', 'asc').strip().lower()
        
        if sort_order not in ['asc', 'desc']:
            sort_order = 'asc'
        
        # 根据排序字段构建查询
        if sort_field == 'name':
            query = query.order_by(
                Server.name.asc() if sort_order == 'asc' else Server.name.desc()
            )
        elif sort_field == 'price':
            query = query.order_by(
                Server.price.asc() if sort_order == 'asc' else Server.price.desc()
            )
        elif sort_field == 'expiry':
            query = query.order_by(
                Server.expiry.asc() if sort_order == 'asc' else Server.expiry.desc()
            )
        elif sort_field == 'status':
            query = query.order_by(
                Server.status.asc() if sort_order == 'asc' else Server.status.desc()
            )
        else:  # 默认按 ID
            query = query.order_by(
                Server.id.asc() if sort_order == 'asc' else Server.id.desc()
            )
        
        servers = query.all()
        result = []
        
        # 3️⃣ 构建响应数据
        for s in servers:
            d = s.to_dict(public_only=public_only)
            
            # 尝试从 Redis 获取实时指标
            try:
                metrics_json = redis_client.get(_metrics_key(s.id))
                if metrics_json:
                    metrics = json.loads(metrics_json)
                    # 合并实时指标到响应（访客模式下过滤敏感指标字段）
                    if public_only:
                        metrics = {k: v for k, v in metrics.items()
                                   if k not in _PUBLIC_SENSITIVE_METRIC_FIELDS}
                    d.update(metrics)
                    d['has_realtime_metrics'] = True
            except Exception as e:
                logger.debug(f"⚠️ 获取实时指标失败 [Server {s.id}]: {e}")
                d['has_realtime_metrics'] = False
            
            result.append(d)
        
        # 4️⃣ 缓存结果（仅限已登录用户）
        if is_authenticated:
            _set_cached_list(result)
        
        logger.info(f"✓ 返回 {len(result)} 台服务器（从数据库）")
        
        return jsonify(
            servers=result,
            from_cache=False,
            count=len(result),
            timestamp=datetime.utcnow().isoformat(),
        ), 200
    
    except ValidationError:
        raise
    except Exception as e:
        logger.error(f"❌ 获取服务器列表失败: {e}", exc_info=True)
        raise InternalServerError("获取服务器列表失败", str(e))


@servers_bp.get("/<int:sid>")
@jwt_required(optional=True)
def get_server(sid):
    """
    获取单个服务器详情
    
    参数：
      sid: 服务器 ID
    
    响应：
      {
        "server": {
          "id": 1,
          "name": "Server-01",
          "status": "online",
          "cpu_use": 45.2,
          ...
        }
      }
    
    鉴权：
      - 已登录用户：返回完整数据（含敏感字段）
      - 未登录访客：返回脱敏数据
    """
    is_authenticated = get_jwt_identity() is not None
    public_only = not is_authenticated
    try:
        s = Server.query.get_or_404(sid)
        d = s.to_dict(public_only=public_only)
        
        # 获取实时指标
        try:
            metrics_json = redis_client.get(_metrics_key(sid))
            if metrics_json:
                metrics = json.loads(metrics_json)
                if public_only:
                    metrics = {k: v for k, v in metrics.items()
                               if k not in _PUBLIC_SENSITIVE_METRIC_FIELDS}
                d.update(metrics)
                d['has_realtime_metrics'] = True
        except Exception as e:
            logger.warning(f"⚠️ 获取实时指标失败: {e}")
            d['has_realtime_metrics'] = False
        
        logger.info(f"✓ 获取服务器详情: {sid}")
        return jsonify(server=d), 200
    
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"❌ 获取服务器信息失败: {e}")
        raise InternalServerError("获取服务器信息失败", str(e))


@servers_bp.post("/")
@jwt_required()
@RequestValidator.validate_json(
    'name',
    optional_fields=[
        'group', 'flag', 'location', 'ip', 'cpu', 'ram', 'disk',
        'bw', 'probe', 'note', 'price', 'period', 'expiry',
        'traffic_limit', 'traffic_reset_day'
    ],
    type_checks={
        'cpu': int,
        'ram': (int, float),
        'disk': int,
        'price': (int, float),
        'traffic_limit': (int, float),
        'traffic_reset_day': int
    }
)
def create_server():
    """
    创建新服务器
    
    请求体：
      {
        "name": "Server-01" (必需),
        "group": "生产环境" (可选),
        "flag": "🇺🇸" (可选),
        "location": "New York" (可选),
        "ip": "1.2.3.4" (可选),
        "cpu": 4 (可选),
        "ram": 8.0 (可选),
        "disk": 100 (可选),
        "bw": "1Gbps" (可选),
        "probe": "http://probe.example.com" (可选),
        "note": "备注信息" (可选),
        "price": 99.99 (可选),
        "period": "monthly" (可选),
        "expiry": "2026-12-31" (可选),
        "traffic_limit": 1000 (可选),
        "traffic_reset_day": 1 (可选)
      }
    
    响应：201 Created
      {
        "server": { ... },
        "message": "服务器创建成功"
      }
    """
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以创建服务器", required_role='admin')
    
    try:
        data = request.validated_data
        
        # ✅ 1️⃣ 验证名称
        name = data.get('name', '').strip()
        if not name:
            raise ValidationError("服务器名称不能为空", field='name')
        
        if len(name) > 128:
            raise ValidationError("服务器名称长度不能超过 128 个字符", field='name')
        
        # ✅ 2️⃣ 验证过期日期
        expiry = None
        if data.get('expiry'):
            try:
                expiry = date.fromisoformat(data['expiry'])
                if expiry < date.today():
                    raise ValidationError(
                        "过期日期不能早于今天",
                        field='expiry',
                        value=data['expiry']
                    )
            except ValueError:
                raise ValidationError(
                    "过期日期格式错误，应为 YYYY-MM-DD",
                    field='expiry'
                )
        
        # ✅ 3️⃣ 验证价格
        price = float(data.get('price', 0))
        if price < 0:
            raise ValidationError("价格不能为负数", field='price')
        
        # ✅ 4️⃣ 验证 CPU 核心数
        cpu_cores = int(data.get('cpu', 1))
        if cpu_cores < 1 or cpu_cores > 256:
            raise ValidationError("CPU 核心数必须在 1-256 之间", field='cpu')
        
        # ✅ 5️⃣ 验证内存大小
        ram_gb = float(data.get('ram', 1.0))
        if ram_gb < 0.5 or ram_gb > 1024:
            raise ValidationError("内存大小必须在 0.5-1024 GB 之间", field='ram')
        
        # ✅ 6️⃣ 验证磁盘大小
        disk_gb = int(data.get('disk', 20))
        if disk_gb < 1 or disk_gb > 100000:
            raise ValidationError("磁盘大小必须在 1-100000 GB 之间", field='disk')
        
        # ✅ 7️⃣ 验证流量限制
        traffic_limit = float(data.get('traffic_limit', 0))
        if traffic_limit < 0:
            raise ValidationError("流量限制不能为负数", field='traffic_limit')
        
        # ✅ 8️⃣ 验证流量重置日期
        traffic_reset_day = int(data.get('traffic_reset_day', 1))
        if traffic_reset_day < 1 or traffic_reset_day > 31:
            raise ValidationError(
                "流量重置日期必须在 1-31 之间",
                field='traffic_reset_day'
            )
        
        # 创建服务器对象
        s = Server(
            name=name,
            group_name=data.get('group', '默认分组').strip() or '默认分组',
            flag=data.get('flag', '🌐').strip(),
            location=data.get('location', '').strip(),
            ip=data.get('ip', '').strip(),
            cpu_cores=cpu_cores,
            ram_gb=ram_gb,
            disk_gb=disk_gb,
            bandwidth=data.get('bw', '不限').strip(),
            probe_url=data.get('probe', '').strip(),
            note=data.get('note', '').strip(),
            price=price,
            period=data.get('period', 'monthly').strip(),
            expiry=expiry,
            status='unknown',
            traffic_limit_gb=traffic_limit,
            traffic_reset_day=traffic_reset_day,
        )
        
        db.session.add(s)
        db.session.commit()
        
        # 清除缓存
        _invalidate_list_cache()
        _invalidate_groups_cache()
        
        logger.info(f"✓ 创建服务器成功: ID={s.id}, Name={s.name}")
        
        return jsonify(
            server=s.to_dict(),
            message=f"服务器 '{s.name}' 创建成功"
        ), 201
    
    except ValidationError:
        raise
    except Exception as e:
        db.session.rollback()
        logger.error(f"❌ 创建服务器失败: {e}", exc_info=True)
        raise InternalServerError("创建服务器失败", str(e))


@servers_bp.put("/<int:sid>")
@jwt_required()
def update_server(sid):
    """
    更新服务器信息
    
    参数：
      sid: 服务器 ID
    
    请求体：
      {
        "name": "New Name" (可选),
        "group": "新分组" (可选),
        "ip": "1.2.3.5" (可选),
        "cpu": 8 (可选),
        "ram": 16.0 (可选),
        "disk": 200 (可选),
        "price": 199.99 (可选),
        "expiry": "2027-12-31" (可选),
        ...
      }
    
    响应：
      {
        "server": { ... },
        "message": "服务器已更新"
      }
    """
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以更新服务器", required_role='admin')
    
    try:
        s = Server.query.get_or_404(sid)
        data = request.get_json(silent=True) or {}
        
        # 记录原始值（用于审计）
        old_values = s.to_dict()
        
        # 可更新字段映射
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
            'traffic_limit': 'traffic_limit_gb',
            'traffic_reset_day': 'traffic_reset_day',
        }
        
        # 遍历可更新字段
        for api_key, db_field in updatable_fields.items():
            if api_key not in data:
                continue
            
            value = data[api_key]
            
            # 单独验证各字段
            if api_key == 'name':
                if not value or not str(value).strip():
                    raise ValidationError("服务器名称不能为空", field='name')
                value = str(value).strip()
                if len(value) > 128:
                    raise ValidationError("服务器名称长度不能超过 128", field='name')
            
            elif api_key == 'cpu':
                value = int(value)
                if value < 1 or value > 256:
                    raise ValidationError("CPU 核心数必须在 1-256 之间", field='cpu')
            
            elif api_key == 'ram':
                value = float(value)
                if value < 0.5 or value > 1024:
                    raise ValidationError("内存大小必须在 0.5-1024 GB 之间", field='ram')
            
            elif api_key == 'disk':
                value = int(value)
                if value < 1 or value > 100000:
                    raise ValidationError("磁盘大小必须在 1-100000 GB 之间", field='disk')
            
            elif api_key == 'price':
                value = float(value)
                if value < 0:
                    raise ValidationError("价格不能为负数", field='price')
            
            elif api_key == 'traffic_limit':
                value = float(value)
                if value < 0:
                    raise ValidationError("流量限制不能为负数", field='traffic_limit')
            
            elif api_key == 'traffic_reset_day':
                value = int(value)
                if value < 1 or value > 31:
                    raise ValidationError("流量重置日期必须在 1-31 之间", field='traffic_reset_day')
            
            setattr(s, db_field, value)
        
        # 单独处理过期日期
        if 'expiry' in data:
            if data['expiry']:
                try:
                    s.expiry = date.fromisoformat(data['expiry'])
                except ValueError:
                    raise ValidationError(
                        "过期日期格式错误，应为 YYYY-MM-DD",
                        field='expiry'
                    )
            else:
                s.expiry = None
        
        db.session.commit()
        
        # 清除缓存
        _invalidate_list_cache()
        _invalidate_groups_cache()
        try:
            redis_client.delete(_metrics_key(sid))
        except:
            pass
        
        logger.info(f"✓ 更新服务器成功: ID={sid}")
        
        return jsonify(
            server=s.to_dict(),
            message="服务器已更新"
        ), 200
    
    except ValidationError:
        raise
    except Exception as e:
        db.session.rollback()
        logger.error(f"❌ 更新服务器失败: {e}", exc_info=True)
        raise InternalServerError("更新服务器失败", str(e))


@servers_bp.delete("/<int:sid>")
@jwt_required()
def delete_server(sid):
    """
    删除服务器
    
    参数：
      sid: 服务器 ID
    
    响应：
      {
        "message": "服务器已删除",
        "id": 1
      }
    """
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以删除服务器", required_role='admin')
    
    try:
        s = Server.query.get_or_404(sid)
        server_name = s.name
        
        db.session.delete(s)
        db.session.commit()
        
        # 清除缓存
        _invalidate_list_cache()
        _invalidate_groups_cache()
        try:
            redis_client.delete(_metrics_key(sid))
        except:
            pass
        
        logger.info(f"✓ 删除服务器成功: ID={sid}, Name={server_name}")
        
        return jsonify(
            message=f"服务器 '{server_name}' 已删除",
            id=sid
        ), 200
    
    except Exception as e:
        db.session.rollback()
        logger.error(f"❌ 删除服务器失败: {e}", exc_info=True)
        raise InternalServerError("删除服务器失败", str(e))


@servers_bp.post("/<int:sid>/metrics")
@jwt_required()
def push_metrics(sid):
    """
    推送实时指标
    
    参数：
      sid: 服务器 ID
    
    请求体：
      {
        "cpu_use": 45.2 (可选),
        "ram_use": 62.1 (可选),
        "disk_use": 78.5 (可选),
        "net_up": 125.4 (可选),
        "net_down": 456.8 (可选),
        "status": "online" (可选),
        "uptime": "10 days 5:30" (可选),
        "latency_ms": 25 (可选)
      }
    
    响应：
      {
        "message": "ok",
        "metrics": { ... }
      }
    """
    try:
        s = Server.query.get_or_404(sid)
        data = request.get_json(silent=True) or {}
        
        # ✅ 解析和验证指标
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
        
        # ✅ 范围验证
        if not (0 <= metrics["cpu_use"] <= 100):
            raise ValidationError(
                "CPU 使用率必须在 0-100 之间",
                field='cpu_use',
                value=metrics["cpu_use"]
            )
        if not (0 <= metrics["ram_use"] <= 100):
            raise ValidationError(
                "内存使用率必须在 0-100 之间",
                field='ram_use',
                value=metrics["ram_use"]
            )
        if not (0 <= metrics["disk_use"] <= 100):
            raise ValidationError(
                "磁盘使用率必须在 0-100 之间",
                field='disk_use',
                value=metrics["disk_use"]
            )
        
        # 1️⃣ 存储到 Redis（短期缓存）
        ttl = current_app.config.get("PROBE_CACHE_TTL", 15)
        try:
            redis_client.setex(
                _metrics_key(sid),
                ttl,
                json.dumps(metrics, ensure_ascii=False, default=str)
            )
            logger.debug(f"✓ 指标已写入 Redis: {sid}")
        except Exception as e:
            logger.warning(f"⚠️ Redis 写入失败: {e}")
        
        # 2️⃣ 存储到 MySQL（持久化）
        try:
            # 更新服务器当前指标
            for k, v in metrics.items():
                setattr(s, k, v)
            
            # 创建历史记录
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
            
            logger.info(f"✓ 指标已保存: Server {sid}")
            
            # 清除列表缓存（因为服务器状态可能改变）
            _invalidate_list_cache()
        
        except Exception as e:
            db.session.rollback()
            raise InternalServerError("保存指标失败", str(e))
        
        return jsonify(msg="ok", metrics=metrics), 200
    
    except ValidationError:
        raise
    except Exception as e:
        logger.error(f"❌ 推送指标失败: {e}", exc_info=True)
        raise InternalServerError("推送指标失败", str(e))


@servers_bp.get("/<int:sid>/history")
@jwt_required()
def get_server_history(sid):
    """
    获取服务器历史数据
    
    参数：
      sid: 服务器 ID
    
    查询参数：
      - days: 查询天数（1-30，默认 7）
      - limit: 结果数限制（1-10000，默认 1000）
    
    响应：
      {
        "data": [
          {
            "timestamp": "2026-04-08T10:30:00",
            "cpu_use": 45.2,
            "ram_use": 62.1,
            "disk_use": 78.5,
            "net_up": 125.4,
            "net_down": 456.8,
            "latency_ms": 25
          }
        ],
        "count": 100,
        "server_id": 1,
        "days": 7
      }
    """
    try:
        # ✅ 验证查询参数
        try:
            days = max(1, min(int(request.args.get('days', 7)), 30))
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
        ).order_by(ProbeResult.created_at.desc()).limit(limit).all()
        
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
                    'latency_ms': float(r.latency_ms) if r.latency_ms is not None else 0,
                })
            except Exception as e:
                logger.warning(f"⚠️ 数据格式化失败: {e}")
                continue
        
        logger.info(f"✓ 查询历史数据: Server {sid}, Days={days}, Count={len(data)}")
        
        return jsonify(
            data=data,
            count=len(data),
            server_id=sid,
            days=days,
            timestamp=datetime.utcnow().isoformat(),
        ), 200
    
    except ValidationError:
        raise
    except Exception as e:
        logger.error(f"❌ 获取历史数据失败: {e}", exc_info=True)
        raise InternalServerError("获取历史数据失败", str(e))


@servers_bp.get("/groups")
def list_groups():
    """
    获取所有服务器分组
    
    响应：
      {
        "groups": ["生产环境", "测试环境", "开发环境"],
        "count": 3
      }
    """
    try:
        # 尝试从缓存获取
        try:
            cached = redis_client.get(_groups_key())
            if cached:
                groups = json.loads(cached)
                return jsonify(
                    groups=groups,
                    count=len(groups),
                    from_cache=True,
                ), 200
        except:
            pass
        
        # 从数据库查询
        rows = db.session.query(Server.group_name).distinct().order_by(Server.group_name).all()
        groups = [r[0] for r in rows if r[0]]
        
        # 缓存结果
        try:
            redis_client.setex(
                _groups_key(),
                3600,
                json.dumps(groups, ensure_ascii=False)
            )
        except:
            pass
        
        logger.info(f"✓ 获取分组列表: {len(groups)} 个")
        
        return jsonify(
            groups=groups,
            count=len(groups),
            from_cache=False,
        ), 200
    
    except Exception as e:
        logger.error(f"❌ 获取分组列表失败: {e}", exc_info=True)
        raise InternalServerError("获取分组列表失败", str(e))
