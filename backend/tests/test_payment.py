import time
import hashlib
import hmac
import json

from models.payment import PaymentOrder


def _sign(payload: bytes, secret: str, timestamp: int) -> str:
    signed = f"{timestamp}.{payload.decode('utf-8')}".encode("utf-8")
    digest = hmac.new(secret.encode("utf-8"), signed, hashlib.sha256).hexdigest()
    return f"t={timestamp},v1={digest}"


def test_payment_order_lifecycle_and_webhook(client, auth_headers, monkeypatch):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test_123")

    create_resp = client.post(
        "/api/v1/payment/orders",
        headers=auth_headers,
        json={
            "provider": "stripe",
            "payment_type": "subscription",
            "amount": 99.9,
            "currency": "usd",
            "metadata": {"plan": "pro"},
        },
    )
    assert create_resp.status_code == 201
    order = create_resp.get_json()["order"]
    assert order["status"] == "pending"
    assert order["subscription_status"] == "incomplete"

    pay_resp = client.post(
        f"/api/v1/payment/orders/{order['id']}/pay",
        headers=auth_headers,
        json={
            "success_url": "https://app.example.com/success",
            "cancel_url": "https://app.example.com/cancel",
        },
    )
    assert pay_resp.status_code == 200
    pay_data = pay_resp.get_json()
    assert pay_data["checkout_session_id"].startswith("cs_test_")
    assert "checkout_url" in pay_data

    ts = int(time.time())
    event = {
        "id": "evt_001",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": pay_data["checkout_session_id"],
                "created": ts,
                "currency": "usd",
                "amount_total": 9990,
                "invoice": "in_001",
                "metadata": {"order_no": order["order_no"]},
            }
        },
    }
    payload = json.dumps(event).encode("utf-8")
    header = _sign(payload, "whsec_test_123", ts)
    webhook_resp = client.post(
        "/api/v1/payment/webhook/stripe",
        data=payload,
        headers={"Stripe-Signature": header, "Content-Type": "application/json"},
    )
    assert webhook_resp.status_code == 200
    body = webhook_resp.get_json()
    assert body["message"] == "webhook processed"
    assert body["order"]["status"] == "paid"
    assert body["order"]["subscription_status"] == "active"

    # duplicate should be idempotent
    dup = client.post(
        "/api/v1/payment/webhook/stripe",
        data=payload,
        headers={"Stripe-Signature": header, "Content-Type": "application/json"},
    )
    assert dup.status_code == 200
    assert dup.get_json()["message"] == "duplicate webhook ignored"



def test_webhook_signature_verification_failed(client, monkeypatch, app):
    monkeypatch.setenv("STRIPE_WEBHOOK_SECRET", "whsec_real")

    with app.app_context():
        order = PaymentOrder(
            order_no="ORD-TEST-SIG-001",
            user_id=1,
            provider="stripe",
            payment_type="one_time",
            amount=10,
            currency="USD",
            status="pending",
            metadata_json={},
        )
        from extensions import db

        db.session.add(order)
        db.session.commit()

    ts = int(time.time())
    event = {
        "id": "evt_bad_sig",
        "type": "invoice.paid",
        "data": {"object": {"id": "in_abc", "metadata": {"order_no": "ORD-TEST-SIG-001"}}},
    }
    payload = json.dumps(event).encode("utf-8")
    bad_header = _sign(payload, "wrong_secret", ts)

    resp = client.post(
        "/api/v1/payment/webhook/stripe",
        data=payload,
        headers={"Stripe-Signature": bad_header, "Content-Type": "application/json"},
    )
    assert resp.status_code == 400
    assert "invalid signature" in resp.get_json()["message"]
