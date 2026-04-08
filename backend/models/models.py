"""
数据库模型
表：users / servers / probe_results / alert_rules / telegram_config / geo_cache
"""
from datetime import datetime, date
from extensions import db


class User(db.Model):
    __tablename__ = "users"

    id            = db.Column(db.Integer, primary_key=True)
    username      = db.Column(db.String(64), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    role          = db.Column(db.String(16), default="admin")   # admin | viewer
    created_at    = db.Column(db.DateTime, default=datetime.utcnow)
    last_login    = db.Column(db.DateTime)

    def to_dict(self):
        return dict(id=self.id, username=self.username, role=self.role,
                    created_at=self.created_at.isoformat())


class Server(db.Model):
    __tablename__ = "servers"

    id         = db.Column(db.Integer, primary_key=True)
    name       = db.Column(db.String(128), nullable=False)
    group_name = db.Column(db.String(64),  default="默认分组", index=True)
    flag       = db.Column(db.String(8),   default="🌐")
    location   = db.Column(db.String(128), default="")
    ip         = db.Column(db.String(45),  default="")        # supports IPv6
    cpu_cores  = db.Column(db.SmallInteger, default=1)
    ram_gb     = db.Column(db.Float,        default=1.0)
    disk_gb    = db.Column(db.Integer,      default=20)
    bandwidth  = db.Column(db.String(64),   default="不限")
    probe_url  = db.Column(db.String(512),  default="")
    note       = db.Column(db.Text,         default="")

    # Pricing
    price      = db.Column(db.Float, default=0)
    period     = db.Column(db.String(16), default="monthly")  # monthly|yearly|quarterly
    expiry     = db.Column(db.Date)

    # Live metrics (updated by probe service, also cached in Redis)
    cpu_use    = db.Column(db.Float, default=0)
    ram_use    = db.Column(db.Float, default=0)
    disk_use   = db.Column(db.Float, default=0)
    net_up     = db.Column(db.Float, default=0)
    net_down   = db.Column(db.Float, default=0)
    status     = db.Column(db.String(16), default="unknown")  # online|offline|warn
    uptime     = db.Column(db.String(16), default="")

    # Traffic accounting
    traffic_limit_gb  = db.Column(db.Float,   default=0)    # 0 = unlimited
    traffic_up_gb     = db.Column(db.Float,   default=0)    # accumulated this period
    traffic_down_gb   = db.Column(db.Float,   default=0)
    traffic_used_gb   = db.Column(db.Float,   default=0)    # up+down, updated by probe
    traffic_reset_day = db.Column(db.SmallInteger, default=1)  # day-of-month to reset

    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self, include_metrics=True):
        d = dict(
            id=self.id, name=self.name, group=self.group_name,
            flag=self.flag, location=self.location, ip=self.ip,
            cpu=self.cpu_cores, ram=self.ram_gb, disk=self.disk_gb,
            bw=self.bandwidth, probe=self.probe_url, note=self.note,
            price=self.price, period=self.period,
            expiry=self.expiry.isoformat() if self.expiry else None,
        )
        if include_metrics:
            d.update(dict(
                cpu_use=round(self.cpu_use, 2), ram_use=round(self.ram_use, 2),
                disk_use=round(self.disk_use, 2),
                net_up=round(self.net_up, 2), net_down=round(self.net_down, 2),
                status=self.status, uptime=self.uptime,
                traffic_limit_gb=self.traffic_limit_gb,
                traffic_up_gb=round(self.traffic_up_gb, 4),
                traffic_down_gb=round(self.traffic_down_gb, 4),
                traffic_used_gb=round(self.traffic_used_gb, 4),
                traffic_reset_day=self.traffic_reset_day,
                updated_at=self.updated_at.isoformat() if self.updated_at else None,
            ))
        return d


class ProbeResult(db.Model):
    """保存每次探针抓取的历史快照（可用于历史图表）"""
    __tablename__ = "probe_results"

    id         = db.Column(db.Integer, primary_key=True)
    server_id  = db.Column(db.Integer, db.ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    probed_at  = db.Column(db.DateTime, default=datetime.utcnow, index=True)
    cpu_use    = db.Column(db.Float)
    ram_use    = db.Column(db.Float)
    disk_use   = db.Column(db.Float)
    net_up     = db.Column(db.Float)
    net_down   = db.Column(db.Float)
    latency_ms = db.Column(db.Float)      # TCP ping 延迟
    status     = db.Column(db.String(16))

    server = db.relationship("Server", backref=db.backref("probe_history", lazy="dynamic"))

    def to_dict(self):
        return dict(
            id=self.id, server_id=self.server_id,
            probed_at=self.probed_at.isoformat(),
            cpu_use=self.cpu_use, ram_use=self.ram_use,
            disk_use=self.disk_use, net_up=self.net_up, net_down=self.net_down,
            latency_ms=self.latency_ms, status=self.status,
        )


class AlertRule(db.Model):
    __tablename__ = "alert_rules"

    id           = db.Column(db.Integer, primary_key=True)
    server_id    = db.Column(db.Integer, db.ForeignKey("servers.id", ondelete="CASCADE"),
                             nullable=True, index=True)  # NULL = 全局规则
    rule_type    = db.Column(db.String(32))   # cpu|ram|disk|offline|expiry
    threshold    = db.Column(db.Float, default=90)
    enabled      = db.Column(db.Boolean, default=True)
    last_fired   = db.Column(db.DateTime)
    cool_down_s  = db.Column(db.Integer, default=300)   # 冷却时间，避免刷屏

    def to_dict(self):
        return dict(id=self.id, server_id=self.server_id,
                    rule_type=self.rule_type, threshold=self.threshold,
                    enabled=self.enabled)


class TelegramConfig(db.Model):
    __tablename__ = "telegram_config"
    id         = db.Column(db.Integer, primary_key=True)
    bot_token  = db.Column(db.String(256), default="")
    chat_id    = db.Column(db.String(64),  default="")
    prefix     = db.Column(db.String(64),  default="【VPS星图】")
    enabled    = db.Column(db.Boolean, default=False)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def to_dict(self):
        return dict(
            id=self.id, chat_id=self.chat_id,
            prefix=self.prefix, enabled=self.enabled,
            has_token=bool(self.bot_token),
        )
