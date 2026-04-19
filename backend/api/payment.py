"""/api/payment - 订单、支付与 Stripe webhook。"""

from __future__ import annotations

import logging
import os
import uuid
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request
from flask_jwt_extended import get_jwt, jwt_required

from extensions import db
from models.payment import PaymentOrder, PaymentTransaction
from services.payment import stripe_service
from utils.errors import AuthorizationError, ValidationError

logger = logging.getLogger(__name__)
payment_bp = Blueprint("payment", __name__)


def _to_datetime_from_ts(ts: int | None):
    if not ts:
        return None
    return datetime.fromtimestamp(int(ts), tz=timezone.utc)


@payment_bp.post("/orders")
@jwt_required()
def create_order():
    data = request.get_json(silent=True) or {}
    amount = data.get("amount")
    if amount is None:
        raise ValidationError("amount 必填", field="amount")
    try:
        amount = float(amount)
    except Exception as exc:
        raise ValidationError("amount 必须是数字", field="amount", value=amount) from exc
    if amount <= 0:
        raise ValidationError("amount 必须大于 0", field="amount", value=amount)

    provider = (data.get("provider") or "stripe").strip().lower()
    if provider not in ("stripe", "paypal"):
        raise ValidationError("provider 仅支持 stripe/paypal", field="provider", value=provider)

    payment_type = (data.get("payment_type") or "one_time").strip().lower()
    if payment_type not in ("one_time", "subscription"):
        raise ValidationError("payment_type 仅支持 one_time/subscription", field="payment_type", value=payment_type)

    order_no = f"ORD-{uuid.uuid4().hex[:20].upper()}"
    claims = get_jwt()

    order = PaymentOrder(
        order_no=order_no,
        user_id=claims.get("sub"),
        provider=provider,
        payment_type=payment_type,
        amount=amount,
        currency=(data.get("currency") or "USD").upper(),
        status="pending",
        subscription_status="incomplete" if payment_type == "subscription" else "none",
        metadata_json=data.get("metadata") or {},
    )
    db.session.add(order)
    db.session.commit()
    return jsonify(order=order.to_dict(), message="订单创建成功"), 201


@payment_bp.post("/orders/<int:order_id>/pay")
@jwt_required()
def initiate_payment(order_id: int):
    order = PaymentOrder.query.get_or_404(order_id)
    claims = get_jwt()
    if claims.get("role") != "admin" and str(order.user_id) != str(claims.get("sub")):
        raise AuthorizationError("无权限操作该订单")

    data = request.get_json(silent=True) or {}
    success_url = data.get("success_url") or "https://example.com/payment/success"
    cancel_url = data.get("cancel_url") or "https://example.com/payment/cancel"

    if order.provider == "stripe":
        session = stripe_service.create_checkout_session(
            order_no=order.order_no,
            amount=order.amount,
            currency=order.currency,
            success_url=success_url,
            cancel_url=cancel_url,
        )
        order.external_order_id = session.id
        db.session.commit()
        return jsonify(
            order=order.to_dict(),
            checkout_session_id=session.id,
            checkout_url=session.url,
        ), 200

    raise ValidationError("当前仅实现 stripe 支付会话封装", field="provider", value=order.provider)


@payment_bp.post("/webhook/stripe")
def stripe_webhook():
    payload = request.get_data(cache=False)
    signature = request.headers.get("Stripe-Signature", "")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")

    try:
        event = stripe_service.verify_webhook_signature(payload, signature, webhook_secret)
    except stripe_service.StripeWebhookError as exc:
        logger.warning("Stripe webhook 验签失败: %s", exc)
        return jsonify(message="invalid signature", detail=str(exc)), 400

    event_id = event.get("id")
    event_type = event.get("type")
    data_object = (event.get("data") or {}).get("object") or {}

    if event_id and PaymentTransaction.query.filter_by(event_id=event_id).first():
        return jsonify(message="duplicate webhook ignored", event_id=event_id), 200

    order_no = (
        ((data_object.get("metadata") or {}).get("order_no"))
        or data_object.get("client_reference_id")
    )
    if not order_no:
        return jsonify(message="order_no not found in webhook payload"), 400

    order = PaymentOrder.query.filter_by(order_no=order_no).first()
    if not order:
        return jsonify(message=f"order not found: {order_no}"), 404

    if event_type == "checkout.session.completed":
        order.status = "paid"
        order.paid_at = _to_datetime_from_ts(data_object.get("created")) or datetime.now(timezone.utc)
        order.external_order_id = data_object.get("id") or order.external_order_id
        if order.payment_type == "subscription":
            order.subscription_status = "active"
            order.invoice_id = data_object.get("invoice") or order.invoice_id
    elif event_type == "invoice.paid":
        order.status = "paid"
        order.invoice_id = data_object.get("id") or order.invoice_id
        if order.payment_type == "subscription":
            order.subscription_status = "active"
    elif event_type == "invoice.payment_failed":
        order.status = "failed"
        if order.payment_type == "subscription":
            order.subscription_status = "past_due"
    elif event_type in ("customer.subscription.updated", "customer.subscription.deleted"):
        new_status = data_object.get("status")
        if isinstance(new_status, str) and new_status:
            order.subscription_status = new_status
        if event_type == "customer.subscription.deleted":
            order.status = "canceled"

    tx = PaymentTransaction(
        order_id=order.id,
        provider="stripe",
        event_id=event_id,
        event_type=event_type,
        transaction_id=data_object.get("payment_intent") or data_object.get("id"),
        amount=(data_object.get("amount_total") or data_object.get("amount_paid") or 0) / 100.0
        if (data_object.get("amount_total") or data_object.get("amount_paid")) is not None
        else None,
        currency=(data_object.get("currency") or order.currency or "USD").upper(),
        status="processed",
        signature_verified=True,
        raw_payload=payload.decode("utf-8", errors="replace"),
    )

    db.session.add(tx)
    db.session.commit()
    return jsonify(message="webhook processed", event_id=event_id, order=order.to_dict()), 200


@payment_bp.get("/orders/<int:order_id>")
@jwt_required()
def get_order(order_id: int):
    order = PaymentOrder.query.get_or_404(order_id)
    claims = get_jwt()
    if claims.get("role") != "admin" and str(order.user_id) != str(claims.get("sub")):
        raise AuthorizationError("无权限访问该订单")

    txs = PaymentTransaction.query.filter_by(order_id=order.id).order_by(PaymentTransaction.id.desc()).all()
    return jsonify(order=order.to_dict(), transactions=[t.to_dict() for t in txs]), 200
