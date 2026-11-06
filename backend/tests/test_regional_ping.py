import copy
import json
import math
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest
from sqlalchemy import event

from extensions import db
from models.models import OpsEvent, Server
from services import peer_probe, probe_history
from services.ping_target_cache import clear_ping_targets_cache


@pytest.fixture(autouse=True)
def regional_storage(app, reset_db, monkeypatch):
    from services import ping_target_cache

    def unix_timestamp(value):
        return datetime.fromisoformat(value).replace(tzinfo=timezone.utc).timestamp()

    monkeypatch.setattr(ping_target_cache, '_ping_targets_memory_cache', {})
    with app.app_context():
        connection = db.session.connection().connection.driver_connection
        connection.create_function('UNIX_TIMESTAMP', 1, unix_timestamp)
        connection.create_function('FLOOR', 1, math.floor)
        monkeypatch.setattr(probe_history, '_PTR_HISTORY_TABLE_READY', False)
        assert probe_history._target_history_table_ready()
        db.session.execute(db.text('DELETE FROM ping_target_results'))
        db.session.commit()


@pytest.fixture(autouse=True)
def no_controller_probe(monkeypatch):
    from api import probe

    forbidden = Mock(side_effect=AssertionError('GET must not probe or persist samples'))
    monkeypatch.setattr(probe, 'tcp_ping', forbidden)
    monkeypatch.setattr(probe, 'fetch_and_parse_probe', forbidden)
    monkeypatch.setattr(probe, '_persist_ping_target_results', forbidden)
    yield forbidden
    forbidden.assert_not_called()


def _targets():
    return [
        {
            'key': f'{region}-{index}',
            'label': f'{region} {index}',
            'host': f'{region}-{index}.example.com',
            'port': 443,
            'protocol': 'tcp',
            'type': 'custom',
            'region': region,
        }
        for region in ('asia', 'europe')
        for index in (1, 2)
    ]


def _save(client, auth_headers, test_server, targets):
    return client.put(
        f'/api/v1/servers/{test_server}/agent-config',
        headers=auth_headers,
        json={'ping_targets': targets},
    )


def _definitions(client, test_server):
    return client.get(
        f'/api/v1/probe/public/ping-targets/{test_server}?source=external',
    )


def _config(app, test_server):
    with app.app_context():
        return copy.deepcopy(db.session.get(Server, test_server).agent_config)


def _set_config(app, test_server, config):
    with app.app_context():
        db.session.get(Server, test_server).agent_config = copy.deepcopy(config)
        db.session.commit()
        clear_ping_targets_cache(test_server)
    db.session.expire_all()


def _seed_raw_samples(app, test_server, targets, monkeypatch):
    with app.app_context():
        monkeypatch.setattr(probe_history, '_PTR_HISTORY_TABLE_READY', False)
        assert probe_history._target_history_table_ready()
        db.session.execute(db.text('DELETE FROM ping_target_results'))
        observed = datetime.now(timezone.utc).replace(tzinfo=None, microsecond=0)
        for index, target in enumerate(targets):
            for age, latency in ((2, 80.0), (1, 10.0 + index)):
                db.session.execute(db.text('''
                    INSERT INTO ping_target_results
                        (server_id, target_key, label, host, port, protocol,
                         latency_ms, success, loss_pct, quality, created_at)
                    VALUES
                        (:sid, :key, :label, :host, 443, 'tcp',
                         :latency, 1, 0, 95, :observed)
                '''), {
                    'sid': test_server,
                    'key': target['key'],
                    'label': target['label'],
                    'host': target['host'],
                    'latency': latency,
                    'observed': observed - timedelta(hours=age),
                })
        db.session.commit()


@pytest.fixture
def get_sql(app):
    statements = []

    def capture(connection, cursor, statement, parameters, context, executemany):
        statements.append(statement.strip())

    with app.app_context():
        engine = db.engine
    event.listen(engine, 'before_cursor_execute', capture)
    try:
        yield statements
    finally:
        event.remove(engine, 'before_cursor_execute', capture)


