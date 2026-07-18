# backend/models/models.py - 改进版本

"""
数据库模型 - 性能优化版本
添加关键索引和分区策略
"""
import logging
import os
from datetime import datetime, timezone, date
from extensions import db
from models.audit_log import AuditLog  # re-export for backward compatibility
from utils.crypto import CryptoManager, EncryptedString

logger = logging.getLogger(__name__)

# Per-secret CryptoManager cache: avoids re-deriving the PBKDF2HMAC key on every DB access.
# Keyed by the secret string so different keys coexist without collision.
# On secret rotation: old entries remain in memory for the process lifetime (bounded, low risk).
# If a compromised secret is rotated, restart the process to clear stale cache entries.
_crypto_cache: dict = {}


SERVER_COORD_FALLBACKS = {
    "sg": (1.35, 103.82),
    "singapore": (1.35, 103.82),
    "jp": (35.68, 139.65),
    "tokyo": (35.68, 139.65),
    "de": (50.11, 8.68),
    "frankfurt": (50.11, 8.68),
    "la": (34.05, -118.24),
    "los angeles": (34.05, -118.24),
    "hk": (22.32, 114.17),
    "hong kong": (22.32, 114.17),
    "us": (40.71, -74.01),
    "new york": (40.71, -74.01),
}


def get_server_inventory_meta(server):
    cfg = getattr(server, 'agent_config', None) or {}
    meta = cfg.get('inventory_meta') if isinstance(cfg.get('inventory_meta'), dict) else {}
    return cfg, dict(meta)


def format_server_location(city='', region='', country=''):
    city = str(city or '').strip()
    region = str(region or '').strip()
    country = str(country or '').strip()
    parts = []
    for value in (city, region, country):
        if value and value not in parts:
            parts.append(value)
    if not parts:
        return ''
    if len(parts) >= 2 and parts[0].lower() == parts[1].lower():
        parts.pop(1)
    return ' · '.join(parts[:2])


def get_server_coords(server):
    cfg, meta = get_server_inventory_meta(server)
    for source in (meta, cfg):
        for lat_key, lon_key in [('lat', 'lon'), ('latitude', 'longitude')]:
            lat = source.get(lat_key)
            lon = source.get(lon_key)
            if lat is not None and lon is not None:
                try:
                    return float(lat), float(lon)
                except (TypeError, ValueError):
                    pass
    text_bits = ' '.join(str(x or '').lower() for x in [
        getattr(server, 'name', ''),
        getattr(server, 'location', ''),
        getattr(server, 'group_name', ''),
        meta.get('region'),
        meta.get('city'),
        meta.get('country'),
        cfg.get('region'),
        cfg.get('city'),
    ])
    for key, coords in SERVER_COORD_FALLBACKS.items():
        if key in text_bits:
            return coords
    return 0.0, 0.0


def _get_tg_crypto():
    """惰性获取 Telegram bot_token 加密用的 CryptoManager。

    每次调用时优先从 Flask current_app.config 读取 TELEGRAM_TOKEN_SECRET；
    在 app context 之外（CLI、测试 fixture 初始化前）回退到 os.getenv（并打印 debug 日志）。
    结果按 secret 值缓存，避免对同一密钥重复执行 PBKDF2HMAC 迭代。
    未配置 TELEGRAM_TOKEN_SECRET 时返回 None（调用方 EncryptedString 将在写入时 fail-closed）。
    """
    from flask import current_app
    try:
        secret = current_app.config.get("TELEGRAM_TOKEN_SECRET", "")
    except RuntimeError:
        # Flask app context not active (e.g. CLI / pre-push test setup)
        secret = os.getenv("TELEGRAM_TOKEN_SECRET", "")
        if secret:
            logger.debug(
                "TELEGRAM_TOKEN_SECRET read from env (no Flask app context active)"
            )

    if not secret:
        return None

    if secret not in _crypto_cache:
        try:
            _crypto_cache[secret] = CryptoManager(master_key=secret)
        except Exception as exc:
            logger.error(
                "Telegram token 加密初始化失败（请检查 TELEGRAM_TOKEN_SECRET）: %s", exc
            )
            return None

    return _crypto_cache[secret]

