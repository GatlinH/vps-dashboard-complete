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


def test_ping_batch_hard_limit(client, auth_headers):
    """POST /api/probe/ping/batch 超过批次上限返回 400"""
    with client.application.app_context():
        client.application.config['PROBE_BATCH_MAX_ITEMS'] = 1
    resp = client.post('/api/v1/probe/ping/batch', json={'server_ids': [1, 2]}, headers=auth_headers)
    assert resp.status_code == 400
    assert resp.get_json().get('error_code') == 'BATCH_TOO_LARGE'


def test_ip_info_returns_cache_headers(client):
    """GET /api/probe/ip-info 返回缓存相关响应头"""
    mock_resp = MagicMock()
    mock_resp.read.return_value = b'{"status":"success","query":"8.8.8.8"}'
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)

    with patch('urllib.request.urlopen', return_value=mock_resp):
        resp = client.get('/api/v1/probe/ip-info?ip=8.8.8.8')

    assert resp.status_code == 200
    assert resp.headers.get('X-Cache') in {'HIT', 'MISS'}
    assert 'max-age=' in (resp.headers.get('Cache-Control') or '')


# ── ping_batch 并发化专项测试 ─────────────────────────────────────────────────

def test_ping_batch_concurrent_multiple_targets(client, auth_headers, app):
    """ping_batch 对多个目标并发探测后，结果数量和关键字段都正确。"""
    from extensions import db
    from models.models import Server

    # 创建两台有 IP 的测试服务器
    with app.app_context():
        app.config['PROBE_BATCH_MAX_ITEMS'] = 50  # 确保批次上限不干扰本测试
        s1 = Server(name='batch-s1', ip='10.0.0.1', group_name='test',
                    cpu_cores=2, ram_gb=4.0, disk_gb=50, price=10.0, period='monthly')
        s2 = Server(name='batch-s2', ip='10.0.0.2', group_name='test',
                    cpu_cores=2, ram_gb=4.0, disk_gb=50, price=10.0, period='monthly')
        db.session.add_all([s1, s2])
        db.session.commit()
        sid1, sid2 = s1.id, s2.id

    with patch('api.probe.tcp_ping') as mock_ping:
        mock_ping.return_value = {'success': True, 'latency_ms': 8.0, 'error': None}
        resp = client.post(
            '/api/v1/probe/ping/batch',
            json={'server_ids': [sid1, sid2]},
            headers=auth_headers,
        )

    assert resp.status_code == 200
    data = resp.get_json()
    results = data.get('results', {})
    # 两台服务器均应有对应结果
    assert str(sid1) in results
    assert str(sid2) in results
    # 每条结果应包含 success 字段
    assert 'success' in results[str(sid1)]
    assert 'success' in results[str(sid2)]
    # tcp_ping 被调用了 2 次（并发，每台一次）
    assert mock_ping.call_count == 2


def test_ping_batch_single_failure_does_not_fail_batch(client, auth_headers, app):
    """单个目标探测失败不会导致整个 batch 返回非 200 或其他目标结果缺失。"""
    from extensions import db
    from models.models import Server

    with app.app_context():
        app.config['PROBE_BATCH_MAX_ITEMS'] = 50  # 确保批次上限不干扰本测试
        s_ok  = Server(name='batch-ok',  ip='10.0.1.1', group_name='test',
                       cpu_cores=2, ram_gb=4.0, disk_gb=50, price=10.0, period='monthly')
        s_bad = Server(name='batch-bad', ip='10.0.1.2', group_name='test',
                       cpu_cores=2, ram_gb=4.0, disk_gb=50, price=10.0, period='monthly')
        db.session.add_all([s_ok, s_bad])
        db.session.commit()
        sid_ok, sid_bad = s_ok.id, s_bad.id

    def _selective_ping(host, port, timeout=5.0):
        if host == '10.0.1.2':
            return {'success': False, 'latency_ms': None, 'error': 'timeout'}
        return {'success': True, 'latency_ms': 5.0, 'error': None}

    with patch('api.probe.tcp_ping', side_effect=_selective_ping):
        resp = client.post(
            '/api/v1/probe/ping/batch',
            json={'server_ids': [sid_ok, sid_bad]},
            headers=auth_headers,
        )

    assert resp.status_code == 200
    results = resp.get_json().get('results', {})
    # 两台均应有结果
    assert str(sid_ok)  in results
    assert str(sid_bad) in results
    # 成功目标 success=True，失败目标 success=False，但 batch 整体不崩溃
    assert results[str(sid_ok)]['success']  is True
    assert results[str(sid_bad)]['success'] is False


def test_ping_batch_no_ip_server_returns_error_entry(client, auth_headers, app):
    """无 IP 的服务器在 batch 结果中应返回 error 字段，而不是让整个 batch 失败。"""
    from extensions import db
    from models.models import Server

    with app.app_context():
        s_no_ip = Server(name='batch-noip', ip='', group_name='test',
                         cpu_cores=2, ram_gb=4.0, disk_gb=50, price=10.0, period='monthly')
        db.session.add(s_no_ip)
        db.session.commit()
        sid_no_ip = s_no_ip.id

    with patch('api.probe.tcp_ping') as mock_ping:
        mock_ping.return_value = {'success': True, 'latency_ms': 5.0, 'error': None}
        resp = client.post(
            '/api/v1/probe/ping/batch',
            json={'server_ids': [sid_no_ip]},
            headers=auth_headers,
        )

    assert resp.status_code == 200
    results = resp.get_json().get('results', {})
    assert str(sid_no_ip) in results
    assert 'error' in results[str(sid_no_ip)]
    # tcp_ping 不应为无 IP 的服务器发起调用
    mock_ping.assert_not_called()
