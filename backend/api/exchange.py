"""
/api/exchange - 汇率查询 & 交易估值
GET  /api/exchange/rates?base=CNY        公开接口，带 Redis 1 小时缓存
POST /api/exchange/estimate              估值接口，计算剩余价值与建议售价
"""
import json
import logging
from datetime import date, timedelta
from flask import Blueprint, jsonify, request
import requests as req
from extensions import redis_client

logger = logging.getLogger(__name__)
exchange_bp = Blueprint("exchange", __name__)

CACHE_TTL = 3600  # 1 小时

# ──────────────────────────────────────────────────────────────────────────────
# 估值辅助函数
# ──────────────────────────────────────────────────────────────────────────────

# 周期别名映射到标准名称
_PERIOD_ALIAS = {
    "monthly": "monthly", "1": "monthly",
    "quarterly": "quarterly", "3": "quarterly",
    "yearly": "yearly", "12": "yearly",
}

# 标准名称 → 天数
_PERIOD_DAYS = {"monthly": 30, "quarterly": 92, "yearly": 365}


def _normalize_period(raw):
    """将 monthly|quarterly|yearly|1|3|12 统一为标准名称，非法值返回 None。"""
    return _PERIOD_ALIAS.get(str(raw).strip().lower())


def _period_to_days(period):
    """返回周期对应天数（period 必须是已标准化的名称）。"""
    return _PERIOD_DAYS[period]


def _parse_date(value, field_name):
    """将 YYYY-MM-DD 字符串解析为 date，格式有误时抛出 ValueError。"""
    if not isinstance(value, str) or len(value) != 10 or value[4] != '-' or value[7] != '-':
        raise ValueError(f"{field_name} 格式有误，需为 YYYY-MM-DD")
    try:
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise ValueError(f"{field_name} 格式有误，需为 YYYY-MM-DD")


def _round_amount(value):
    """将金额四舍五入到整数（与前端 toFixed(0) 对齐）。"""
    return round(value)


# ──────────────────────────────────────────────────────────────────────────────
# 路由
# ──────────────────────────────────────────────────────────────────────────────

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


@exchange_bp.post("/estimate")
def estimate():
    """
    POST /api/v1/exchange/estimate
    计算服务器剩余价值与建议售价。

    请求体（JSON）：
      price           float  必填，>= 0
      period          str    monthly|quarterly|yearly 或 1|3|12
      buy_date        str    YYYY-MM-DD，可选
      expiry          str    YYYY-MM-DD，可选（buy_date/expiry 至少一个）
      premium_percent float  溢价百分比，默认 0，>= 0
    """
    body = request.get_json(silent=True) or {}

    # ── 参数提取与校验 ────────────────────────────────────────────────────────

    # price
    if "price" not in body:
        return jsonify(ok=False, error="price 为必填项"), 400
    try:
        price = float(body["price"])
    except (ValueError, TypeError):
        return jsonify(ok=False, error="price 必须为数字"), 400
    if price < 0:
        return jsonify(ok=False, error="price 不能为负数"), 400

    # period
    raw_period = body.get("period", "monthly")
    period = _normalize_period(raw_period)
    if period is None:
        return jsonify(ok=False, error="period 非法，支持 monthly|quarterly|yearly 或 1|3|12"), 400
    total_days = _period_to_days(period)

    # buy_date / expiry
    raw_buy = body.get("buy_date")
    raw_exp = body.get("expiry")

    if not raw_buy and not raw_exp:
        return jsonify(ok=False, error="buy_date 和 expiry 至少需提供一个"), 400

    try:
        if raw_buy and raw_exp:
            buy_date = _parse_date(raw_buy, "buy_date")
            expiry = _parse_date(raw_exp, "expiry")
            if expiry < buy_date:
                return jsonify(ok=False, error="expiry 不能早于 buy_date"), 400
        elif raw_buy:
            buy_date = _parse_date(raw_buy, "buy_date")
            expiry = buy_date + timedelta(days=total_days)
        else:
            expiry = _parse_date(raw_exp, "expiry")
            buy_date = expiry - timedelta(days=total_days)
    except ValueError as exc:
        # exc は _parse_date() が生成した制御済みメッセージのみ
        msg = exc.args[0] if exc.args else "日期参数有误"
        return jsonify(ok=False, error=msg), 400

    # premium_percent
    raw_premium = body.get("premium_percent", 0)
    try:
        premium_percent = float(raw_premium)
    except (ValueError, TypeError):
        return jsonify(ok=False, error="premium_percent 必须为数字"), 400
    if premium_percent < 0:
        return jsonify(ok=False, error="premium_percent 不能为负数"), 400

    # ── 估值计算 ──────────────────────────────────────────────────────────────

    try:
        today = date.today()
        days_used = max(0, (today - buy_date).days)
        days_left = max(0, (expiry - today).days)
        daily_rate = price / total_days if total_days else 0
        consumed_value = _round_amount(min(price, daily_rate * days_used))
        residual_value = _round_amount(max(0.0, daily_rate * days_left))
        suggested_price = _round_amount(residual_value * (1 + premium_percent / 100))
        residual_percent = max(0, min(100, round(days_left / total_days * 100))) if total_days else 0

        data = {
            "price": price,
            "period": period,
            "buy_date": buy_date.isoformat(),
            "expiry": expiry.isoformat(),
            "total_days": total_days,
            "days_used": days_used,
            "days_left": days_left,
            "daily_rate": round(daily_rate, 2),
            "consumed_value": consumed_value,
            "residual_value": residual_value,
            "premium_percent": premium_percent,
            "suggested_price": suggested_price,
            "residual_percent": residual_percent,
        }
        return jsonify(ok=True, data=data), 200

    except Exception as exc:  # pragma: no cover
        logger.exception(f"估值计算失败: {exc}")
        return jsonify(ok=False, error="服务器内部错误，请稍后重试"), 500