class User(db.Model):
    __tablename__ = "users"
    
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email = db.Column(db.String(256), unique=True, nullable=True, index=True)
    password_hash = db.Column(db.String(256), nullable=False)
    role = db.Column(db.String(16), default="user", index=True)
    email_verified = db.Column(db.Boolean, default=True, nullable=False, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_login = db.Column(db.DateTime)
    totp_secret = db.Column(db.String(64), nullable=True)
    totp_enabled = db.Column(db.Boolean, default=False, nullable=False, index=True)
    totp_enabled_at = db.Column(db.DateTime, nullable=True)
    
    __table_args__ = (
        db.Index('idx_username_role', 'username', 'role'),
    )
    
    def to_dict(self):
        return dict(
            id=self.id,
            username=self.username,
            email=self.email,
            email_verified=self.email_verified,
            role=self.role,
            created_at=self.created_at.isoformat(),
            last_login=self.last_login.isoformat() if self.last_login else None,
            two_factor_enabled=bool(self.totp_enabled),
        )


class Server(db.Model):
    __tablename__ = "servers"
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(128), nullable=False, index=True)
    group_name = db.Column(db.String(64), default="默认分组", index=True)
    flag = db.Column(db.String(8), default="🌐")
    location = db.Column(db.String(128), default="")
    ip = db.Column(db.String(45), default="", unique=True, index=True)
    uuid = db.Column(db.String(64), unique=True, index=True, nullable=True)
    
    # 硬件配置
    cpu_cores = db.Column(db.SmallInteger, default=1)
    ram_gb = db.Column(db.Float, default=1.0)
    disk_gb = db.Column(db.Integer, default=20)
    bandwidth = db.Column(db.String(64), default="不限")
    provider = db.Column(db.String(128), default="", index=True)
    tags = db.Column(db.JSON, nullable=False, default=list)
    
    # 探针信息
    probe_url = db.Column(db.String(512), default="")
    note = db.Column(db.Text, default="")
    agent_key_hash = db.Column(db.String(256), nullable=True)
    agent_key_prev_hash = db.Column(db.String(256), nullable=True)
    agent_key_created_at = db.Column(db.DateTime, nullable=True)
    agent_key_prev_expires_at = db.Column(db.DateTime, nullable=True)
    agent_key_last_used = db.Column(db.DateTime, nullable=True)
    agent_config = db.Column(db.JSON, nullable=False, default=dict)
    
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

    # 流量精确计算：存储上次探针快照字节数
    bytes_out_snapshot = db.Column(db.BigInteger, default=0)
    bytes_in_snapshot  = db.Column(db.BigInteger, default=0)
    
    # 时间戳
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), index=True)
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc), index=True)
    
    # 复合索引用于常见查询
    __table_args__ = (
        db.Index('idx_group_status', 'group_name', 'status'),
        db.Index('idx_expiry_status', 'expiry', 'status'),
        db.Index('idx_created_at', 'created_at'),
        db.Index('idx_updated_at', 'updated_at'),
    )
    
    def to_dict(self, include_metrics=True, public_only=False):
        cfg, inventory_meta = get_server_inventory_meta(self)
        lat, lon = get_server_coords(self)
        city = str(inventory_meta.get('city') or cfg.get('city') or '').strip()
        region = str(inventory_meta.get('region') or cfg.get('region') or '').strip()
        country = str(inventory_meta.get('country') or cfg.get('country') or '').strip()
        provider_guess = str(inventory_meta.get('provider_guess') or cfg.get('provider_guess') or inventory_meta.get('org') or inventory_meta.get('isp') or '').strip()
        runtime_os = str(inventory_meta.get('os') or cfg.get('os') or '').strip()
        runtime_kernel = str(inventory_meta.get('kernel_version') or inventory_meta.get('kernel') or cfg.get('kernel_version') or cfg.get('kernel') or '').strip()
        runtime_arch = str(inventory_meta.get('arch') or cfg.get('arch') or '').strip()
        runtime_cpu_model = str(inventory_meta.get('cpu_model') or inventory_meta.get('cpu_name') or cfg.get('cpu_model') or cfg.get('cpu_name') or '').strip()
        effective_location = str(self.location or '').strip() or format_server_location(city, region, country)

        merged_agent_config = dict(cfg or {})
        merged_agent_config['inventory_meta'] = inventory_meta
        d = dict(
            id=self.id,
            name=self.name,
            group=self.group_name,
            flag=self.flag,
            location=effective_location,
            city=city,
            region=region,
            country=country,
            ip=self.ip,
            cpu=self.cpu_cores,
            ram=self.ram_gb,
            disk=self.disk_gb,
            bw=self.bandwidth,
            provider=self.provider or '',
            provider_guess=provider_guess,
            os=runtime_os[:160],
            kernel_version=runtime_kernel[:160],
            arch=runtime_arch[:80],
            cpu_model=runtime_cpu_model,
            tags=self.tags or [],
            probe=self.probe_url,
            note=self.note,
            price=self.price,
            period=self.period,
            expiry=self.expiry.isoformat() if self.expiry else None,
            uuid=self.uuid,
            agent_config=merged_agent_config,
            lat=lat,
            lon=lon,
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
                traffic_reset_day=self.traffic_reset_day or 1,
                traffic_up_gb=round(self.traffic_up_gb, 4),
                traffic_down_gb=round(self.traffic_down_gb, 4),
                traffic_used_gb=round(self.traffic_used_gb, 4),
                updated_at=self.updated_at.isoformat(),
            ))
        
        if public_only:
            # Public homepage/detail APIs must expose only display-safe fields.
            # Expose a sanitized display remark under public_note so the globe
            # can honor the admin-configured public remark without leaking the
            # raw internal note field/key.
            raw_public_note = str(self.note or "").strip()
            if raw_public_note:
                d["public_note"] = raw_public_note[:160]
                d["publicRemark"] = d["public_note"]
            elif str(d.get("location") or "").strip() and not str(d.get("region") or "").strip():
                d["public_note"] = d["location"]

            # Never leak agent identifiers/config, raw inventory metadata, raw
            # note key, probe URLs, or full origin IPs to anonymous visitors.
            sensitive_keys = (
                "probe", "note", "uuid", "agent_config",
                "provider_guess",
            )
            for key in sensitive_keys:
                d.pop(key, None)

            def _mask_ip(value):
                raw = str(value or "").strip()
                if not raw:
                    return ""
                parts = raw.split(".")
                if len(parts) == 4 and all(part.isdigit() for part in parts):
                    return f"{parts[0]}.{parts[1]}.*.*"
                if ":" in raw:
                    head = raw.split(":", 1)[0]
                    return f"{head}:***" if head else "***"
                if len(raw) <= 6:
                    return "***"
                return raw[:3] + "***" + raw[-2:]

            d["ip"] = _mask_ip(d.get("ip"))
            for key in ("city", "region", "country"):
                d[key] = str(d.get(key) or "")[:64]

            # Coarsen runtime inventory for anonymous/public APIs. Exact kernel
            # patch strings are useful for target fingerprinting; keep precise
            # values only in internal/admin data.
            raw_os = str(d.get("os") or "").strip()
            if raw_os:
                d["os"] = raw_os.split("(", 1)[0].strip()[:80]
            raw_kernel = str(d.get("kernel_version") or "").strip()
            if raw_kernel:
                kernel_family = raw_kernel.split("-", 1)[0]
                parts = kernel_family.split(".")
                d["kernel_version"] = ".".join(parts[:2]) if len(parts) >= 2 else kernel_family[:16]
        
        return d


