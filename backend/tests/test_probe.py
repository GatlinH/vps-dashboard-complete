"""Probe API 测试"""
from unittest.mock import patch, MagicMock


def test_ping_requires_auth(client):
    """POST /api/probe/ping 未认证返回 401"""
    resp = client.post('/api/v1/probe/ping', json={'host': '1.2.3.4', 'port': 80})
    assert resp.status_code == 401


def test_ping_with_admin_auth(client, auth_headers):
    """POST /api/probe/ping 需要 admin 权限，认证后可调用"""
    with patch('api.probe.tcp_ping') as mock_ping:
        mock_ping.return_value = {'success': True, 'latency_ms': 10.0, 'error': None}
        resp = client.post('/api/v1/probe/ping', json={
            'host': '1.2.3.4',
            'port': 80,
            'count': 1,
        }, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'results' in data
    assert 'stats' in data


def test_ping_missing_host(client, auth_headers):
    """POST /api/probe/ping 缺少 host 参数返回 400"""
    resp = client.post('/api/v1/probe/ping', json={}, headers=auth_headers)
    assert resp.status_code == 400


def test_ping_rejects_invalid_port(client, auth_headers):
    """POST /api/probe/ping 非法端口返回 400"""
    resp = client.post('/api/v1/probe/ping', json={
        'host': '1.2.3.4',
        'port': 70000,
    }, headers=auth_headers)
    assert resp.status_code == 400


def test_ping_rejects_invalid_host(client, auth_headers):
    """POST /api/probe/ping 非法 host 返回 400"""
    resp = client.post('/api/v1/probe/ping', json={
        'host': 'bad host',
        'port': 80,
    }, headers=auth_headers)
    assert resp.status_code == 400


def test_ping_batch_requires_auth(client):
    """POST /api/probe/ping/batch 未认证返回 401"""
    resp = client.post('/api/v1/probe/ping/batch', json={})
    assert resp.status_code == 401


def test_ping_batch_with_admin_auth(client, auth_headers):
    """POST /api/probe/ping/batch 认证后可调用"""
    with patch('api.probe.tcp_ping') as mock_ping:
        mock_ping.return_value = {'success': True, 'latency_ms': 5.0, 'error': None}
        resp = client.post('/api/v1/probe/ping/batch', json={}, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'results' in data


def test_ip_info_public(client):
    """GET /api/probe/ip-info 公开接口可访问（mock 外部请求）"""
    mock_resp = MagicMock()
    mock_resp.read.return_value = b'{"status":"success","country":"China","query":"1.2.3.4"}'
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)

    with patch('urllib.request.urlopen', return_value=mock_resp):
        resp = client.get('/api/v1/probe/ip-info?ip=1.2.3.4')
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'status' in data


def test_ip_info_public_no_auth_required(client):
    """GET /api/probe/ip-info 无需认证即可访问"""
    mock_resp = MagicMock()
    mock_resp.read.return_value = b'{"status":"success","query":"8.8.8.8"}'
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)

    with patch('urllib.request.urlopen', return_value=mock_resp):
        resp = client.get('/api/v1/probe/ip-info?ip=8.8.8.8')
    # 公开接口，不需要认证
    assert resp.status_code != 401


def test_ip_info_rejects_invalid_ip(client):
    """GET /api/probe/ip-info 非法 IP 返回 400"""
    resp = client.get('/api/v1/probe/ip-info?ip=example.com')
    assert resp.status_code == 400
