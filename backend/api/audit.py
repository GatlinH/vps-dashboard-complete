"""
/api/audit - 操作审计日志 API
需要管理员或只读（viewer）权限
"""
import logging
from flask import Blueprint, request, jsonify
from extensions import db
from models.audit_log import AuditLog
from middleware.rbac import viewer_or_admin_required

logger = logging.getLogger(__name__)
audit_bp = Blueprint("audit", __name__)


@audit_bp.get("/")
@viewer_or_admin_required
def list_audit_logs():
    """获取审计日志列表（管理员或只读用户）"""
    page = request.args.get("page", 1, type=int)
    per_page = min(request.args.get("per_page", 20, type=int), 100)
    username = request.args.get("username")
    action = request.args.get("action")

    query = AuditLog.query.order_by(AuditLog.created_at.desc())

    if username:
        query = query.filter(AuditLog.username.ilike(f"%{username}%"))
    if action:
        query = query.filter_by(action=action)

    pagination = query.paginate(page=page, per_page=per_page, error_out=False)
    logs = [log.to_dict() for log in pagination.items]

    return jsonify(
        logs=logs,
        total=pagination.total,
        page=page,
        per_page=per_page,
        pages=pagination.pages,
    ), 200


@audit_bp.get("/<int:log_id>")
@viewer_or_admin_required
def get_audit_log(log_id):
    """获取单条审计日志（管理员或只读用户）"""
    log = AuditLog.query.get_or_404(log_id)
    return jsonify(log=log.to_dict()), 200
