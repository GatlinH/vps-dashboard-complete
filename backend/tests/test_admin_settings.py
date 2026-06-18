import json
from pathlib import Path


def test_login_settings_endpoints_require_existing_auth(client):
    assert client.get('/api/v1/ops/settings/login').status_code == 401
    assert client.put('/api/v1/ops/settings/login', json={}).status_code == 401


def test_login_settings_round_trip(client, auth_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))

    get_resp = client.get('/api/v1/ops/settings/login', headers=auth_headers)
    assert get_resp.status_code == 200
    data = get_resp.get_json()
    assert data['disable_password_login'] is False
    assert data['sso_enabled'] is False
    assert data['github_client_id'] == ''
    assert data['github_client_secret_masked'] == ''

    payload = {
        'disable_password_login': True,
        'sso_enabled': True,
        'github_client_id': 'gh-client-id',
        'github_client_secret': 'gh-secret-123456',
        'allowed_emails': 'a@example.com,b@example.com',
        'api_key_enabled': True,
    }
    put_resp = client.put('/api/v1/ops/settings/login', json=payload, headers=auth_headers)
    assert put_resp.status_code == 200
    saved = put_resp.get_json()
    assert saved['disable_password_login'] is True
    assert saved['sso_enabled'] is True
    assert saved['github_client_id'] == 'gh-client-id'
    assert saved['github_client_secret_masked'].startswith('gh-s')
    assert saved['api_key_enabled'] is True

    round_trip = client.get('/api/v1/ops/settings/login', headers=auth_headers)
    assert round_trip.status_code == 200
    round_data = round_trip.get_json()
    assert round_data['disable_password_login'] is True
    assert round_data['sso_enabled'] is True
    assert round_data['github_client_id'] == 'gh-client-id'
    assert round_data['github_client_secret_masked'].startswith('gh-s')
    assert round_data['allowed_emails'] == 'a@example.com,b@example.com'

    raw = json.loads(Path(settings_file).read_text())
    assert raw['login']['github_client_secret_masked'].startswith('gh-s')
    assert raw['login']['github_client_secret_masked'] != 'gh-secret-123456'


def test_notification_settings_round_trip(client, auth_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))

    get_resp = client.get('/api/v1/ops/settings/notifications', headers=auth_headers)
    assert get_resp.status_code == 200
    data = get_resp.get_json()
    assert data['enabled'] is False
    assert data['default_channel'] == 'telegram'

    payload = {
        'enabled': True,
        'default_channel': 'telegram',
        'notify_on_offline': True,
        'notify_on_recovery': True,
        'notify_on_high_load': False,
        'message_prefix': '【告警中心】',
        'test_recipient': '@ops_team',
    }
    put_resp = client.put('/api/v1/ops/settings/notifications', json=payload, headers=auth_headers)
    assert put_resp.status_code == 200
    saved = put_resp.get_json()
    assert saved['enabled'] is True
    assert saved['notify_on_offline'] is True
    assert saved['notify_on_recovery'] is True
    assert saved['notify_on_high_load'] is False
    assert saved['message_prefix'] == '【告警中心】'
    assert saved['test_recipient'] == '@ops_team'

    round_trip = client.get('/api/v1/ops/settings/notifications', headers=auth_headers)
    assert round_trip.status_code == 200
    assert round_trip.get_json()['message_prefix'] == '【告警中心】'


def test_settings_summary_includes_login_and_notifications(client, auth_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))

    client.put('/api/v1/ops/settings/login', json={
        'disable_password_login': True,
        'github_client_id': 'gh-client-id',
        'github_client_secret': 'gh-secret-123456',
    }, headers=auth_headers)
    client.put('/api/v1/ops/settings/notifications', json={
        'enabled': True,
        'message_prefix': '【告警中心】',
    }, headers=auth_headers)

    resp = client.get('/api/v1/ops/settings-summary', headers=auth_headers)
    assert resp.status_code == 200
    data = resp.get_json()
    assert 'login' in data
    assert 'notifications' in data
    assert data['login']['disable_password_login'] is True
    assert data['login']['github_client_id'] == 'gh-client-id'
    assert data['login']['github_client_secret_masked'].startswith('gh-s')
    assert data['notifications']['enabled'] is True
    assert data['notifications']['message_prefix'] == '【告警中心】'
