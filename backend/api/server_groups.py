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
