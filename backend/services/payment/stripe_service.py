from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from dataclasses import dataclass
from typing import Any


class StripeWebhookError(ValueError):
    """Webhook 验签/事件解析错误。"""


@dataclass
class CheckoutSession:
    id: str
    url: str


def _extract_signature(signature_header: str) -> tuple[int, list[str]]:
    ts = None
    signatures: list[str] = []
    for item in (signature_header or "").split(","):
        key, _, value = item.partition("=")
        key = key.strip()
        value = value.strip()
        if key == "t" and value.isdigit():
            ts = int(value)
        elif key == "v1" and value:
            signatures.append(value)
    if ts is None or not signatures:
        raise StripeWebhookError("Stripe-Signature 缺少 t 或 v1")
    return ts, signatures


def compute_signature(payload: bytes, webhook_secret: str, timestamp: int) -> str:
    signed_payload = f"{timestamp}.{payload.decode('utf-8')}".encode("utf-8")
    return hmac.new(webhook_secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()


def verify_webhook_signature(
    payload: bytes,
    signature_header: str,
    webhook_secret: str,
    tolerance_s: int = 300,
    now_ts: int | None = None,
) -> dict[str, Any]:
    if not webhook_secret:
        raise StripeWebhookError("未配置 STRIPE_WEBHOOK_SECRET")
    ts, signatures = _extract_signature(signature_header)

    now = now_ts if now_ts is not None else int(time.time())
    if abs(now - ts) > tolerance_s:
        raise StripeWebhookError("Webhook 时间戳超出容忍范围")

    expected = compute_signature(payload, webhook_secret, ts)
    if not any(hmac.compare_digest(expected, sig) for sig in signatures):
        raise StripeWebhookError("Webhook 签名校验失败")

    try:
        event = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise StripeWebhookError("Webhook payload 不是合法 JSON") from exc

    if not isinstance(event, dict):
        raise StripeWebhookError("Webhook payload 格式错误")
    return event


def create_checkout_session(order_no: str, amount: float, currency: str, success_url: str, cancel_url: str) -> CheckoutSession:
    """支付调用封装：当前返回可测试的本地 mock 会话。"""
    session_id = f"cs_test_{uuid.uuid4().hex[:20]}"
    url = (
        "https://checkout.stripe.mock/session"
        f"?sid={session_id}&order_no={order_no}&amount={amount}&currency={currency}"
        f"&success_url={success_url}&cancel_url={cancel_url}"
    )
    return CheckoutSession(id=session_id, url=url)