class AgentCommand(db.Model):
    __tablename__ = "agent_commands"

    id = db.Column(db.BigInteger().with_variant(db.Integer, 'sqlite'), primary_key=True, autoincrement=True)
    server_id = db.Column(db.Integer, db.ForeignKey("servers.id", ondelete="CASCADE"), nullable=False, index=True)
    command_type = db.Column(db.String(32), nullable=False, index=True)
    payload = db.Column(db.JSON, nullable=False, default=dict)
    status = db.Column(db.String(16), nullable=False, default="pending", index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=True, index=True)
    executed_at = db.Column(db.DateTime, nullable=True)

    __table_args__ = (
        db.Index('idx_agent_command_server_status', 'server_id', 'status'),
    )

    def to_dict(self):
        return dict(
            id=self.id,
            server_id=self.server_id,
            command_type=self.command_type,
            payload=self.payload or {},
            status=self.status,
            created_at=self.created_at.isoformat() if self.created_at else None,
            expires_at=self.expires_at.isoformat() if self.expires_at else None,
        )


class OpsEvent(db.Model):
    __tablename__ = "ops_events"

    id = db.Column(db.BigInteger().with_variant(db.Integer, 'sqlite'), primary_key=True, autoincrement=True)
    event_type = db.Column(db.String(32), nullable=False, index=True)
    level = db.Column(db.String(16), nullable=False, default='info', index=True)
    server_id = db.Column(db.Integer, nullable=True, index=True)
    rule_id = db.Column(db.Integer, nullable=True, index=True)
    title = db.Column(db.String(255), nullable=False)
    message = db.Column(db.Text, default='')
    payload = db.Column(db.JSON, nullable=False, default=dict)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)

    __table_args__ = (
        db.Index('idx_ops_event_type_created', 'event_type', 'created_at'),
        db.Index('idx_ops_event_server_created', 'server_id', 'created_at'),
    )

    def to_dict(self):
        return dict(
            id=self.id, event_type=self.event_type, level=self.level, server_id=self.server_id, rule_id=self.rule_id,
            title=self.title, message=self.message, payload=self.payload or {},
            created_at=self.created_at.isoformat() if self.created_at else None,
        )


