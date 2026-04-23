"""
/api/aff - AFF 市场 API
公开读取，管理员写入
"""
import json
import logging
from urllib.parse import urlparse
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt
import extensions
from extensions import db
from models.models import AffProduct
from utils.errors import ValidationError, AuthorizationError, InternalServerError
from utils.validators import match_domain_whitelist

logger = logging.getLogger(__name__)
aff_bp = Blueprint("aff", __name__)

_AFF_FIELD_MAX_LEN = {
    "provider": 128, "stock": 16, "cpu": 64, "ram": 64,
    "disk": 64, "bandwidth": 64, "location": 128,
    "currency": 8, "period": 16, "buy_url": 512,
    "review_url": 512, "note": 2000, "group_name": 64,
}

CACHE_KEY = "vps:aff:list"
CACHE_TTL = 300  # 5 分钟缓存


def _invalidate_cache():
    try:
        extensions.redis_client.delete(CACHE_KEY)
    except Exception:
        pass


def _preferred_lang():
    lang = (request.accept_languages.best_match(["zh", "en"]) or "zh").strip().lower()
    return "en" if lang.startswith("en") else "zh"


def _is_trusted_url(url: str):
    if not url:
        return True, "", True
    ok, host = match_domain_whitelist(url, current_app.config.get("AFF_TRUSTED_DOMAINS", []))
    return ok, host, bool(urlparse(url).scheme in ("http", "https"))


def _normalize_i18n(data: dict):
    i18n = data.get("i18n")
    if i18n is None:
        return {}
    if not isinstance(i18n, dict):
        raise ValidationError("i18n 必须是对象", field="i18n")
    safe = {}
    for lang, payload in i18n.items():
        if lang not in ("zh", "en") or not isinstance(payload, dict):
            continue
        safe[lang] = {
            "provider": str((payload.get("provider") or "")).strip()[:128],
            "note": str((payload.get("note") or "")).strip()[:2000],
        }
    return safe


def _enforce_url_policy(data: dict):
    policy = (current_app.config.get("AFF_DOMAIN_POLICY", "strict") or "strict").lower()
    warnings = []
    for field in ("buy_url", "review_url"):
        val = (data.get(field) or "").strip()
        if not val:
            continue
        matched, host, has_valid_scheme = _is_trusted_url(val)
        if not has_valid_scheme:
            raise ValidationError(f"{field} 仅允许 http/https URL", field=field)
        if not matched:
            msg = f"{field} 域名 {host or '未知'} 不在白名单"
            if policy == "strict":
                raise ValidationError(f"{msg}，当前策略为 strict，禁止保存", field=field)
            warnings.append(msg)
    return warnings


@aff_bp.get("/")
def list_products():
    """公开接口：获取 AFF 商品列表，支持 stock/provider 过滤"""
    try:
        cached = None
        try:
            raw = extensions.redis_client.get(CACHE_KEY)
            if raw:
                cached = json.loads(raw)
        except Exception:
            pass

        if cached and not request.args:
            return jsonify(products=cached, count=len(cached), from_cache=True), 200

        query = AffProduct.query.filter_by(enabled=True)
        if request.args.get("stock"):
            query = query.filter_by(stock=request.args["stock"])
        if request.args.get("provider"):
            query = query.filter(AffProduct.provider.ilike(f"%{request.args['provider']}%"))

        if request.args.get("group_name"):
            query = query.filter_by(group_name=request.args["group_name"])
        products = query.order_by(AffProduct.group_name.asc(), AffProduct.sort_order.asc(), AffProduct.id.asc()).all()
        lang = _preferred_lang()
        result = []
        for p in products:
            item = p.to_dict(lang=lang)
            trusted_buy, _, _ = _is_trusted_url(item.get("buy_url"))
            trusted_review, _, _ = _is_trusted_url(item.get("review_url"))
            item["is_trusted_buy_url"] = trusted_buy
            item["is_trusted_review_url"] = trusted_review
            result.append(item)

        if not request.args:
            try:
                extensions.redis_client.setex(CACHE_KEY, CACHE_TTL, json.dumps(result, ensure_ascii=False, default=str))
            except Exception:
                pass

        return jsonify(products=result, count=len(result), lang=lang, from_cache=False), 200

    except Exception as e:
        logger.error(f"获取 AFF 列表失败: {e}", exc_info=True)
        raise InternalServerError("获取商品列表失败", str(e))


@aff_bp.post("/")
@jwt_required()
def create_product():
    """管理员：创建 AFF 商品"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以创建商品", required_role="admin")

    data = request.get_json(silent=True) or {}
    provider = (data.get("provider") or "").strip()
    if not provider:
        raise ValidationError("服务商名称不能为空", field="provider")

    for field, max_len in _AFF_FIELD_MAX_LEN.items():
        val = data.get(field)
        if val is not None and len(str(val)) > max_len:
            raise ValidationError(f"{field} 超过最大长度 {max_len} 个字符", field=field)
    warnings = _enforce_url_policy(data)
    i18n = _normalize_i18n(data)

    p = AffProduct(
        provider=provider,
        stock=data.get("stock", "avail"),
        cpu=data.get("cpu", ""),
        ram=data.get("ram", ""),
        disk=data.get("disk", ""),
        bandwidth=data.get("bandwidth", ""),
        location=data.get("location", ""),
        group_name=data.get("group_name", "默认分组"),
        price=float(data.get("price", 0)),
        currency=data.get("currency", "CNY"),
        period=data.get("period", "monthly"),
        buy_url=data.get("buy_url", ""),
        review_url=data.get("review_url", ""),
        note=data.get("note", ""),
        i18n=i18n,
        sort_order=int(data.get("sort_order", 100)),
        enabled=bool(data.get("enabled", True)),
    )
    db.session.add(p)
    db.session.commit()
    _invalidate_cache()
    return jsonify(product=p.to_dict(lang=_preferred_lang()), warnings=warnings, message="商品创建成功"), 201


@aff_bp.put("/<int:pid>")
@jwt_required()
def update_product(pid):
    """管理员：更新 AFF 商品"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以更新商品", required_role="admin")

    p = AffProduct.query.get_or_404(pid)
    data = request.get_json(silent=True) or {}
    warnings = _enforce_url_policy(data)

    for f, max_len in _AFF_FIELD_MAX_LEN.items():
        if f in data:
            val = data[f]
            if val is not None and len(str(val)) > max_len:
                raise ValidationError(f"{f} 超过最大长度 {max_len} 个字符", field=f)
            setattr(p, f, val)
    if "i18n" in data:
        p.i18n = _normalize_i18n(data)
    if "price" in data:
        p.price = float(data["price"])
    if "sort_order" in data:
        p.sort_order = int(data["sort_order"])
    if "enabled" in data:
        p.enabled = bool(data["enabled"])

    db.session.commit()
    _invalidate_cache()
    return jsonify(product=p.to_dict(lang=_preferred_lang()), warnings=warnings, message="商品已更新"), 200


@aff_bp.delete("/<int:pid>")
@jwt_required()
def delete_product(pid):
    """管理员：删除 AFF 商品"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以删除商品", required_role="admin")

    p = AffProduct.query.get_or_404(pid)
    db.session.delete(p)
    db.session.commit()
    _invalidate_cache()
    return jsonify(message="商品已删除", id=pid), 200
