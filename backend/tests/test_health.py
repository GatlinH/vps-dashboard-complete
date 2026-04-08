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