def record_ops_event(event_type, title, message='', level='info', server_id=None, rule_id=None, payload=None):
    evt = OpsEvent(
        event_type=event_type, title=title, message=message or '', level=level or 'info',
        server_id=server_id, rule_id=rule_id, payload=payload or {},
    )
    db.session.add(evt)
    return evt


class ProbeResult(db.Model):
    """探针结果历史 - 按日分区（MySQL 8.0+）

    MySQL 分区方案：RANGE COLUMNS(created_at)，按日粒度（pYYYYMMDD），
    含兜底分区 pmax。分区管理由 services.probe_partition 提供工具函数。

    重要约束：MySQL 分区表不支持外键（FOREIGN KEY），因此
    probe_results 在 MySQL 中不含 FK 约束。
    - 删除服务器时，api/servers.py::delete_server 会显式清理该服务器的
      ProbeResult 行（不依赖 DB 级 CASCADE）。
    - 保留期内其余孤儿行（如有）由定时清理任务（_job_cleanup）回收。
    SQLAlchemy 模型保留 ForeignKey 声明以兼容 SQLite 测试环境
    （SQLite 默认不强制外键）。
    """
    __tablename__ = "probe_results"

    id = db.Column(db.BigInteger().with_variant(db.Integer, 'sqlite'), primary_key=True, autoincrement=True)
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
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)
    
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
    bot_id = db.Column(db.Integer, db.ForeignKey("telegram_config.id", ondelete="SET NULL"), nullable=True, index=True)
    name = db.Column(db.String(128), default="")
    rule_type = db.Column(db.String(32), nullable=False, index=True)
    threshold = db.Column(db.Float, default=90)
    enabled = db.Column(db.Boolean, default=True, index=True)
    last_fired = db.Column(db.DateTime)
    cool_down_s = db.Column(db.Integer, default=300)
    notify_repeat = db.Column(db.Boolean, default=True)
    target_chat_id = db.Column(db.String(512), default="")
    note = db.Column(db.Text, default="")
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
    
    __table_args__ = (
        db.Index('idx_server_type', 'server_id', 'rule_type'),
        db.Index('idx_enabled', 'enabled'),
    )
    
    def to_dict(self):
        return dict(
            id=self.id,
            server_id=self.server_id,
            bot_id=self.bot_id,
            name=self.name or '',
            scope='server' if self.server_id else 'global',
            rule_type=self.rule_type,
            threshold=self.threshold,
            enabled=self.enabled,
            cool_down_s=self.cool_down_s,
            notify_repeat=self.notify_repeat,
            target_chat_id=self.target_chat_id or '',
            note=self.note or '',
            last_fired=self.last_fired.isoformat() if self.last_fired else None,
            created_at=self.created_at.isoformat() if self.created_at else None,
            updated_at=self.updated_at.isoformat() if self.updated_at else None,
        )


