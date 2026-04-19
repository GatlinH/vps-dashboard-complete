from __future__ import annotations

from datetime import datetime, timezone

from extensions import db


class PaymentOrder(db.Model):
    """支付订单（一次性付款或订阅）。"""

    __tablename__ = "payment_orders"

    id = db.Column(db.Integer, primary_key=True)
    order_no = db.Column(db.String(64), unique=True, nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id", ondelete="SET NULL"), nullable=True, index=True)

    provider = db.Column(db.String(16), nullable=False, default="stripe", index=True)
    payment_type = db.Column(db.String(16), nullable=False, default="one_time", index=True)

    amount = db.Column(db.Float, nullable=False)
    currency = db.Column(db.String(8), nullable=False, default="USD")

    status = db.Column(db.String(16), nullable=False, default="pending", index=True)
    subscription_status = db.Column(db.String(32), nullable=False, default="none", index=True)

    external_order_id = db.Column(db.String(128), nullable=True, index=True)
    invoice_id = db.Column(db.String(128), nullable=True, index=True)

    metadata_json = db.Column(db.JSON, nullable=True)

    paid_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)
    updated_at = db.Column(
        db.DateTime,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
        index=True,
    )

    __table_args__ = (
        db.Index("idx_payment_order_user_provider", "user_id", "provider"),
        db.Index("idx_payment_order_status_created", "status", "created_at"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "order_no": self.order_no,
            "user_id": self.user_id,
            "provider": self.provider,
            "payment_type": self.payment_type,
            "amount": float(self.amount),
            "currency": self.currency,
            "status": self.status,
            "subscription_status": self.subscription_status,
            "external_order_id": self.external_order_id,
            "invoice_id": self.invoice_id,
            "metadata": self.metadata_json or {},
            "paid_at": self.paid_at.isoformat() if self.paid_at else None,
            "created_at": self.created_at.isoformat() if self.created_at else None,
            "updated_at": self.updated_at.isoformat() if self.updated_at else None,
        }


class PaymentTransaction(db.Model):
    """支付交易流水与 webhook 事件归档。"""

    __tablename__ = "payment_transactions"

    id = db.Column(db.Integer, primary_key=True)
    order_id = db.Column(db.Integer, db.ForeignKey("payment_orders.id", ondelete="CASCADE"), nullable=False, index=True)

    provider = db.Column(db.String(16), nullable=False, default="stripe", index=True)
    event_id = db.Column(db.String(128), nullable=True, unique=True, index=True)
    event_type = db.Column(db.String(64), nullable=True, index=True)
    transaction_id = db.Column(db.String(128), nullable=True, index=True)

    amount = db.Column(db.Float, nullable=True)
    currency = db.Column(db.String(8), nullable=True)
    status = db.Column(db.String(16), nullable=False, default="received", index=True)

    signature_verified = db.Column(db.Boolean, nullable=False, default=False)
    raw_payload = db.Column(db.Text, nullable=True)

    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc), nullable=False, index=True)

    __table_args__ = (
        db.Index("idx_payment_tx_order_created", "order_id", "created_at"),
        db.Index("idx_payment_tx_provider_event", "provider", "event_type"),
    )

    def to_dict(self):
        return {
            "id": self.id,
            "order_id": self.order_id,
            "provider": self.provider,
            "event_id": self.event_id,
            "event_type": self.event_type,
            "transaction_id": self.transaction_id,
            "amount": float(self.amount) if self.amount is not None else None,
            "currency": self.currency,
            "status": self.status,
            "signature_verified": self.signature_verified,
            "created_at": self.created_at.isoformat() if self.created_at else None,
        }
