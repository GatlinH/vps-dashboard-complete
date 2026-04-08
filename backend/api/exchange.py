import json
import logging
import requests as req
from flask import Blueprint, jsonify, request
from extensions import redis_client

logger = logging.getLogger(__name__)
exchange_bp = Blueprint("exchange", __name__)


@exchange_bp.get("/rates")
def get_rates():
    base = request.args.get("base", "CNY").upper()
    cache_key = f"vps:exchange:{base}"
    try:
        cached = redis_client.get(cache_key)
        if cached:
            return jsonify(**json.loads(cached), from_cache=True), 200
    except Exception:
        pass
    try:
        resp = req.get(f"https://open.er-api.com/v6/latest/{base}", timeout=5)
        resp.raise_for_status()
        upstream = resp.json()
        if upstream.get("result") != "success":
            raise ValueError("上游失败")
        rates = {
            k: upstream["rates"][k]
            for k in ["CNY", "USD", "EUR", "GBP", "JPY", "HKD"]
            if k in upstream.get("rates", {})
        }
        payload = {
            "base": base,
            "rates": rates,
            "time_last_update": upstream.get("time_last_update_utc", ""),
        }
        try:
            redis_client.setex(cache_key, 3600, json.dumps(payload, ensure_ascii=False))
        except Exception:
            pass
        return jsonify(**payload, from_cache=False), 200
    except Exception as e:
        logger.warning(f"汇率 API 失败: {e}")
        return jsonify(
            base=base,
            rates={"CNY": 1.0, "USD": 0.138, "EUR": 0.127, "GBP": 0.109, "JPY": 20.5, "HKD": 1.08},
            time_last_update="fallback",
            from_cache=False,
            fallback=True,
        ), 200