class TelegramConfig(db.Model):
    __tablename__ = "telegram_config"
    
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(64), default="默认机器人")
    bot_token = db.Column(EncryptedString(_get_tg_crypto, length=512), default="")
    chat_id = db.Column(db.String(64), default="")
    prefix = db.Column(db.String(64), default="【VPS星图】")
    enabled = db.Column(db.Boolean, default=False, index=True)
    is_default = db.Column(db.Boolean, default=False, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    @staticmethod
    def _mask_sensitive(value: str, head: int = 3, tail: int = 3) -> str:
        value = (value or "").strip()
        if not value:
            return ""
        if len(value) <= head + tail:
            return "*" * len(value)
        return f"{value[:head]}****{value[-tail:]}"
    
    def to_dict(self):
        token_masked = self._mask_sensitive(self.bot_token, head=3, tail=3)
        return dict(
            id=self.id,
            name=self.name or f"机器人 {self.id}",
            is_default=bool(self.is_default),
            chat_id=self.chat_id,
            chat_id_masked=self._mask_sensitive(self.chat_id, head=2, tail=2),
            prefix=self.prefix,
            enabled=self.enabled,
            has_token=bool(self.bot_token),
            bot_token=token_masked,
            bot_token_masked=token_masked,
        )


class AffProduct(db.Model):
    """AFF 市场商品"""
    __tablename__ = "aff_products"

    id         = db.Column(db.Integer, primary_key=True)
    provider   = db.Column(db.String(128), nullable=False, index=True)
    stock      = db.Column(db.String(16), default="avail", index=True)
    cpu        = db.Column(db.String(32), default="")
    ram        = db.Column(db.String(32), default="")
    disk       = db.Column(db.String(32), default="")
    bandwidth  = db.Column(db.String(64), default="")
    location   = db.Column(db.String(64), default="")
    group_name = db.Column(db.String(64), default="默认分组", index=True)
    price      = db.Column(db.Float, default=0.0)
    currency   = db.Column(db.String(8), default="CNY")
    period     = db.Column(db.String(16), default="monthly")
    buy_url    = db.Column(db.String(256), default="")
    review_url = db.Column(db.String(256), default="")
    note       = db.Column(db.Text, default="")
    i18n       = db.Column(db.JSON, nullable=False, default=dict)  # 如 {"en": {"note": "...", "provider": "..."}}
    sort_order = db.Column(db.Integer, default=100, index=True)
    enabled    = db.Column(db.Boolean, default=True, index=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    def to_dict(self, lang: str = "zh"):
        i18n_map = self.i18n or {}
        i18n_entry = i18n_map.get(lang) if isinstance(i18n_map, dict) else {}
        return {
            "id":         self.id,
            "provider":   (i18n_entry or {}).get("provider") or self.provider,
            "stock":      self.stock,
            "cpu":        self.cpu,
            "ram":        self.ram,
            "disk":       self.disk,
            "bandwidth":  self.bandwidth,
            "location":   self.location,
            "group_name": self.group_name,
            "price":      self.price,
            "currency":   self.currency,
            "period":     self.period,
            "buy_url":    self.buy_url,
            "review_url": self.review_url,
            "note":       (i18n_entry or {}).get("note") or self.note,
            "lang":       lang,
            "i18n":       i18n_map,
            "sort_order": self.sort_order,
            "enabled":    self.enabled,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
