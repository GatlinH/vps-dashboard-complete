# backend/models/audit_log.py - 审计日志模型

from extensions import db
from datetime import datetime, timezone

class AuditLog(db.Model):
    """审计日志"""
    __tablename__ = 'audit_logs'
    
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
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
    
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    
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
