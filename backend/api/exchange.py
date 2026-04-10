"""
/api/exchange - 汇率查询
GET /api/exchange/rates?base=CNY  公开接口，带 Redis 1 小时缓存
"""
import json
import logging
import requests as req
from flask import Blueprint, jsonify, request
from extensions import redis_client

logger = logging.getLogger(__name__)
exchange_bp = Blueprint("exchange", __name__)

CACHE_TTL = 3600  # 1 小时


@exchange_bp.get("/rates")
def get_rates():
    """
    获取汇率，默认以 CNY 为基准
    使用 open.er-api.com 免费 API，Redis 缓存 1 小时
    """
    base = request.args.get("base", "CNY").upper()
    cache_key = f"vps:exchange:{base}"

    # 尝试缓存
    try:
        cached = redis_client.get(cache_key)
        if cached:
            data = json.loads(cached)
            return jsonify(**data, from_cache=True), 200
    except Exception:
        pass

    # 请求上游 API
    try:
        resp = req.get(
            f"https://open.er-api.com/v6/latest/{base}",
            timeout=10
        )
        resp.raise_for_status()
        upstream = resp.json()

        if upstream.get("result") != "success":
            raise ValueError("上游 API 返回失败")

        rates = upstream.get("rates", {})
        # 只保留常用货币
        filtered = {k: rates[k] for k in ["CNY", "USD", "EUR", "GBP", "JPY", "HKD"] if k in rates}

        payload = {
            "base": base,
            "rates": filtered,
            "time_last_update": upstream.get("time_last_update_utc", ""),
        }

        # 写入缓存
        try:
            redis_client.setex(cache_key, CACHE_TTL, json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass

        return jsonify(**payload, from_cache=False), 200

    except Exception as e:
        logger.warning(f"汇率 API 请求失败，使用默认值: {e}")
        # 降级：返回静态默认值
        fallback = {
            "base": base,
            "rates": {"CNY": 1.0, "USD": 0.138, "EUR": 0.127, "GBP": 0.109, "JPY": 20.5, "HKD": 1.08},
            "time_last_update": "fallback",
            "from_cache": False,
            "fallback": True,
        }
        return jsonify(**fallback), 200
