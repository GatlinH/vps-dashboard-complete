from unittest.mock import patch


class FakeResponse:
    def __init__(self, status=200, headers=None, body=b'{}'):
        self.status = status
        self.headers = headers or {}
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self._body


def _login(client):
    resp = client.post('/api/v1/auth/login', json={'username': 'admin', 'password': 'TestAdmin@123456'})
    assert resp.status_code == 200
    return {'Authorization': f"Bearer {resp.get_json()['access_token']}"}


def test_update_status_requires_auth(client):
    resp = client.get('/api/v1/ops/updates/status')
    assert resp.status_code == 401


def test_update_check_reads_ghcr_manifests_without_restart(client):
    headers = _login(client)
    opened = []

    def fake_urlopen(req, timeout=0):
        opened.append(req.full_url)
        return FakeResponse(headers={'Docker-Content-Digest': 'sha256:testdigest'})

    with patch('api.ops.urllib.request.urlopen', side_effect=fake_urlopen):
        resp = client.post('/api/v1/ops/updates/check', headers=headers)

    assert resp.status_code == 200
    data = resp.get_json()
    assert data['ok'] is True
    assert data['action'] == 'check'
    assert data['update_available'] is None
    assert len(data['images']) == 2
    assert any('vps-dashboard-complete-backend' in url for url in opened)
    assert any('vps-dashboard-complete-frontend' in url for url in opened)


def test_update_apply_triggers_watchtower_http_api_only_after_admin_action(client, monkeypatch):
    headers = _login(client)
    monkeypatch.setenv('WATCHTOWER_HTTP_API_TOKEN', 'test-token')
    requests = []

    def fake_urlopen(req, timeout=0):
        requests.append(req)
        return FakeResponse(status=200, body=b'{"ok": true}')

    with patch('api.ops.urllib.request.urlopen', side_effect=fake_urlopen):
        resp = client.post('/api/v1/ops/updates/apply', headers=headers)

    assert resp.status_code == 202
    data = resp.get_json()
    assert data['ok'] is True
    assert data['action'] == 'apply'
    assert data['msg'] == '已触发 Watchtower 手动更新'
    assert requests[0].full_url.endswith('/v1/update')
    assert requests[0].get_method() == 'POST'
    assert requests[0].headers['Authorization'] == 'Bearer test-token'


def test_update_apply_requires_watchtower_token(client, monkeypatch):
    headers = _login(client)
    monkeypatch.delenv('WATCHTOWER_HTTP_API_TOKEN', raising=False)
    resp = client.post('/api/v1/ops/updates/apply', headers=headers)
    assert resp.status_code == 503
    assert 'WATCHTOWER_HTTP_API_TOKEN' in resp.get_json()['msg']
