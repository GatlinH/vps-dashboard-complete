"""认证 API 测试"""


def test_login_success(client):
    """测试管理员登录成功"""
    response = client.post('/api/auth/login', json={
        'username': 'admin',
        'password': 'TestAdmin@123456',
    })
    assert response.status_code == 200
    data = response.get_json()
    assert 'access_token' in data
    assert 'refresh_token' in data


def test_login_wrong_password(client):
    """测试密码错误返回 401"""
    response = client.post('/api/auth/login', json={
        'username': 'admin',
        'password': 'wrongpassword',
    })
    assert response.status_code == 401


def test_login_missing_fields(client):
    """测试缺少字段返回 400"""
    response = client.post('/api/auth/login', json={
        'username': 'admin',
    })
    assert response.status_code in (400, 422)


def test_protected_route_without_token(client):
    """测试无 token 访问受保护路由（POST 创建需要认证）"""
    response = client.post('/api/servers/', json={'name': 'test'})
    assert response.status_code == 401


def test_protected_route_with_token(client, auth_headers):
    """测试有效 token 可以访问受保护路由"""
    response = client.get('/api/servers/', headers=auth_headers)
    assert response.status_code == 200
