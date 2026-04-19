"""关键 API 与错误路径测试。"""


def test_health_endpoint_ok(client):
    """健康检查应返回 200 与状态字段。"""
    res = client.get('/health')
    assert res.status_code == 200
    data = res.get_json()
    assert data['status'] == 'ok'
    assert 'timestamp' in data


def test_servers_create_requires_auth(client):
    """未认证用户创建服务器应被拒绝。"""
    res = client.post('/api/v1/servers/', json={'name': 's1', 'ip': '1.1.1.1'})
    assert res.status_code == 401


def test_servers_create_missing_required_field_returns_400(client, auth_headers):
    """缺少必填字段应走 ValidationError 400 路径。"""
    res = client.post('/api/v1/servers/', json={'name': 'missing-ip'}, headers=auth_headers)
    assert res.status_code == 400
    payload = res.get_json()
    assert payload['success'] is False
    assert payload['error_code'] == 'VALIDATION_ERROR'


def test_servers_update_invalid_expiry_returns_400(client, auth_headers, test_server):
    """非法日期应走校验错误路径。"""
    res = client.put(
        f'/api/v1/servers/{test_server}',
        json={'expiry': '2026-99-99'},
        headers=auth_headers,
    )
    assert res.status_code == 400
    body = res.get_json()
    assert body['error_code'] == 'VALIDATION_ERROR'


def test_undefined_route_returns_json_error(client):
    """未定义路由应返回统一 JSON 错误结构。"""
    res = client.get('/api/v1/this-route-does-not-exist')
    assert res.status_code == 404
    body = res.get_json()
    assert body['success'] is False
    assert body['error_code'] == 'HTTP_ERROR'
