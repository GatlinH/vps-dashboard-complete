# backend/models/audit_log.py - 审计日志模型

from extensions import db
from datetime import datetime

class AuditLog(db.Model):
    """审计日志"""
    __tablename__ = 'audit_logs'
    
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id'), nullable=True)
    username = db.Column(db.String(100))
    
    # 操作信息
    action = db.Column(db.String(50), nullable=False, index=True)  # LOGIN, CREATE, UPDATE, DELETE
    resource_type = db.Column(db.String(50), index=True)  # SERVER, USER, CONFIG
    resource_id = db.Column(db.String(100), index=True)
    
    # 请求信息
    method = db.Column(db.String(10))  # GET, POST, PUT, DELETE
    endpoint = db.Column(db.String(255))
    status_code = db.Column(db.Integer)
    
    # 结果
    success = db.Column(db.Boolean, default=True)
    error_message = db.Column(db.Text)
    
    # 详细信息
    old_values = db.Column(db.JSON)  # 修改前的值
    new_values = db.Column(db.JSON)  # 修改后的值
    
    # 元数据
    ip_address = db.Column(db.String(50))
    user_agent = db.Column(db.Text)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    
    def to_dict(self):
        return {
            'id': self.id,
            'user_id': self.user_id,
            'username': self.username,
            'action': self.action,
            'resource_type': self.resource_type,
            'resource_id': self.resource_id,
            'method': self.method,
            'endpoint': self.endpoint,
            'status_code': self.status_code,
            'success': self.success,
            'error_message': self.error_message,
            'old_values': self.old_values,
            'new_values': self.new_values,
            'ip_address': self.ip_address,
            'created_at': self.created_at.isoformat(),
        }


# backend/middleware/audit.py - 审计中间件

from flask import request, g
from models.audit_log import AuditLog
from extensions import db
from datetime import datetime
import json
from flask_jwt_extended import get_jwt_identity

class AuditMiddleware:
    """审计中间件"""
    
    def __init__(self, app):
        self.app = app
        app.before_request(self.before_request)
        app.after_request(self.after_request)
    
    def before_request(self):
        """请求前记录"""
        g.audit = {
            'start_time': datetime.utcnow(),
            'method': request.method,
            'endpoint': request.endpoint,
            'path': request.path,
            'ip_address': self._get_client_ip(),
            'user_agent': request.user_agent.string,
            'user_id': None,
            'username': None,
        }
        
        try:
            user_id = get_jwt_identity()
            g.audit['user_id'] = user_id
        except:
            pass
    
    def after_request(self, response):
        """请求后记录"""
        if not hasattr(g, 'audit'):
            return response
        
        # 不记录静态资源
        if request.endpoint and request.endpoint.startswith('static'):
            return response
        
        # 不记录健康检查
        if request.path == '/health':
            return response
        
        try:
            # 记录修改操作
            if request.method in ['POST', 'PUT', 'DELETE']:
                log = AuditLog(
                    user_id=g.audit['user_id'],
                    username=g.audit['username'],
                    action=self._get_action(request.method, request.endpoint),
                    resource_type=self._get_resource_type(request.endpoint),
                    resource_id=self._get_resource_id(request),
                    method=request.method,
                    endpoint=request.endpoint,
                    status_code=response.status_code,
                    success=200 <= response.status_code < 300,
                    ip_address=g.audit['ip_address'],
                    user_agent=g.audit['user_agent'][:500],
                )
                
                if request.method in ['PUT', 'DELETE']:
                    log.old_values = request.get_json(silent=True)
                
                db.session.add(log)
                db.session.commit()
        
        except Exception as e:
            print(f"审计日志记录失败: {e}")
        
        return response
    
    @staticmethod
    def _get_client_ip():
        """获取客户端 IP"""
        if request.headers.get('X-Forwarded-For'):
            return request.headers.get('X-Forwarded-For').split(',')[0].strip()
        return request.remote_addr
    
    @staticmethod
    def _get_action(method, endpoint):
        """获取操作类型"""
        if method == 'POST':
            return 'CREATE'
        elif method == 'PUT':
            return 'UPDATE'
        elif method == 'DELETE':
            return 'DELETE'
        return 'UNKNOWN'
    
    @staticmethod
    def _get_resource_type(endpoint):
        """获取资源类型"""
        if not endpoint:
            return 'UNKNOWN'
        if 'server' in endpoint:
            return 'SERVER'
        elif 'user' in endpoint:
            return 'USER'
        elif 'config' in endpoint:
            return 'CONFIG'
        return 'UNKNOWN'
    
    @staticmethod
    def _get_resource_id(req):
        """获取资源 ID"""
        if req.view_args and 'sid' in req.view_args:
            return str(req.view_args['sid'])
        if req.view_args and 'uid' in req.view_args:
            return str(req.view_args['uid'])
        return None


