"""
/api/aff - AFF 市场 API
公开读取，管理员写入
"""
import json
import logging
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt
import extensions
from extensions import db
from models.models import AffProduct
from utils.errors import ValidationError, AuthorizationError, InternalServerError

logger = logging.getLogger(__name__)
aff_bp = Blueprint("aff", __name__)

CACHE_KEY = "vps:aff:list"
CACHE_TTL = 300  # 5 分钟缓存


def _invalidate_cache():
    try:
        extensions.redis_client.delete(CACHE_KEY)
    except Exception:
        pass


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

        products = query.order_by(AffProduct.sort_order.asc(), AffProduct.id.asc()).all()
        result = [p.to_dict() for p in products]

        if not request.args:
            try:
                extensions.redis_client.setex(CACHE_KEY, CACHE_TTL, json.dumps(result, ensure_ascii=False, default=str))
            except Exception:
                pass

        return jsonify(products=result, count=len(result), from_cache=False), 200

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

    p = AffProduct(
        provider=provider,
        stock=data.get("stock", "avail"),
        cpu=data.get("cpu", ""),
        ram=data.get("ram", ""),
        disk=data.get("disk", ""),
        bandwidth=data.get("bandwidth", ""),
        location=data.get("location", ""),
        price=float(data.get("price", 0)),
        currency=data.get("currency", "CNY"),
        period=data.get("period", "monthly"),
        buy_url=data.get("buy_url", ""),
        review_url=data.get("review_url", ""),
        note=data.get("note", ""),
        sort_order=int(data.get("sort_order", 100)),
        enabled=bool(data.get("enabled", True)),
    )
    db.session.add(p)
    db.session.commit()
    _invalidate_cache()
    return jsonify(product=p.to_dict(), message="商品创建成功"), 201


@aff_bp.put("/<int:pid>")
@jwt_required()
def update_product(pid):
    """管理员：更新 AFF 商品"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        raise AuthorizationError("只有管理员可以更新商品", required_role="admin")

    p = AffProduct.query.get_or_404(pid)
    data = request.get_json(silent=True) or {}

    fields = ["provider", "stock", "cpu", "ram", "disk", "bandwidth", "location",
              "currency", "period", "buy_url", "review_url", "note"]
    for f in fields:
        if f in data:
            setattr(p, f, data[f])
    if "price" in data:
        p.price = float(data["price"])
    if "sort_order" in data:
        p.sort_order = int(data["sort_order"])
    if "enabled" in data:
        p.enabled = bool(data["enabled"])

    db.session.commit()
    _invalidate_cache()
    return jsonify(product=p.to_dict(), message="商品已更新"), 200


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
