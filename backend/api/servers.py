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
from werkzeug.exceptions import HTTPException  # ✅ 新增导入
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
            return json.loads
