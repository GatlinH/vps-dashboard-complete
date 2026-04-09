"""错误处理测试"""


def test_404_returns_json(client):
    """测试 404 返回 JSON 格式"""
    response = client.get('/api/nonexistent-route-xyz')
    assert response.status_code == 404
    data = response.get_json()
    assert data is not None
    assert data.get('success') is False


def test_method_not_allowed(client):
    """测试 405 处理"""
    response = client.delete('/health')
    assert response.status_code == 405
