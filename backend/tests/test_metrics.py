"""Metrics 端点与关键计数测试。"""

from middleware.metrics_middleware import (
    _is_metrics_allowed,
    record_alert_fired,
    record_auth_login,
    record_email_sent,
    record_probe_latency,
    record_token_revocation,
    record_traffic_limit_exceeded,
    set_server_counts,
)


def _get_metric_value(client, metric_name: str) -> float:
    text = client.get('/metrics').data.decode()
    total = 0.0
    for line in text.splitlines():
        if line.startswith('#'):
            continue
        if line.startswith(metric_name):
            try:
                total += float(line.rsplit(' ', 1)[-1])
            except ValueError:
                pass
    return total


# ── P0 回归：/metrics IP 白名单 ───────────────────────────────────────────────

def test_metrics_allowed_ips():
    """P0 回归：验证 _is_metrics_allowed 白名单逻辑覆盖所有内网段。"""
    # 允许：loopback / Docker 内网
    assert _is_metrics_allowed("127.0.0.1") is True
    assert _is_metrics_allowed("::1") is True
    assert _is_metrics_allowed("10.0.0.1") is True
    assert _is_metrics_allowed("172.17.0.2") is True     # Docker 默认桥接
    assert _is_metrics_allowed("192.168.1.100") is True

    # 拒绝：公网 IP
    assert _is_metrics_allowed("8.8.8.8") is False
    assert _is_metrics_allowed("1.2.3.4") is False
    assert _is_metrics_allowed("203.0.113.5") is False

    # 边界：空字符串 / 非法 IP
    assert _is_metrics_allowed("") is False
    assert _is_metrics_allowed("not-an-ip") is False


def test_metrics_endpoint_blocked_for_external_ip(client, app):
    """P0 回归：公网 IP 访问 /metrics 应被拒绝（403）。"""
    with app.test_request_context():
        with client.application.test_client() as c:
            # 模拟公网 IP 访问
            resp = c.get('/metrics', environ_base={"REMOTE_ADDR": "8.8.8.8"})
            assert resp.status_code == 403, (
                f"/metrics 应对公网 IP 返回 403，实际返回 {resp.status_code}"
            )


def test_metrics_endpoint_allowed_for_localhost(client):
    """P0 回归：localhost 访问 /metrics 应正常返回（200）。"""
    # Flask 测试客户端默认 remote_addr=127.0.0.1，属于白名单
    resp = client.get('/metrics', environ_base={"REMOTE_ADDR": "127.0.0.1"})
    assert resp.status_code == 200


def test_metrics_endpoint_available(client):
    res = client.get('/metrics')
    assert res.status_code == 200
    assert 'text/plain' in res.content_type or 'openmetrics' in res.content_type


def test_request_metric_increments_after_api_call(client):
    before = _get_metric_value(client, 'vps_requests_total')
    client.get('/api/v1/servers/')
    after = _get_metric_value(client, 'vps_requests_total')
    assert after > before


def test_error_metric_increments_on_404(client):
    before = _get_metric_value(client, 'vps_request_errors_total')
    client.get('/api/v1/not-found-xyz')
    after = _get_metric_value(client, 'vps_request_errors_total')
    assert after > before


def test_metrics_path_is_ignored_in_endpoint_labels(client):
    client.get('/metrics')
    body = client.get('/metrics').data.decode()
    assert 'endpoint="/metrics"' not in body


def test_business_gauges_exist(client):
    body = client.get('/metrics').data.decode()
    assert 'vps_servers_total' in body
    assert 'vps_servers_online' in body
    assert 'vps_servers_offline' in body


def test_business_metrics_helpers_are_exposed_in_metrics(client):
    set_server_counts(total=3, online=2, offline=1)
    record_auth_login("success")
    record_token_revocation("access")
    record_alert_fired("traffic", "telegram")
    record_traffic_limit_exceeded()
    record_probe_latency(88.2)
    record_email_sent("welcome", "success")

    body = client.get('/metrics').data.decode()
    assert 'vps_servers_total 3.0' in body
    assert 'vps_servers_online 2.0' in body
    assert 'vps_servers_offline 1.0' in body
    assert 'vps_auth_logins_total{status="success"}' in body
    assert 'vps_auth_token_revocations_total{token_type="access"}' in body
    assert 'vps_alerts_fired_total{alert_type="traffic",channel="telegram"}' in body
    assert 'vps_traffic_limit_exceeded_total' in body
    assert 'vps_probe_latency_ms_bucket' in body
    assert 'vps_email_sent_total{status="success",template="welcome"}' in body
