"""/api/v1/auth/users 管理员用户管理"""
from flask import Blueprint, jsonify, request
from extensions import db
from models.models import User
from middleware.rate_limit import limiter, READ_LIMIT, WRITE_LIMIT
from middleware.rbac import admin_required, ADMIN_ROLE

users_bp = Blueprint("users", __name__)


@users_bp.get("/")
@limiter.limit(READ_LIMIT)
@admin_required
def list_users():
    role_filter = request.args.get("role", "").strip() or None
    query = User.query
    if role_filter:
        query = query.filter_by(role=role_filter)
    users = query.order_by(User.id).all()
    return jsonify(users=[u.to_dict() for u in users], count=len(users))


@users_bp.patch("/<int:user_id>/role")
@limiter.limit(WRITE_LIMIT)
@admin_required
def assign_user_role(user_id: int):
    data = request.get_json(silent=True) or {}
    new_role = data.get("role", "").strip()
    if not new_role:
        return jsonify(msg="role 字段不能为空"), 400
    if new_role not in {"viewer", "user"}:
        return jsonify(msg=f"非法角色值：{new_role}；可分配角色为 user, viewer"), 400
    target = db.session.get(User, user_id)
    if not target:
        return jsonify(msg="用户不存在"), 404
    if target.role == ADMIN_ROLE:
        return jsonify(msg="不能通过此接口修改 admin 账户角色"), 403
    target.role = new_role
    db.session.commit()
    return jsonify(msg="角色已更新", user=target.to_dict())
