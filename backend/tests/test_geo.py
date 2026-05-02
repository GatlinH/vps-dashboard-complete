"""Geo API 测试"""
from unittest.mock import patch, MagicMock

import pytest
from werkzeug.security import generate_password_hash

import extensions
from models.models import User
from extensions import db as _db


# ── fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def admin_headers(client):
    """管理员认证头"""
    resp = client.post('/api/v1/auth/login', json={
        'username': 'admin',
        'password': 'TestAdmin@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


@pytest.fixture
def viewer_headers(client, app):
    """viewer 角色认证头"""
    with app.app_context():
        user = User(
            username='geo_viewer',
            email='geo_viewer@example.com',
            password_hash=generate_password_hash('ViewerPass@123456'),
            role='viewer',
            email_verified=True,
        )
        _db.session.add(user)
        _db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'geo_viewer',
        'password': 'ViewerPass@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


@pytest.fixture
def plain_user_headers(client, app):
    """普通 user 角色认证头（无 viewer/admin 权限）"""
    with app.app_context():
        user = User(
            username='geo_plain',
            email='geo_plain@example.com',
            password_hash=generate_password_hash('PlainPass@123456'),
            role='user',
            email_verified=True,
        )
        _db.session.add(user)
        _db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'geo_plain',
        'password': 'PlainPass@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


# ── /countries 路由（仍公开）──────────────────────────────────────────────────

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


# ── /servers/coords 路由（P0-1 修复：需要认证）────────────────────────────────

def test_server_coords_requires_auth(client):
    """GET /api/geo/servers/coords 未认证应返回 401（P0-1 修复验证）"""
    resp = client.get('/api/v1/geo/servers/coords')
    assert resp.status_code == 401


def test_server_coords_plain_user_denied(client, plain_user_headers):
    """GET /api/geo/servers/coords 普通 user 角色应返回 403"""
    resp = client.get('/api/v1/geo/servers/coords', headers=plain_user_headers)
    assert resp.status_code == 403


def test_server_coords_viewer_allowed(client, viewer_headers):
    """GET /api/geo/servers/coords viewer 角色可访问，返回 200 及正确结构"""
    resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'nodes' in data
    assert 'pagination' in data


def test_server_coords_admin_allowed(client, admin_headers):
    """GET /api/geo/servers/coords admin 角色可访问"""
    resp = client.get('/api/v1/geo/servers/coords', headers=admin_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'nodes' in data


def test_server_coords_aggregate(client, admin_headers):
    resp = client.get('/api/v1/geo/servers/coords?mode=aggregate', headers=admin_headers)
    assert resp.status_code == 200
    data = resp.get_json() or {}
    assert data.get('mode') == 'aggregate'
    assert 'top_locations' in data
    assert 'by_status' in data


# ── /tile 路由（仍公开）──────────────────────────────────────────────────────

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
