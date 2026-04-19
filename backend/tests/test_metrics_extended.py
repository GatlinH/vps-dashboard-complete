"""Metrics 额外测试：动态 endpoint 归一化。"""

from middleware.metrics_middleware import _normalize_endpoint


def test_normalize_endpoint_replaces_numeric_segments_only():
    assert _normalize_endpoint('/api/v1/servers/42/metrics') == '/api/v1/servers/:id/metrics'
    assert _normalize_endpoint('/api/v1/servers/42') == '/api/v1/servers/:id'
    assert _normalize_endpoint('/api/v1/servers/name-1') == '/api/v1/servers/name-1'


def test_metrics_uses_normalized_endpoint_labels(client, auth_headers, test_server):
    client.get(f'/api/v1/servers/{test_server}', headers=auth_headers)
    body = client.get('/metrics').data.decode()
    assert 'endpoint="/api/v1/servers/:id"' in body
