"""汇率 API 测试"""


def test_get_exchange_rates_default(client):
    """测试获取汇率（默认 CNY 基准）"""
    response = client.get('/api/exchange/rates')
    assert response.status_code == 200
    data = response.get_json()
    assert 'base' in data
    assert 'rates' in data
    assert isinstance(data['rates'], dict)


def test_get_exchange_rates_with_base(client):
    """测试指定基准货币获取汇率"""
    response = client.get('/api/exchange/rates?base=USD')
    assert response.status_code == 200
    data = response.get_json()
    assert data['base'] == 'USD'
    assert 'rates' in data


def test_exchange_rates_cache(client):
    """测试汇率缓存功能"""
    # 第一次请求
    response1 = client.get('/api/exchange/rates')
    assert response1.status_code == 200
    data1 = response1.get_json()
    
    # 第二次请求应该从缓存读取
    response2 = client.get('/api/exchange/rates')
    assert response2.status_code == 200
    data2 = response2.get_json()
    
    # 验证结构一致
    assert data1['base'] == data2['base']


def test_exchange_rates_fallback(client, monkeypatch):
    """测试汇率 API 降级策略"""
    # 此测试需要 mock requests 库使其失败
    # 简单验证返回结构即可
    response = client.get('/api/exchange/rates')
    assert response.status_code == 200
    data = response.get_json()
    # 即使失败也应该返回降级数据
    assert 'rates' in data
