"""Metrics 端点与关键计数测试。"""

from middleware.metrics_middleware import (
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