def test_region_save_and_public_definitions(client, auth_headers, test_server, app):
    targets = _targets()
    response = _save(client, auth_headers, test_server, targets)
    assert response.status_code == 200
    assert _config(app, test_server)['ping_targets'] == targets
    response = _definitions(client, test_server)
    assert response.status_code == 200
    assert {target['key']: target['region'] for target in response.get_json()['targets']} == {
        target['key']: target['region'] for target in targets
    }


@pytest.mark.parametrize('region', [
    None, 1, 1.5, [], {}, True, False, 'a' * 33, '😀' * 33,
    'east\nwest', 'east\rwest', 'east\r\nwest',
])
def test_invalid_region_rejected_before_writes(
    client, auth_headers, test_server, app, monkeypatch, get_sql, region,
):
    from api import servers

    original = {'ping_targets': _targets(), 'custom_metadata': {'owner': 'ops'}}
    _set_config(app, test_server, original)
    with app.app_context():
        audit_count = OpsEvent.query.count()
    audit = Mock(wraps=servers._audit_high_risk)
    monkeypatch.setattr(servers, '_audit_high_risk', audit)
    targets = _targets()
    targets[-1]['region'] = region
    get_sql.clear()
    response = _save(client, auth_headers, test_server, targets)
    assert response.status_code == 400
    assert all(
        statement.upper().startswith(('SELECT', 'INSERT INTO AUDIT_LOGS '))
        for statement in get_sql
    ), get_sql
    audit.assert_not_called()
    assert _config(app, test_server) == original
    with app.app_context():
        assert OpsEvent.query.count() == audit_count


def test_missing_empty_and_named_default_regions(client, auth_headers, test_server):
    targets = _targets()[:3]
    targets[0].pop('region')
    targets[1]['region'] = ''
    targets[2]['region'] = 'default'
    assert _save(client, auth_headers, test_server, targets).status_code == 200
    response = _definitions(client, test_server)
    assert response.status_code == 200
    assert {target['key']: target['region'] for target in response.get_json()['targets']} == {
        targets[0]['key']: '',
        targets[1]['key']: '',
        targets[2]['key']: 'default',
    }


def test_save_and_clear_preserve_other_config(client, auth_headers, test_server, app):
    original = {
        'custom_metadata': {'owner': 'ops'}, 'interval': 37,
        'capabilities': {'custom': True, 'exec': True},
    }
    _set_config(app, test_server, original)
    assert _save(client, auth_headers, test_server, _targets()).status_code == 200
    config = _config(app, test_server)
    assert config['custom_metadata'] == {'owner': 'ops'}
    assert config['interval'] == 37
    assert config['capabilities'] == {
        'custom': True, 'exec': False, 'terminal': False, 'file_list': False,
    }
    assert config['readonly'] is True
    assert config['disable_remote_exec'] is True
    assert config['disable_online_terminal'] is True
    assert config['disable_file_list'] is True
    assert _definitions(client, test_server).get_json()['targets']
    assert client.get(f'/api/v1/probe/public/ping-targets/{test_server}').get_json()['targets']
    assert _save(client, auth_headers, test_server, []).status_code == 200
    config = _config(app, test_server)
    assert config['ping_targets'] == []
    assert config['custom_metadata'] == {'owner': 'ops'}
    assert config['interval'] == 37
    assert config['capabilities']['custom'] is True
    assert _definitions(client, test_server).get_json()['targets'] == []
    for suffix in ('', '/history?hours=168'):
        response = client.get(f'/api/v1/probe/public/ping-targets/{test_server}{suffix}')
        assert response.status_code == 200
        assert response.get_json()['targets'] == []
        assert response.get_json()['not_configured'] is True


@pytest.mark.parametrize('region', ['', 'default', '😀' * 32, '中' * 32, 'a' * 32, ' east '])
def test_region_boundaries_preserved(client, auth_headers, test_server, app, region):
    targets = _targets()[:1]
    targets[0]['region'] = region
    assert _save(client, auth_headers, test_server, targets).status_code == 200
    assert _config(app, test_server)['ping_targets'][0]['region'] == region
    assert _definitions(client, test_server).get_json()['targets'][0]['region'] == region


