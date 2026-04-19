"""Metrics 端点与关键计数测试。"""


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
