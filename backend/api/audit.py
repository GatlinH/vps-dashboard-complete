# backend/api/audit.py - 审计日志 API

"""
/api/audit - 审计日志查询与管理
"""
from datetime import datetime, timedelta
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt
from extensions import db
from models.models import AuditLog
from utils.errors import ValidationError, InternalServerError
from utils.query_helpers import QueryHelper

audit_bp = Blueprint("audit", __name__)


@audit_bp.get('/logs')
@jwt_required()
def list_audit_logs():
    """获取审计日志列表（需要分页）"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        from utils.errors import AuthorizationError
        raise AuthorizationError()
    
    try:
        page, per_page = QueryHelper.get_pagination_params()
        
        query = AuditLog.query
        
        # 过滤条件
        if request.args.get('action'):
            query = query.filter_by(action=request.args.get('action'))
        
        if request.args.get('resource_type'):
            query = query.filter_by(resource_type=request.args.get('resource_type'))
        
        if request.args.get('username'):
            query = query.filter_by(username=request.args.get('username'))
        
        if request.args.get('success'):
            success = request.args.get('success').lower() in ('true', '1', 'yes')
            query = query.filter_by(success=success)
        
        # 时间范围过滤
        if request.args.get('start_date'):
            try:
                start_date = datetime.fromisoformat(request.args.get('start_date'))
                query = query.filter(AuditLog.created_at >= start_date)
            except ValueError:
                pass
        
        if request.args.get('end_date'):
            try:
                end_date = datetime.fromisoformat(request.args.get('end_date'))
                query = query.filter(AuditLog.created_at <= end_date)
            except ValueError:
                pass
        
        # 排序
        query = query.order_by(AuditLog.created_at.desc())
        
        # 分页
        result = QueryHelper.paginate(query, page, per_page)
        
        return jsonify(
            logs=[log.to_dict() for log in result['items']],
            pagination={
                'total': result['total'],
                'pages': result['pages'],
                'current_page': result['current_page'],
                'per_page': result['per_page'],
                'has_next': result['has_next'],
                'has_prev': result['has_prev'],
            }
        )
    
    except Exception as e:
        raise InternalServerError("获取审计日志失败", str(e))


@audit_bp.get('/logs/<int:log_id>')
@jwt_required()
def get_audit_log(log_id):
    """获取单条审计日志详情"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        from utils.errors import AuthorizationError
        raise AuthorizationError()
    
    try:
        log = AuditLog.query.get_or_404(log_id)
        return jsonify(log=log.to_dict())
    
    except Exception as e:
        raise InternalServerError("获取审计日志详情失败", str(e))


@audit_bp.get('/stats')
@jwt_required()
def get_audit_stats():
    """获取审计统计信息"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        from utils.errors import AuthorizationError
        raise AuthorizationError()
    
    try:
        # 最近 7 天的数据
        start_date = datetime.utcnow() - timedelta(days=7)
        
        logs = AuditLog.query.filter(AuditLog.created_at >= start_date).all()
        
        # 按操作分组统计
        action_stats = {}
        for log in logs:
            key = log.action
            if key not in action_stats:
                action_stats[key] = 0
            action_stats[key] += 1
        
        # 按用户分组统计
        user_stats = {}
        for log in logs:
            key = log.username
            if key not in user_stats:
                user_stats[key] = 0
            user_stats[key] += 1
        
        # 成功/失败统计
        success_count = len([log for log in logs if log.success])
        fail_count = len(logs) - success_count
        
        return jsonify(
            total_count=len(logs),
            success_count=success_count,
            fail_count=fail_count,
            success_rate=f"{(success_count / len(logs) * 100):.2f}%" if logs else "0%",
            by_action=action_stats,
            by_user=user_stats,
            period_days=7,
        )
    
    except Exception as e:
        raise InternalServerError("获取审计统计失败", str(e))


@audit_bp.delete('/logs')
@jwt_required()
def delete_audit_logs():
    """清理过期审计日志（仅管理员）"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        from utils.errors import AuthorizationError
        raise AuthorizationError()
    
    try:
        data = request.get_json(silent=True) or {}
        
        # 删除 N 天前的日志
        days = max(30, int(data.get('days', 90)))
        cutoff_date = datetime.utcnow() - timedelta(days=days)
        
        deleted = AuditLog.query.filter(
            AuditLog.created_at < cutoff_date
        ).delete()
        
        db.session.commit()
        
        return jsonify(
            msg=f"已删除 {deleted} 条 {days} 天前的审计日志",
            deleted_count=deleted,
        )
    
    except Exception as e:
        db.session.rollback()
        raise InternalServerError("清理审计日志失败", str(e))


@audit_bp.get('/export')
@jwt_required()
def export_audit_logs():
    """导出审计日志为 CSV"""
    claims = get_jwt()
    if claims.get("role") != "admin":
        from utils.errors import AuthorizationError
        raise AuthorizationError()
    
    try:
        import csv
        from io import StringIO
        
        # 获取所有日志
        logs = AuditLog.query.order_by(AuditLog.created_at.desc()).all()
        
        # 生成 CSV
        output = StringIO()
        writer = csv.writer(output)
        
        # 头部
        writer.writerow([
            'ID', '时间', '用户', '操作', '资源类型', '资源ID',
            '方法', '端点', '状态码', '成功', 'IP地址'
        ])
        
        # 数据行
        for log in logs:
            writer.writerow([
                log.id,
                log.created_at.isoformat(),
                log.username,
                log.action,
                log.resource_type,
                log.resource_id,
                log.method,
                log.endpoint,
                log.status_code,
                '是' if log.success else '否',
                log.ip_address,
            ])
        
        # 返回 CSV
        from flask import send_file
        output.seek(0)
        
        filename = f"audit-logs-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
        
        return send_file(
            StringIO(output.getvalue()),
            mimetype='text/csv',
            as_attachment=True,
            download_name=filename,
        )
    
    except Exception as e:
        raise InternalServerError("导出审计日���失败", str(e))
