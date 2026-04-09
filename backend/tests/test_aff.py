"""AFF 市场 API 测试"""


def test_list_aff_products_public(client):
    """测试公开获取 AFF 商品列表（无需认证）"""
    response = client.get('/api/aff/')
    assert response.status_code == 200
    data = response.get_json()
    assert 'products' in data
    assert 'count' in data


def test_create_aff_product_requires_auth(client):
    """测试创建 AFF 商品需要认证"""
    response = client.post('/api/aff/', json={
        'provider': 'Test Provider',
        'cpu': '2 cores',
        'ram': '4GB',
        'price': 10.0
    })
    assert response.status_code == 401


def test_create_aff_product_with_auth(client, auth_headers):
    """测试使用认证创建 AFF 商品"""
    response = client.post('/api/aff/', json={
        'provider': 'Test Provider',
        'cpu': '2 cores',
        'ram': '4GB',
        'disk': '50GB',
        'location': '美国',
        'price': 10.0,
        'currency': 'USD'
    }, headers=auth_headers)
    # 应该返回 201 (成功) 或 403 (非管理员)
    assert response.status_code in (201, 403)


def test_filter_aff_products_by_stock(client):
    """测试按库存过滤商品"""
    response = client.get('/api/aff/?stock=avail')
    assert response.status_code == 200
    data = response.get_json()
    assert 'products' in data
