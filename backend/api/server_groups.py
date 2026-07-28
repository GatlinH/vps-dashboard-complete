"""Authenticated administration of persisted server groups."""
from flask import Blueprint, jsonify, request
from sqlalchemy.exc import IntegrityError

from extensions import db
from middleware.rbac import admin_required
from models.models import Server, ServerGroup
from services.server_groups import normalize_group_fields
from utils.errors import ConflictError, ResourceNotFoundError, ValidationError

server_groups_bp = Blueprint("server_groups", __name__)


def _write_group(group, data):
    name, purpose, color, sort_order = normalize_group_fields(data, group)
    duplicate = ServerGroup.query.filter(db.func.lower(ServerGroup.name) == name.lower(), ServerGroup.id != group.id).first()
    if duplicate:
        raise ValidationError("分组名称已存在", field="name")
    group.name, group.purpose, group.color, group.sort_order = name, purpose, color, sort_order


@server_groups_bp.get("")
@admin_required
def list_server_groups():
    groups = ServerGroup.query.order_by(ServerGroup.sort_order, ServerGroup.name, ServerGroup.id).all()
    return jsonify(groups=[group.to_public_dict() for group in groups])


@server_groups_bp.post("")
@admin_required
def create_server_group():
    group = ServerGroup()
    _write_group(group, request.get_json(silent=True) or {})
    db.session.add(group)
    try:
        db.session.commit()
    except IntegrityError:
        db.session.rollback()
        raise ValidationError("分组名称已存在", field="name")
    return jsonify(group=group.to_public_dict()), 201


@server_groups_bp.put("/<int:group_id>")
@admin_required
def update_server_group(group_id):
    group = db.session.get(ServerGroup, group_id)
    if group is None:
        raise ResourceNotFoundError("分组", group_id)
    _write_group(group, request.get_json(silent=True) or {})
    for server in group.servers:
        server.group_name = group.name
    db.session.commit()
    return jsonify(group=group.to_public_dict())


@server_groups_bp.delete("/bulk")
@admin_required
def bulk_delete_server_groups():
    data = request.get_json(silent=True) or {}
    raw_ids = data.get("ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        raise ValidationError("ids 必须是非空数组", field="ids")
    if len(raw_ids) > 100:
        raise ValidationError("一次最多删除 100 个分组", field="ids")
    try:
        ids = sorted({int(value) for value in raw_ids})
    except (TypeError, ValueError):
        raise ValidationError("ids 必须是整数数组", field="ids")
    if any(value <= 0 for value in ids):
        raise ValidationError("ids 必须是正整数数组", field="ids")
    groups = ServerGroup.query.filter(ServerGroup.id.in_(ids)).order_by(ServerGroup.id).all()
    if {group.id for group in groups} != set(ids):
        raise ValidationError("部分分组不存在，未执行删除", field="ids")
    blocked = [group.name for group in groups if Server.query.filter_by(group_id=group.id).first() is not None]
    if blocked:
        raise ConflictError("以下分组仍有关联节点，未执行删除：" + "、".join(blocked), conflicting_field="group_id")
    for group in groups:
        db.session.delete(group)
    db.session.commit()
    return jsonify(success=True, deleted=len(ids), ids=ids)


@server_groups_bp.delete("/<int:group_id>")
@admin_required
def delete_server_group(group_id):
    group = db.session.get(ServerGroup, group_id)
    if group is None:
        raise ResourceNotFoundError("分组", group_id)
    if Server.query.filter_by(group_id=group.id).first() is not None:
        raise ConflictError("分组仍有关联节点，无法删除", conflicting_field="group_id")
    db.session.delete(group)
    db.session.commit()
    return jsonify(success=True)
