"""
backend/models/auth_tokens.py
邮箱验证 Token 与密码重置 Token 模型

生命周期：
  EmailVerification   —— 注册时创建，用户点击邮件链接后标记 verified=True，24h 过期
  PasswordResetToken  —— 忘记密码时创建，重置成功或 1h 到期后标记 used=True

安全设计：
  - Token 值用 secrets.token_urlsafe(32) 生成，存数据库前不做散列（已足够随机）
  - 使用后立即标记 used=True，防止重放攻击
  - 过期由 expires_at 字段控制，查询时始终带过期过滤
"""

from datetime import datetime, timezone, timedelta
import secrets
from extensions import db


class EmailVerification(db.Model):
    """邮箱验证 Token（注册激活）"""
    __tablename__ = "email_verifications"

    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    token      = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email      = db.Column(db.String(256), nullable=False)
    verified   = db.Column(db.Boolean, default=False, nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # ── 工厂方法 ──────────────────────────────────────────────────────────────
    @classmethod
    def create_for(cls, user_id: int, email: str, ttl_hours: int = 24) -> "EmailVerification":
        """生成并持久化一条新验证记录，返回实例（调用方需 db.session.commit()）"""
        obj = cls(
            user_id    = user_id,
            email      = email,
            token      = secrets.token_urlsafe(32),
            expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours),
        )
        db.session.add(obj)
        return obj

    # ── 查询助手 ──────────────────────────────────────────────────────────────
    @classmethod
    def find_valid(cls, token: str) -> "EmailVerification | None":
        """查找未使用且未过期的验证记录"""
        return cls.query.filter_by(token=token, verified=False).filter(
            cls.expires_at > datetime.now(timezone.utc)
        ).first()

    def activate(self) -> None:
        """将当前记录标记为已验证"""
        self.verified = True

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

    def to_dict(self) -> dict:
        return dict(
            id         = self.id,
            user_id    = self.user_id,
            email      = self.email,
            verified   = self.verified,
            expires_at = self.expires_at.isoformat(),
            created_at = self.created_at.isoformat(),
        )


class PasswordResetToken(db.Model):
    """密码重置 Token（忘记密码流程）"""
    __tablename__ = "password_reset_tokens"

    id         = db.Column(db.Integer, primary_key=True)
    user_id    = db.Column(
        db.Integer,
        db.ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False, index=True,
    )
    token      = db.Column(db.String(64), unique=True, nullable=False, index=True)
    used       = db.Column(db.Boolean, default=False, nullable=False, index=True)
    expires_at = db.Column(db.DateTime, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # ── 工厂方法 ──────────────────────────────────────────────────────────────
    @classmethod
    def create_for(cls, user_id: int, ttl_hours: int = 1) -> "PasswordResetToken":
        """生成并持久化一条新重置记录。
        同时废弃该用户的历史未使用 token（防止多 token 并存）。
        """
        # 废弃旧 token
        cls.query.filter_by(user_id=user_id, used=False).update({"used": True})

        obj = cls(
            user_id    = user_id,
            token      = secrets.token_urlsafe(32),
            expires_at = datetime.now(timezone.utc) + timedelta(hours=ttl_hours),
        )
        db.session.add(obj)
        return obj

    # ── 查询助手 ──────────────────────────────────────────────────────────────
    @classmethod
    def find_valid(cls, token: str) -> "PasswordResetToken | None":
        """查找未使用且未过期的重置记录"""
        return cls.query.filter_by(token=token, used=False).filter(
            cls.expires_at > datetime.now(timezone.utc)
        ).first()

    def consume(self) -> None:
        """使用后立即标记，防止重放"""
        self.used = True

    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

    def to_dict(self) -> dict:
        return dict(
            id         = self.id,
            user_id    = self.user_id,
            used       = self.used,
            expires_at = self.expires_at.isoformat(),
            created_at = self.created_at.isoformat(),
        )
