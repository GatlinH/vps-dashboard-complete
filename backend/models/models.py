# backend/models/models.py - 改进版本

"""
数据库模型 - 性能优化版本
添加关键索引和分区策略
"""
from datetime import datetime, date
from extensions import db
from sqlalchemy.dialects.mysql import BIGINT

class User(db.Model):
    __tablename__ = "users"
    
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    role = db.Column(db.String(16), default="admin", index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    last_login = db.Column(db.DateTime)
    
    __table_args__ = (
        db.Index('idx_username_role', 'username', 'role'),
    )
    
    def to_dict(self):
        return dict(
            id=self.id,
            username=self.username,
            role=self.role,
            created_at=self.created_at.isoformat(),
            last_login=self.last_login.isoformat() if self.last_login else None,
        )


class Server(db.Model):
    __tablename__ = "servers"
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(128), nullable=False, index=True)
    group_name = db.Column(db.String(64), default="默认分组", index=True)
    flag = db.Column(db.String(8), default="🌐")
    location = db.Column(db.String(128), default="")
    ip = db.Column(db.String(45), default="", unique=True, index=True)
    
    # 硬件配置
    cpu_cores = db.Column(db.SmallInteger, default=1)
    ram_gb = db.Column(db.Float, default=1.0)
    disk_gb = db.Column(db.Integer, default=20)
    bandwidth = db.Column(db.String(64), default="不限")
    
    # 探针信息
    probe_url = db.Column(db.String(512), default="")
    note = db.Column(db.Text, default="")
    
    # 定价信息
    price = db.Column(db.Float, default=0)
    period = db.Column(db.String(16), default="monthly", index=True)
    expiry = db.Column(db.Date, index=True)
    
    # 实时指标
    cpu_use = db.Column(db.Float, default=0)
    ram_use = db.Column(db.Float, default=0)
    disk_use = db.Column(db.Float, default=0)
    net_up = db.Column(db.Float, default=0)
    net_down = db.Column(db.Float, default=0)
    status = db.Column(db.String(16), default="unknown", index=True)
    uptime = db.Column(db.String(64), default="")
    
    # 流量统计
    traffic_limit_gb = db.Column(db.Float, default=0)
    traffic_up_gb = db.Column(db.Float, default=0)
    traffic_down_gb = db.Column(db.Float, default=0)
    traffic_used_gb = db.Column(db.Float, default=0)
    traffic_reset_day = db.Column(db.SmallInteger, default=1)
    
    # 时间戳
    created_at = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, index=True)
    
    # 复合索引用于常见查询
    __table_args__ = (
        db.Index('idx_group_status', 'group_name', 'status'),
        db.Index('idx_expiry_status', 'expiry', 'status'),
        db.Index('idx_created_at', 'created_at'),
        db.Index('idx_updated_at', 'updated_at'),
    )
    
    def to_dict(self, include_metrics=True):
        d = dict(
            id=self.id,
            name=self.name,
            group=self.group_name,
            flag=self.flag,
            location=self.location,
            ip=self.ip,
            cpu=self.cpu_cores,
            ram=self.ram_gb,
            disk=self.disk_gb,
            bw=self.bandwidth,
            probe=self.probe_url,
            note=self.note,
            price=self.price,
            period=self.period,
            expiry=self.expiry.isoformat() if self.expiry else None,
        )
        
        if include_metrics:
            d.update(dict(
                cpu_use=round(self.cpu_use, 2),
                ram_use=round(self.ram_use, 2),
                disk_use=round(self.disk_use, 2),
                net_up=round(self.net_up, 2),
                net_down=round(self.net_down, 2),
                status=self.status,
                uptime=self.uptime,
                traffic_limit_gb=self.traffic_limit_gb,
                traffic_up_gb=round(self.traffic_up_gb, 4),
                traffic_down_gb=round(self.traffic_down_gb, 4),
                traffic_used_gb=round(self.traffic_used_gb, 4),
                updated_at=self.updated_at.isoformat(),
            ))
        
        return d


