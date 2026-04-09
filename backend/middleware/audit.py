# backend/middleware/audit.py - 审计中间件

"""
审计中间件 - 记录所有重要操作
"""
import logging
from flask import request, g
from datetime import datetime
from functools import wraps
from extensions import db
from models.audit_log import AuditLog
from flask_jwt_extended import get_jwt_identity

logger = logging.getLogger(__name__)


class AuditMiddleware:
    """审计中间件"""
    
    # 需要审计的操作
    AUDITED_METHODS = {'POST', 'PUT', 'DELETE', 'PATCH'}
    
    # 忽略的端点
    IGNORED_PATHS = {
        '/health',
        '/metrics',
        '/api/auth/login',
    }
    
    def __init__(self, app=None):
        self.app = app
        if app:
            self.init_app(app)
    
    def init_app(self, app):
        """初始化中间件"""
        
        @app.before_request
        def before_request():
            """记录请求开始时间"""
            g.start_time = datetime.utcnow()
            g.request_id = request.headers.get('X-Request-ID', f"{datetime.utcnow().timestamp()}")
        
        @app.after_request
        def after_request(response):
            """记录审计日志"""
            try:
                # 检查是否需要审计
                if not self._should_audit():
                    return response
                
                # 提取用户信息
                try:
                    user_id = get_jwt_identity()
                    username = f"user_{user_id}"
                except:
                    user_id = None
                    username = 'anonymous'
                
                # 构建审计记录
                audit_log = AuditLog(
                    user_id=int(user_id) if user_id else None,
                    username=username,
                    action=self._get_action(request.path, request.method),
                    resource_type=self._get_resource_type(request.path),
                    resource_id=self._get_resource_id(request),
                    method=request.method,
                    endpoint=request.path,
                    status_code=response.status_code,
                    success=response.status_code < 400,
                    ip_address=self._get_client_ip(),
                    user_agent=request.user_agent.string[:255] if request.user_agent else None,
                    created_at=g.start_time,
                )
                
                db.session.add(audit_log)
                db.session.commit()
            
            except Exception as e:
                logger.warning(f"⚠️ 审计日志记录失败: {e}")
                db.session.rollback()
            
            return response
    
    def _should_audit(self) -> bool:
        """判断是否需要审计"""
        # 只审计修改操作
        if request.method not in self.AUDITED_METHODS:
            return False
        
        # 忽略特定路径
        if request.path in self.IGNORED_PATHS:
            return False
        
        return True
    
    def _get_action(self, path: str, method: str) -> str:
        """获取操作类型"""
        action_map = {
            'POST': 'CREATE',
            'PUT': 'UPDATE',
            'DELETE': 'DELETE',
            'PATCH': 'UPDATE',
        }
        return action_map.get(method, 'UNKNOWN')
    
    def _get_resource_type(self, path: str) -> str:
        """获取资源类型"""
        if '/servers' in path:
            return 'Server'
        elif '/probe' in path:
            return 'Probe'
        elif '/telegram' in path:
            return 'Telegram'
        elif '/alerts' in path:
            return 'Alert'
        elif '/auth' in path:
            return 'User'
        else:
            return 'Unknown'
    
    def _get_resource_id(self, request) -> str:
        """获取资源 ID"""
        try:
            # 从 URL 路径提取 ID
            parts = request.path.split('/')
            for i, part in enumerate(parts):
                if part.isdigit():
                    return part
            
            # 从 JSON 请求体提取 ID
            data = request.get_json(silent=True)
            if data and 'id' in data:
                return str(data['id'])
        
        except Exception:
            pass
        
        return 'unknown'
    
    def _get_client_ip(self) -> str:
        """获取客户端 IP"""
        if request.environ.get('HTTP_X_FORWARDED_FOR'):
            return request.environ['HTTP_X_FORWARDED_FOR'].split(',')[0].strip()
        return request.remote_addr or 'unknown'
