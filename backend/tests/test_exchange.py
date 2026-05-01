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


# ──────────────────────────────────────────────────────────────────────────────
# /estimate 测试
# ──────────────────────────────────────────────────────────────────────────────

def test_estimate_with_buy_date(client):
    """使用 buy_date 成功返回估值结果"""
    payload = {
        "price": 365,
        "period": "yearly",
        "buy_date": "2026-01-01",
        "premium_percent": 20,
    }
    resp = client.post('/api/v1/exchange/estimate', json=payload)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get('ok') is True
    d = data['data']
    assert d['price'] == 365
    assert d['period'] == 'yearly'
    assert d['total_days'] == 365
    assert d['buy_date'] == '2026-01-01'
    assert d['premium_percent'] == 20
    assert 'days_used' in d
    assert 'days_left' in d
    assert 'daily_rate' in d
    assert 'consumed_value' in d
    assert 'residual_value' in d
    assert 'suggested_price' in d
    assert 'residual_percent' in d
    assert 0 <= d['residual_percent'] <= 100


def test_estimate_with_expiry(client):
    """使用 expiry 成功，自动反推 buy_date"""
    payload = {
        "price": 30,
        "period": "monthly",
        "expiry": "2026-12-01",
    }
    resp = client.post('/api/v1/exchange/estimate', json=payload)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data.get('ok') is True
    d = data['data']
    assert d['period'] == 'monthly'
    assert d['total_days'] == 30
    assert d['expiry'] == '2026-12-01'
    # buy_date 应早于 expiry 整整 30 天
    from datetime import date
    buy = date.fromisoformat(d['buy_date'])
    exp = date.fromisoformat(d['expiry'])
    assert (exp - buy).days == 30


def test_estimate_invalid_period(client):
    """非法 period 返回 400"""
    resp = client.post('/api/v1/exchange/estimate', json={
        "price": 100,
        "period": "biweekly",
        "buy_date": "2026-01-01",
    })
    assert resp.status_code == 400
    data = resp.get_json()
    assert data.get('ok') is False
    assert 'period' in data.get('error', '').lower() or 'period' in str(data)


def test_estimate_negative_price(client):
    """负数 price 返回 400"""
    resp = client.post('/api/v1/exchange/estimate', json={
        "price": -50,
        "period": "monthly",
        "buy_date": "2026-01-01",
    })
    assert resp.status_code == 400
    data = resp.get_json()
    assert data.get('ok') is False


def test_estimate_invalid_date_format(client):
    """非法日期格式返回 400"""
    resp = client.post('/api/v1/exchange/estimate', json={
        "price": 100,
        "period": "monthly",
        "buy_date": "20260101",  # 格式错误
    })
    assert resp.status_code == 400
    data = resp.get_json()
    assert data.get('ok') is False


def test_estimate_expiry_before_buy_date(client):
    """expiry 早于 buy_date 返回 400"""
    resp = client.post('/api/v1/exchange/estimate', json={
        "price": 100,
        "period": "monthly",
        "buy_date": "2026-06-01",
        "expiry": "2026-01-01",
    })
    assert resp.status_code == 400
    data = resp.get_json()
    assert data.get('ok') is False