# backend/api/audit.py - 审计日志 API

from flask import Blueprint, request, jsonify
from flask_jwt_extended import jwt_required, get_jwt
from models.audit_log import AuditLog
from extensions import db
from utils.errors import AuthorizationError
from middleware.validators import RequestValidator

audit_bp = Blueprint('audit', __name__)

@audit_bp.get('/logs')
@jwt_required()
def get_audit_logs():
    """获取审计日志（仅管理员）"""
    claims = get_jwt()
    if claims.get('role') != 'admin':
        raise AuthorizationError(required_role='admin')
    
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 50, type=int)
    per_page = min(per_page, 100)
    
    # 过滤条件
    query = AuditLog.query
    
    if request.args.get('action'):
        query = query.filter_by(action=request.args.get('action'))
    
    if request.args.get('resource_type'):
        query = query.filter_by(resource_type=request.args.get('resource_type'))
    
    if request.args.get('username'):
        query = query.filter_by(username=request.args.get('username'))
    
    if request.args.get('success'):
        success = request.args.get('success').lower() == 'true'
        query = query.filter_by(success=success)
    
    # 排序
    query = query.order_by(AuditLog.created_at.desc())
    
    # 分页
    paginated = query.paginate(page=page, per_page=per_page)
    
    return jsonify({
        'logs': [log.to_dict() for log in paginated.items],
        'total': paginated.total,
        'pages': paginated.pages,
        'current_page': page,
    })

@audit_bp.post('/log')
@jwt_required()
def create_audit_log():
    """创建审计日志"""
    data = request.get_json(silent=True) or {}
    
    try:
        log = AuditLog(
            user_id=get_jwt().get('sub'),
            username=data.get('username'),
            action=data.get('action'),
            resource_type=data.get('resourceType'),
            resource_id=data.get('resourceId'),
            success=data.get('status') == 'success',
            error_message=data.get('errorMessage'),
            ip_address=request.remote_addr,
            user_agent=request.user_agent.string[:500],
        )
        
        db.session.add(log)
        db.session.commit()
        
        return jsonify({'success': True, 'id': log.id})
    
    except Exception as e:
        db.session.rollback()
        return jsonify({'success': False, 'error': str(e)}), 500

@audit_bp.get('/logs/export')
@jwt_required()
def export_audit_logs():
    """导出审计日志为 CSV"""
    claims = get_jwt()
    if claims.get('role') != 'admin':
        raise AuthorizationError(required_role='admin')
    
    logs = AuditLog.query.order_by(AuditLog.created_at.desc()).limit(10000).all()
    
    csv_data = "用户,操作,资源类型,资源ID,状态,IP地址,创建时间\n"
    for log in logs:
        csv_data += f'{log.username},{log.action},{log.resource_type},{log.resource_id},'
        csv_data += f'{"成功" if log.success else "失败"},{log.ip_address},{log.created_at.isoformat()}\n'
    
    return csv_data, 200, {
        'Content-Disposition': 'attachment; filename=audit_logs.csv',
        'Content-Type': 'text/csv; charset=utf-8',
    }
