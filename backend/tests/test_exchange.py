"""汇率 API 测试"""
from unittest.mock import patch, MagicMock
import fakeredis
import api.exchange as exchange_module


def test_get_rates_fallback(client):
    """上游 API 不可用时，返回降级默认值"""
    with patch('api.exchange.req.get', side_effect=Exception("网络错误")):
        response = client.get('/api/v1/exchange/rates?base=CNY')
    assert response.status_code == 200
    data = response.get_json()
    assert data.get('fallback') is True
    assert 'rates' in data
    assert 'USD' in data['rates']


def test_get_rates_success(client):
    """上游 API 正常时，返回真实汇率数据"""
    mock_resp = MagicMock()
    mock_resp.raise_for_status.return_value = None
    mock_resp.json.return_value = {
        "result": "success",
        "time_last_update_utc": "2026-04-10T00:00:00Z",
        "rates": {
            "CNY": 1.0, "USD": 0.138, "EUR": 0.127,
            "GBP": 0.109, "JPY": 20.5, "HKD": 1.08
        }
    }
    fake_redis = fakeredis.FakeRedis(decode_responses=True)
    with patch.object(exchange_module, 'redis_client', fake_redis), \
         patch('api.exchange.req.get', return_value=mock_resp):
        response = client.get('/api/v1/exchange/rates?base=CNY')
    assert response.status_code == 200
    data = response.get_json()
    assert data.get('fallback') is not True
    assert data['base'] == 'CNY'
    assert 'USD' in data['rates']


def test_get_rates_cache_hit(client):
    """缓存命中时返回 from_cache=True"""
    mock_resp = MagicMock()
    mock_resp.raise_for_status.return_value = None
    mock_resp.json.return_value = {
        "result": "success",
        "time_last_update_utc": "2026-04-10T00:00:00Z",
        "rates": {
            "CNY": 1.0, "USD": 0.138, "EUR": 0.127,
            "GBP": 0.109, "JPY": 20.5, "HKD": 1.08
        }
    }
    fake_redis = fakeredis.FakeRedis(decode_responses=True)
    with patch.object(exchange_module, 'redis_client', fake_redis), \
         patch('api.exchange.req.get', return_value=mock_resp):
        client.get('/api/v1/exchange/rates?base=CNY')  # 第一次，写缓存
        response = client.get('/api/v1/exchange/rates?base=CNY')  # 第二次，命中缓存
    data = response.get_json()
    assert data.get('from_cache') is True
