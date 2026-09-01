import json
from pathlib import Path
import pytest
from flask_jwt_extended import create_access_token, create_refresh_token


@pytest.fixture
def owner_headers(app, test_user):
    with app.app_context():
        token = create_access_token(
            identity=str(test_user.id),
            fresh=True,
            additional_claims={"role": "owner", "username": test_user.username},
        )
    return {"Authorization": f"Bearer {token}"}


def test_login_settings_endpoints_require_existing_auth(client):
    assert client.get('/api/v1/ops/settings/login').status_code == 401
    assert client.put('/api/v1/ops/settings/login', json={}).status_code == 401


def test_admin_cannot_update_login_settings(client, auth_headers):
    response = client.put('/api/v1/ops/settings/login', json={}, headers=auth_headers)
    assert response.status_code == 403


def test_login_settings_round_trip(client, owner_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))

    get_resp = client.get('/api/v1/ops/settings/login', headers=owner_headers)
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
    put_resp = client.put('/api/v1/ops/settings/login', json=payload, headers=owner_headers)
    assert put_resp.status_code == 200
    saved = put_resp.get_json()
    assert saved['disable_password_login'] is True
    assert saved['sso_enabled'] is True
    assert saved['github_client_id'] == 'gh-client-id'
    assert saved['github_client_secret_masked'].startswith('gh-s')
    assert saved['api_key_enabled'] is True

    round_trip = client.get('/api/v1/ops/settings/login', headers=owner_headers)
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


def test_settings_summary_includes_login_and_notifications(client, auth_headers, owner_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))

    client.put('/api/v1/ops/settings/login', json={
        'disable_password_login': True,
        'github_client_id': 'gh-client-id',
        'github_client_secret': 'gh-secret-123456',
    }, headers=owner_headers)
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


def test_login_api_key_http_contract(client, owner_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))
    put = client.put('/api/v1/ops/settings/login', json={'api_key': 'http-secret-123'}, headers=owner_headers)
    assert put.status_code == 200
    body = put.get_json()
    assert body['api_key_set'] is True
    assert 'api_key' not in body
    assert 'http-secret-123' not in put.get_data(as_text=True)
    assert client.get('/api/v1/ops/settings/login', headers=owner_headers).get_json()['api_key_masked'] == 'http****-123'


@pytest.mark.parametrize('payload', [
    {'api_key': ''}, {'api_key': '******'}, {'api_key': '••••'},
    {'api_key': 'unchanged'}, {'api_key': '<hidden>'},
])
def test_login_placeholders_preserve_ciphertext_http(client, owner_headers, monkeypatch, tmp_path, payload):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))
    assert client.put('/api/v1/ops/settings/login', json={'api_key': 'legacy-secret'}, headers=owner_headers).status_code == 200
    original = json.loads(settings_file.read_text())['login']['api_key']
    assert client.put('/api/v1/ops/settings/login', json=payload, headers=owner_headers).status_code == 200
    assert json.loads(settings_file.read_text())['login']['api_key'] == original


def test_login_explicit_set_star_rejected_and_clear_aliases(client, owner_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))
    client.put('/api/v1/ops/settings/login', json={'api_key': 'to-clear'}, headers=owner_headers)
    rejected = client.put('/api/v1/ops/settings/login', json={'api_key_action': 'set', 'api_key': 'bad*key'}, headers=owner_headers)
    assert rejected.status_code == 400
    body = rejected.get_json()
    assert body['error_code'] == 'VALIDATION_ERROR'
    assert 'bad*key' not in rejected.get_data(as_text=True)
    assert 'Traceback' not in rejected.get_data(as_text=True)
    assert str(settings_file.parent) not in rejected.get_data(as_text=True)
    before = json.loads(settings_file.read_text())
    current = client.get('/api/v1/ops/settings/login', headers=owner_headers)
    assert current.status_code == 200
    current_data = current.get_json()
    assert current_data['api_key_set'] is True
    assert current_data['api_key_masked'] == '********'
    after = json.loads(settings_file.read_text())
    assert after == before
    assert 'bad*key' not in settings_file.read_text()
    assert client.put('/api/v1/ops/settings/login', json={'clear_api_key': True}, headers=owner_headers).get_json()['api_key_set'] is False


def test_login_settings_rejects_nonfresh_owner_token(client, test_user, app):
    with app.app_context():
        token = create_access_token(identity=str(test_user.id), fresh=False,
                                    additional_claims={'role': 'owner', 'username': test_user.username})
    response = client.put('/api/v1/ops/settings/login', json={}, headers={'Authorization': f'Bearer {token}'})
    assert response.status_code == 401
    assert response.get_json().get('error_code') == 'FRESH_TOKEN_REQUIRED'


def test_refresh_access_token_cannot_update_login_settings(client, test_user, app):
    with app.app_context():
        from extensions import db
        from models.models import User
        User.query.filter_by(id=test_user.id).update({'role': 'owner'})
        db.session.commit()
        refresh = create_refresh_token(identity=str(test_user.id),
                                      additional_claims={'role': 'owner', 'username': test_user.username})
    response = client.post('/api/v1/auth/refresh', headers={'Authorization': f'Bearer {refresh}', 'X-Auth-Mode': 'bearer'})
    assert response.status_code == 200
    access = response.get_json()['access_token']
    rejected = client.put('/api/v1/ops/settings/login', json={}, headers={'Authorization': f'Bearer {access}'})
    assert rejected.status_code == 401
    assert rejected.get_json().get('error_code') == 'FRESH_TOKEN_REQUIRED'


def test_login_settings_missing_master_key_fails_closed(client, owner_headers, monkeypatch, tmp_path):
    settings_file = tmp_path / 'admin-settings.json'
    monkeypatch.setenv('ADMIN_SETTINGS_FILE', str(settings_file))
    assert client.put('/api/v1/ops/settings/login', json={'api_key': 'stored-secret'}, headers=owner_headers).status_code == 200
    monkeypatch.delenv('MASTER_ENCRYPTION_KEY', raising=False)
    read = client.get('/api/v1/ops/settings/login', headers=owner_headers)
    assert read.status_code == 200
    data = read.get_json()
    assert data['api_key_set'] is True
    assert data['api_key_masked'] == ''
    assert 'stored-secret' not in read.get_data(as_text=True)
    write = client.put('/api/v1/ops/settings/login', json={'api_key': 'new-secret'}, headers=owner_headers)
    assert write.status_code == 400
    assert write.get_json()['error_code'] == 'VALIDATION_ERROR'
    assert 'new-secret' not in settings_file.read_text()
