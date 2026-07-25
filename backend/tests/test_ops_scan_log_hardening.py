"""安全回归：匿名 /api/v1/ops/security-scan-log 收紧。

该端点必须保持匿名（前端在 404 时上报疑似扫描路径），
因此不能加鉴权；改为：
  1) 加限流，防止匿名者刷爆运维事件表；
  2) 不信任客户端伪造的 ``ip`` 字段，来源 IP 只取服务端 remote_addr。
"""
from models.models import OpsEvent


def _count_scan_events(app):
    with app.app_context():
        return OpsEvent.query.filter_by(event_type="security_http_anomaly").count()


def test_scan_log_is_rate_limited(app):
    """匿名高频提交应触发 429，而不是无限写入运维事件。"""
    app.config["RATELIMIT_ENABLED"] = True
    app.config["SECURITY_SCAN_LOG_RATE_LIMIT"] = "3 per minute"
    try:
        app.limiter.enabled = True
    except Exception:
        pass
    client = app.test_client()

    statuses = []
    for _ in range(8):
        resp = client.post(
            "/api/v1/ops/security-scan-log",
            json={"path": "/.env", "method": "GET"},
        )
        statuses.append(resp.status_code)

    assert 429 in statuses, f"预期出现限流 429，实际: {statuses}"


def test_scan_log_ignores_client_supplied_ip(app):
    """客户端伪造的 ip 字段不得进入运维事件；来源以服务端 remote_addr 为准。"""
    app.config["RATELIMIT_ENABLED"] = False
    try:
        app.limiter.enabled = False
    except Exception:
        pass
    client = app.test_client()

    resp = client.post(
        "/api/v1/ops/security-scan-log",
        json={"path": "/.git/config", "method": "GET", "ip": "6.6.6.6"},
    )
    assert resp.status_code == 202

    with app.app_context():
        ev = (
            OpsEvent.query.filter_by(event_type="security_http_anomaly")
            .order_by(OpsEvent.id.desc())
            .first()
        )
        assert ev is not None
        payload = ev.payload or {}
        assert payload.get("ip") != "6.6.6.6", "服务端不得采用客户端伪造的 ip"
