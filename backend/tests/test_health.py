"""健康检查端点测试"""


def test_health_endpoint(client):
    """测试 /health 端点返回 200"""
    response = client.get('/health')
    assert response.status_code == 200
    data = response.get_json()
    assert data['status'] == 'ok'
    assert 'timestamp' in data
    assert 'version' in data


def test_health_has_version(client):
    """测试健康检查包含版本信息"""
    response = client.get('/health')
    data = response.get_json()
    assert data['version'] == '1.0.0'


def test_health_includes_dependency_checks(client):
    """P1 回归：健康检查必须包含 db 和 redis 的状态字段"""
    response = client.get('/health')
    assert response.status_code == 200
    data = response.get_json()
    assert 'checks' in data, "健康检查响应缺少 checks 字段"
    assert data['checks'].get('db') == 'ok', "DB 健康检查应报告 ok"
    assert data['checks'].get('redis') == 'ok', "Redis 健康检查应报告 ok"
