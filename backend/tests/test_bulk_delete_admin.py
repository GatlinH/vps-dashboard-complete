"""Admin bulk-delete API safety regressions."""
from extensions import db
from models.models import User
from werkzeug.security import generate_password_hash


def _server(client, headers, name, ip):
    response = client.post('/api/v1/servers/', headers=headers, json={'name': name, 'ip': ip})
    assert response.status_code == 201
    return response.get_json()['id']


def test_admin_bulk_delete_servers_is_all_or_nothing_for_missing_ids(client, auth_headers):
    first = _server(client, auth_headers, 'bulk-a', '198.51.100.11')
    second = _server(client, auth_headers, 'bulk-b', '198.51.100.12')
    response = client.delete('/api/v1/servers/bulk', headers=auth_headers, json={'ids': [first, second, 999999]})
    assert response.status_code == 400
    assert client.get(f'/api/v1/servers/{first}', headers=auth_headers).status_code == 200
    assert client.get(f'/api/v1/servers/{second}', headers=auth_headers).status_code == 200


def test_admin_bulk_delete_servers_deduplicates_ids(client, auth_headers):
    first = _server(client, auth_headers, 'bulk-c', '198.51.100.13')
    second = _server(client, auth_headers, 'bulk-d', '198.51.100.14')
    response = client.delete('/api/v1/servers/bulk', headers=auth_headers, json={'ids': [second, first, first]})
    assert response.status_code == 200
    assert response.get_json() == {'deleted': 2, 'ids': sorted([first, second])}
    assert client.get(f'/api/v1/servers/{first}', headers=auth_headers).status_code == 404
    assert client.get(f'/api/v1/servers/{second}', headers=auth_headers).status_code == 404


def test_admin_bulk_delete_groups_rejects_any_group_with_members(client, auth_headers):
    group_a = client.post('/api/v1/server-groups', headers=auth_headers, json={'name': 'bulk-group-a', 'sort_order': 0}).get_json()['group']['id']
    group_b = client.post('/api/v1/server-groups', headers=auth_headers, json={'name': 'bulk-group-b', 'sort_order': 0}).get_json()['group']['id']
    response = client.post('/api/v1/servers/', headers=auth_headers, json={'name': 'bulk-member', 'ip': '198.51.100.15', 'group_id': group_a})
    assert response.status_code == 201
    response = client.delete('/api/v1/server-groups/bulk', headers=auth_headers, json={'ids': [group_a, group_b]})
    assert response.status_code == 409
    listed = client.get('/api/v1/server-groups', headers=auth_headers).get_json()['groups']
    assert {group_a, group_b}.issubset({group['id'] for group in listed})


def test_viewer_cannot_bulk_delete_servers_or_groups(client, app, test_server):
    with app.app_context():
        viewer = User(username='bulk-viewer', password_hash=generate_password_hash('Viewer@123456'), role='viewer')
        db.session.add(viewer)
        db.session.commit()
    login = client.post('/api/v1/auth/login', json={'username': 'bulk-viewer', 'password': 'Viewer@123456'})
    headers = {'Authorization': f"Bearer {login.get_json()['access_token']}"}
    assert client.delete('/api/v1/servers/bulk', headers=headers, json={'ids': [test_server]}).status_code == 403
    assert client.delete('/api/v1/server-groups/bulk', headers=headers, json={'ids': [1]}).status_code == 403
