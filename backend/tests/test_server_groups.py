"""Explicit server-group domain contract tests."""

from extensions import db
from models.models import Server, ServerGroup


def test_startup_backfill_creates_default_and_assigns_legacy_rows(app):
    with app.app_context():
        legacy = Server(name='legacy-group-server', ip='203.0.113.41', group_name='  Edge  ')
        db.session.add(legacy)
        db.session.commit()

        from services.server_groups import backfill_server_groups
        backfill_server_groups()
        db.session.refresh(legacy)

        assert ServerGroup.query.filter_by(name='默认分组').one()
        assert legacy.group_id is not None
        assert legacy.group.name == 'Edge'
        assert legacy.group_name == 'Edge'


def test_public_server_serialization_uses_safe_group_snapshot(app):
    with app.app_context():
        group = ServerGroup(name='Tokyo', purpose='Low latency', color='#123ABC', sort_order=12)
        server = Server(name='snapshot-server', ip='203.0.113.42', group=group, group_name='stale')
        db.session.add_all([group, server])
        db.session.commit()

        public = server.to_dict(public_only=True)

    assert public['group'] == 'Tokyo'
    assert public['group_info'] == {
        'id': group.id, 'name': 'Tokyo', 'purpose': 'Low latency', 'color': '#123ABC', 'sort_order': 12,
    }
    assert set(public['group_info']) == {'id', 'name', 'purpose', 'color', 'sort_order'}


def test_admin_group_crud_validates_and_rejects_assigned_deletion(client, auth_headers, app):
    create = client.post('/api/v1/server-groups', headers=auth_headers, json={
        'name': '  Premium  ', 'purpose': 'High performance', 'color': '#0088FF', 'sort_order': 4,
    })
    assert create.status_code == 201
    group = create.get_json()['group']
    assert group['name'] == 'Premium'

    duplicate = client.post('/api/v1/server-groups', headers=auth_headers, json={'name': 'premium'})
    assert duplicate.status_code == 400
    invalid_color = client.put(f"/api/v1/server-groups/{group['id']}", headers=auth_headers, json={'color': 'blue'})
    assert invalid_color.status_code == 400

    with app.app_context():
        db.session.add(Server(name='assigned-server', ip='203.0.113.43', group_id=group['id'], group_name='Premium'))
        db.session.commit()

    rejected_delete = client.delete(f"/api/v1/server-groups/{group['id']}", headers=auth_headers)
    assert rejected_delete.status_code == 409


def test_server_group_id_wins_and_legacy_name_creates_only_on_admin_save(client, auth_headers, app):
    with app.app_context():
        chosen = ServerGroup(name='Chosen')
        db.session.add(chosen)
        db.session.commit()
        chosen_id = chosen.id

    created = client.post('/api/v1/servers/', headers=auth_headers, json={
        'name': 'precedence-server', 'ip': '203.0.113.44', 'group_id': chosen_id, 'group_name': 'Ignored legacy value',
    })
    assert created.status_code == 201
    payload = created.get_json()['server']
    assert payload['group'] == 'Chosen'
    assert payload['group_info']['id'] == chosen_id

    legacy = client.post('/api/v1/servers/', headers=auth_headers, json={
        'name': 'legacy-create-server', 'ip': '203.0.113.45', 'group_name': 'Created from legacy',
    })
    assert legacy.status_code == 201
    assert legacy.get_json()['server']['group_info']['name'] == 'Created from legacy'

    missing = client.post('/api/v1/servers/', headers=auth_headers, json={
        'name': 'missing-group-server', 'ip': '203.0.113.46', 'group_id': 999999,
    })
    assert missing.status_code == 400
