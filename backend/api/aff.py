import json
import logging
from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt
from extensions import db, redis_client
from models.aff_product import AffProduct
from utils.errors import ValidationError, AuthorizationError, InternalServerError

logger = logging.getLogger(__name__)
aff_bp = Blueprint("aff", __name__)
CACHE_KEY = "vps:aff:list"
CACHE_TTL = 300


def _invalidate_cache():
    try:
        redis_client.delete(CACHE_KEY)
    except Exception:
        pass


@aff_bp.get("/")
def list_products():
    try:
        if not request.args:
            try:
                raw = redis_client.get(CACHE_KEY)
                if raw:
                    data = json.loads(raw)
                    return jsonify(products=data, count=len(data), from_cache=True), 200
            except Exception:
                pass
        query = AffProduct.query.filter_by(enabled=True)
        if request.args.get("stock"):
            query = query.filter_by(stock=request.args["stock"])
        if request.args.get("provider"):
            query = query.filter(AffProduct.provider.ilike(f"%{request.args['provider']}%"))
        products = query.order_by(AffProduct.sort_order.asc()).all()
        result = [p.to_dict() for p in products]
        if not request.args:
            try:
                redis_client.setex(CACHE_KEY, CACHE_TTL, json.dumps(result, ensure_ascii=False, default=str))
            except Exception:
                pass
        return jsonify(products=result, count=len(result), from_cache=False), 200
    except Exception as e:
        raise InternalServerError("获取商品列表失败", str(e))


@aff_bp.post("/")
@jwt_required()
def create_product():
    if get_jwt().get("role") != "admin":
        raise AuthorizationError("需要管理员权限", required_role="admin")
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
    if get_jwt().get("role") != "admin":
        raise AuthorizationError("需要管理员权限", required_role="admin")
    p = AffProduct.query.get_or_404(pid)
    data = request.get_json(silent=True) or {}
    for f in ["provider", "stock", "cpu", "ram", "disk", "bandwidth", "location",
              "currency", "period", "buy_url", "review_url", "note"]:
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
    if get_jwt().get("role") != "admin":
        raise AuthorizationError("需要管理员权限", required_role="admin")
    p = AffProduct.query.get_or_404(pid)
    db.session.delete(p)
    db.session.commit()
    _invalidate_cache()
    return jsonify(message="商品已删除", id=pid), 200