class ProbeResult(db.Model):
    """探针结果历史 - 按日期分区"""
    __tablename__ = "probe_results"
    
    id = db.Column(BIGINT, primary_key=True)
    server_id = db.Column(db.Integer, db.ForeignKey("servers.id", ondelete="CASCADE"), nullable=False, index=True)
    
    # 指标数据
    cpu_use = db.Column(db.Float)
    ram_use = db.Column(db.Float)
    disk_use = db.Column(db.Float)
    net_up = db.Column(db.Float)
    net_down = db.Column(db.Float)
    latency_ms = db.Column(db.Float)
    status = db.Column(db.String(16))
    
    # 时间戳
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    
    # 关键复合索引
    __table_args__ = (
        db.Index('idx_server_created', 'server_id', 'created_at'),
        db.Index('idx_created_at_server', 'created_at', 'server_id'),
        db.Index('idx_probe_created_date', 'created_at'),  # 用于日期范围查询
    )
    
    def to_dict(self):
        return dict(
            id=self.id,
            server_id=self.server_id,
            cpu_use=self.cpu_use,
            ram_use=self.ram_use,
            disk_use=self.disk_use,
            net_up=self.net_up,
            net_down=self.net_down,
            latency_ms=self.latency_ms,
            status=self.status,
            created_at=self.created_at.isoformat(),
        )


class AlertRule(db.Model):
    __tablename__ = "alert_rules"
    
    id = db.Column(db.Integer, primary_key=True)
    server_id = db.Column(db.Integer, db.ForeignKey("servers.id", ondelete="CASCADE"), nullable=True, index=True)
    rule_type = db.Column(db.String(32), nullable=False, index=True)
    threshold = db.Column(db.Float, default=90)
    enabled = db.Column(db.Boolean, default=True, index=True)
    last_fired = db.Column(db.DateTime)
    cool_down_s = db.Column(db.Integer, default=300)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    
    __table_args__ = (
        db.Index('idx_server_type', 'server_id', 'rule_type'),
        db.Index('idx_enabled', 'enabled'),
    )
    
    def to_dict(self):
        return dict(
            id=self.id,
            server_id=self.server_id,
            rule_type=self.rule_type,
            threshold=self.threshold,
            enabled=self.enabled,
            cool_down_s=self.cool_down_s,
        )


class TelegramConfig(db.Model):
    __tablename__ = "telegram_config"
    
    id = db.Column(db.Integer, primary_key=True)
    bot_token = db.Column(db.String(256), default="")
    chat_id = db.Column(db.String(64), default="")
    prefix = db.Column(db.String(64), default="【VPS星图】")
    enabled = db.Column(db.Boolean, default=False, index=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    
    def to_dict(self):
        return dict(
            id=self.id,
            chat_id=self.chat_id,
            prefix=self.prefix,
            enabled=self.enabled,
            has_token=bool(self.bot_token),
        )


class AuditLog(db.Model):
    """审计日志表"""
    __tablename__ = "audit_logs"
    
    id = db.Column(BIGINT, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=True, index=True)
    username = db.Column(db.String(64), index=True)
    
    # 操作信息
    action = db.Column(db.String(32), nullable=False, index=True)
    resource_type = db.Column(db.String(32), index=True)
    resource_id = db.Column(db.String(100), index=True)
    
    # 请求信息
    method = db.Column(db.String(10))
    endpoint = db.Column(db.String(255))
    status_code = db.Column(db.Integer)
    
    # 结果
    success = db.Column(db.Boolean, default=True, index=True)
    error_message = db.Column(db.Text)
    
    # 详细数据
    old_values = db.Column(db.JSON)
    new_values = db.Column(db.JSON)
    
    # 元数据
    ip_address = db.Column(db.String(50), index=True)
    user_agent = db.Column(db.Text)
    
    created_at = db.Column(db.DateTime, default=datetime.utcnow, nullable=False, index=True)
    
    __table_args__ = (
        db.Index('idx_user_created', 'user_id', 'created_at'),
        db.Index('idx_action_created', 'action', 'created_at'),
        db.Index('idx_audit_created_date', 'created_at'),
    )
    
    def to_dict(self):
        return dict(
            id=self.id,
            user_id=self.user_id,
            username=self.username,
            action=self.action,
            resource_type=self.resource_type,
            resource_id=self.resource_id,
            method=self.method,
            endpoint=self.endpoint,
            status_code=self.status_code,
            success=self.success,
            error_message=self.error_message,
            ip_address=self.ip_address,
            created_at=self.created_at.isoformat(),
        )
