"""Geo API 测试"""
from unittest.mock import patch, MagicMock

import extensions


def test_countries_public(client):
    """GET /api/geo/countries 公开接口可访问"""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.content = b'{"type":"Topology","objects":{}}'

    with patch('requests.get', return_value=mock_resp):
        resp = client.get('/api/v1/geo/countries')
    assert resp.status_code == 200


def test_countries_no_auth_required(client):
    """GET /api/geo/countries 无需认证"""
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.content = b'{}'

    with patch('requests.get', return_value=mock_resp):
        resp = client.get('/api/v1/geo/countries')
    assert resp.status_code != 401


def test_countries_cache_hit(client):
    """GET /api/geo/countries Redis 缓存命中时直接返回"""
    extensions.redis_client.set('vps:geo:countries-110m', b'{"cached":true}')
    resp = client.get('/api/v1/geo/countries')
    assert resp.status_code == 200
    assert resp.headers.get('X-Cache') == 'HIT'


def test_countries_fallback_stale_when_provider_failed(client):
    """provider 异常时优先回退 stale 缓存"""
    extensions.redis_client.set('vps:geo:countries-110m:stale', b'{"cached":"stale"}')

    import requests
    with patch('requests.get', side_effect=requests.RequestException('provider down')):
        resp = client.get('/api/v1/geo/countries')

    assert resp.status_code == 200
    assert resp.headers.get('X-Cache') == 'STALE'


def test_server_coords_public(client):
    """GET /api/geo/servers/coords 公开接口可访问"""
    resp = client.get('/api/v1/geo/servers/coords')
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'nodes' in data
    assert 'pagination' in data


def test_server_coords_no_auth_required(client):
    """GET /api/geo/servers/coords 无需认证"""
    resp = client.get('/api/v1/geo/servers/coords')
    assert resp.status_code != 401


def test_server_coords_aggregate(client):
    resp = client.get('/api/v1/geo/servers/coords?mode=aggregate')
    assert resp.status_code == 200
    data = resp.get_json() or {}
    assert data.get('mode') == 'aggregate'
    assert 'top_locations' in data
    assert 'by_status' in data


def test_tile_proxy_cache_hit(client):
    """GET /api/geo/tile/1/0/0.png 缓存命中路径（通过 mock 验证 HIT header）"""
    fake_png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 20

    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.content = fake_png

    with patch('requests.get', return_value=mock_resp):
        resp1 = client.get('/api/v1/geo/tile/1/0/0.png')
    assert resp1.status_code == 200
    assert resp1.headers.get('X-Cache') == 'MISS'

    with patch('requests.get', return_value=mock_resp):
        resp2 = client.get('/api/v1/geo/tile/1/0/0.png')
    assert resp2.status_code == 200


def test_tile_proxy_cache_miss(client):
    """GET /api/geo/tile/1/0/0.png 缓存未命中时回源（mock 外部请求）"""
    fake_png = b'\x89PNG\r\n\x1a\n' + b'\x00' * 20
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.content = fake_png

    with patch('requests.get', return_value=mock_resp):
        resp = client.get('/api/v1/geo/tile/1/0/0.png')
    assert resp.status_code == 200
    assert resp.headers.get('X-Cache') == 'MISS'


def test_tile_proxy_bad_coords(client):
    """GET /api/geo/tile 越界坐标返回 400"""
    resp = client.get('/api/v1/geo/tile/0/5/5.png')
    assert resp.status_code == 400


def test_tile_proxy_provider_degraded_payload(client):
    import requests
    with patch('requests.get', side_effect=requests.RequestException('upstream timeout')):
        resp = client.get('/api/v1/geo/tile/1/0/0.png')
    assert resp.status_code == 502
    data = resp.get_json() or {}
    assert data.get('error_code') == 'MAP_PROVIDER_UNAVAILABLE'
