"""AFF 市场 API 测试"""


def test_list_products_public(client):
    """GET /api/aff/ 公开接口可访问"""
    resp = client.get('/api/v1/aff/')
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'products' in data
    assert 'count' in data


def test_list_products_no_auth_required(client):
    """GET /api/aff/ 无需认证"""
    resp = client.get('/api/v1/aff/')
    assert resp.status_code != 401


def test_create_product_requires_auth(client):
    """POST /api/aff/ 未认证返回 401"""
    resp = client.post('/api/v1/aff/', json={
        'provider': 'TestProvider',
        'price': 9.9,
    })
    assert resp.status_code == 401


def test_create_product_with_admin(client, auth_headers):
    """POST /api/aff/ admin 权限可创建商品"""
    resp = client.post('/api/v1/aff/', json={
        'provider': 'TestVPS',
        'stock': 'avail',
        'cpu': '2 Core',
        'ram': '2GB',
        'disk': '50GB SSD',
        'bandwidth': '1TB',
        'location': '日本',
        'price': 5.0,
        'currency': 'USD',
        'period': 'monthly',
    }, headers=auth_headers)
    assert resp.status_code == 201
    data = resp.get_json()
    assert data.get('product', {}).get('provider') == 'TestVPS'


def test_create_product_missing_provider(client, auth_headers):
    """POST /api/aff/ 缺少 provider 返回 400"""
    resp = client.post('/api/v1/aff/', json={
        'price': 9.9,
    }, headers=auth_headers)
    assert resp.status_code == 400


def test_update_product_requires_auth(client, auth_headers):
    """PUT /api/aff/<id> 未认证返回 401"""
    # 先创建一个商品
    create_resp = client.post('/api/v1/aff/', json={
        'provider': 'UpdateTest',
        'price': 1.0,
    }, headers=auth_headers)
    pid = create_resp.get_json()['product']['id']

    # 无认证更新应返回 401
    resp = client.put(f'/api/v1/aff/{pid}', json={'price': 2.0})
    assert resp.status_code == 401


def test_update_product_with_admin(client, auth_headers):
    """PUT /api/aff/<id> admin 权限可更新商品"""
    create_resp = client.post('/api/v1/aff/', json={
        'provider': 'OriginalProvider',
        'price': 3.0,
    }, headers=auth_headers)
    pid = create_resp.get_json()['product']['id']

    resp = client.put(f'/api/v1/aff/{pid}', json={
        'provider': 'UpdatedProvider',
        'price': 6.0,
    }, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data['product']['provider'] == 'UpdatedProvider'
    assert data['product']['price'] == 6.0


def test_delete_product_requires_auth(client, auth_headers):
    """DELETE /api/aff/<id> 未认证返回 401"""
    create_resp = client.post('/api/v1/aff/', json={
        'provider': 'DeleteTest',
        'price': 1.0,
    }, headers=auth_headers)
    pid = create_resp.get_json()['product']['id']

    resp = client.delete(f'/api/v1/aff/{pid}')
    assert resp.status_code == 401


def test_list_products_with_stock_filter(client, auth_headers):
    """GET /api/aff/?stock=avail 过滤可购商品"""
    client.post('/api/v1/aff/', json={
        'provider': 'StockTest',
        'stock': 'avail',
        'price': 1.0,
    }, headers=auth_headers)

    resp = client.get('/api/v1/aff/?stock=avail')
    assert resp.status_code == 200
    data = resp.get_json()
    assert all(p['stock'] == 'avail' for p in data['products'])