@pytest.mark.parametrize('legacy', [False, True])
def test_snapshot_and_raw_history_region_readonly(
    client, auth_headers, test_server, app, monkeypatch, get_sql, legacy,
):
    targets = _targets()
    targets[1]['region'] = ''
    targets[2]['region'] = 'default'
    targets[3].pop('region')
    if legacy:
        for target in targets:
            target.pop('region', None)
        _set_config(app, test_server, {'ping_targets': targets})
    else:
        assert _save(client, auth_headers, test_server, targets).status_code == 200
    _seed_raw_samples(app, test_server, targets, monkeypatch)
    config_before = _config(app, test_server)
    get_sql.clear()
    responses = [
        _definitions(client, test_server),
        client.get(f'/api/v1/probe/public/ping-targets/{test_server}'),
        client.get(f'/api/v1/probe/public/ping-targets/{test_server}'),
        client.get(f'/api/v1/probe/public/ping-targets/{test_server}/history?hours=168'),
    ]
    assert all(statement.upper().startswith('SELECT') for statement in get_sql), get_sql
    expected = {target['key']: target.get('region', '') for target in targets}
    for response in responses:
        assert response.status_code == 200
        assert {target['key']: target['region'] for target in response.get_json()['targets']} == expected
    snapshot = {target['key']: target for target in responses[1].get_json()['targets']}
    for index, target in enumerate(targets):
        assert snapshot[target['key']]['stats']['avg_ms'] == 10.0 + index
        assert snapshot[target['key']]['sample_source'] == 'agent-reported'
    assert responses[2].headers['X-Ping-Targets-Cache'] == 'hit'
    history = responses[-1].get_json()
    assert history['hours'] == 168
    for target in history['targets']:
        assert len(target['points']) == 2
        assert set(target['points'][0]) == {
            'x', 'latency_ms', 'success', 'loss_pct', 'quality', 'protocol', 'key', 'label',
        }
        assert target['points'][0]['latency_ms'] == 80.0
        assert target['points'][1]['success'] is True
    assert _config(app, test_server) == config_before


def test_raw_history_without_samples_has_region(client, auth_headers, test_server):
    targets = _targets()
    assert _save(client, auth_headers, test_server, targets).status_code == 200
    response = client.get(f'/api/v1/probe/public/ping-targets/{test_server}/history?hours=1')
    assert response.status_code == 200
    assert {target['key']: target['region'] for target in response.get_json()['targets']} == {
        target['key']: target['region'] for target in targets
    }
    assert all(target['points'] == [] for target in response.get_json()['targets'])


def test_environment_definitions_preserve_regions(client, test_server, monkeypatch):
    targets = _targets()
    monkeypatch.setenv('PING_TARGETS_JSON', json.dumps(targets))
    response = _definitions(client, test_server)
    assert response.status_code == 200
    assert {target['key']: target['region'] for target in response.get_json()['targets']} == {
        target['key']: target['region'] for target in targets
    }


def test_missing_config_does_not_start_presets(client, test_server, monkeypatch):
    monkeypatch.delenv('PING_TARGETS_JSON', raising=False)
    response = client.get(f'/api/v1/probe/public/ping-targets/{test_server}')
    assert response.status_code == 200
    assert response.get_json()['targets'] == []
    assert response.get_json()['not_configured'] is True


@pytest.mark.parametrize('region', [None, True, [], {}])
def test_legacy_invalid_region_is_not_stringified(client, test_server, app, region):
    targets = _targets()[:1]
    targets[0]['region'] = region
    _set_config(app, test_server, {'ping_targets': targets})
    response = _definitions(client, test_server)
    assert response.status_code == 200
    assert response.get_json()['targets'][0]['region'] == ''
    assert _config(app, test_server)['ping_targets'] == targets


def test_resolver_preserves_region_without_mutation(app, test_server):
    targets = _targets()
    _set_config(app, test_server, {'ping_targets': targets})
    with app.app_context():
        server = db.session.get(Server, test_server)
        assert [target['region'] for target in peer_probe._resolve_ping_targets_for_server(server)] == [
            target['region'] for target in targets
        ]
        assert server.agent_config['ping_targets'] == targets
