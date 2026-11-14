from datetime import datetime, timedelta, timezone

import pytest

from extensions import db
from models.models import PingTargetRollup, Server
from tests.test_regional_ping import (
    _set_config,
    _targets,
    get_sql as get_sql,
    no_controller_probe as no_controller_probe,
    regional_storage as regional_storage,
)


def _window(hours=1):
    width = {1: 300, 6: 900, 24: 3600}[hours]
    now = datetime.now(timezone.utc)
    end = datetime.fromtimestamp(int(now.timestamp()) // width * width, timezone.utc)
    return end - timedelta(hours=hours), end, width


def _iso(value):
    return value.isoformat().replace('+00:00', 'Z')


def _date(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00'))


def _configure(app, test_server, targets=None):
    targets = _targets() if targets is None else targets
    _set_config(app, test_server, {'ping_targets': targets, 'secret': 'never-public'})
    return targets


def _seed(app, test_server, target, observations, key=None):
    with app.app_context():
        db.session.execute(db.text('''
            INSERT INTO ping_target_results
                (server_id, target_key, label, host, port, protocol,
                 latency_ms, success, loss_pct, created_at)
            VALUES (:sid, :key, :label, :host, :port, :protocol,
                    :latency, :success, :loss, :observed)
        '''), [{
            'sid': test_server, 'key': key or target['key'],
            'label': target['label'], 'host': target['host'],
            'port': target['port'], 'protocol': target['protocol'],
            'observed': observed.replace(tzinfo=None), 'success': success,
            'latency': latency, 'loss': loss,
        } for observed, success, latency, loss in observations])
        db.session.commit()


def _get(client, test_server, query='', endpoint='overview'):
    return client.get(f'/api/v1/probe/public/ping-targets/{test_server}/{endpoint}?{query}')


@pytest.mark.parametrize('hours,count,width', [(1, 12, 300), (6, 24, 900), (24, 24, 3600)])
def test_overview_cardinality_window_and_regions(client, test_server, app, hours, count, width):
    targets = _configure(app, test_server)
    response = _get(client, test_server, f'hours={hours}')
    assert response.status_code == 200
    assert response.headers['Cache-Control'] == 'no-store'
    payload = response.get_json()
    assert payload['server_id'] == test_server
    assert payload['configured'] is True and payload['not_configured'] is False
    assert payload['probe_source'] == 'external'
    assert payload['derived_from'] == 'persisted ping_target_results'
    assert payload['window_hours'] == hours
    assert payload['slot_count'] == count and payload['bucket_seconds'] == width
    requested = _date(payload['requested_at'])
    end = _date(payload['window_end'])
    start = _date(payload['window_start'])
    assert end.timestamp() == int(requested.timestamp()) // width * width
    assert end - start == timedelta(hours=hours)
    assert payload['selection'] == {'region': None, 'ungrouped': False}
    assert payload['regions'] == [
        {'region': region, 'ungrouped': False, 'target_count': 2}
        for region in ('asia', 'europe')
    ]
    assert [target['key'] for target in payload['targets']] == [target['key'] for target in targets]
    assert 'secret' not in response.get_data(as_text=True)
    for target in payload['targets']:
        assert len(target['slots']) == count
        assert target['summary']['observed_at'] is None
        assert target['summary']['sample_source'] == 'missing'
        assert target['points'] == []
        for index, slot in enumerate(target['slots']):
            assert slot['start'] == _iso(start + timedelta(seconds=index * width))
            assert slot['end'] == _iso(start + timedelta(seconds=(index + 1) * width))
            assert slot['status'] == 'missing'
            assert slot['sample_count'] == slot['success_count'] == slot['fail_count'] == 0
            assert all(slot[field] is None for field in (
                'first_seen', 'last_seen', 'latency_ms', 'loss_pct', 'report_failure_pct',
            ))


@pytest.mark.parametrize('query', [
    'hours=0', 'hours=2', 'hours=168', 'hours=2160', 'hours=1.0', 'hours=nope', 'hours=',
    'source=unknown', 'source=', 'region=', 'region=%20', 'region=' + 'a' * 33,
    'region=asia%0A', 'region=asia&ungrouped=1', 'ungrouped=0', 'ungrouped=true',
    'ungrouped=', 'hours=1&hours=6', 'region=asia&region=europe',
])
def test_overview_invalid_query(client, test_server, query):
    response = _get(client, test_server, query)
    assert response.status_code == 400
    assert response.headers['Cache-Control'] == 'no-store'


@pytest.mark.parametrize('query,keys,selection', [
    ('region=asia', ['asia-1'], {'region': 'asia', 'ungrouped': False}),
    ('region=default', ['asia-2'], {'region': 'default', 'ungrouped': False}),
    ('region=__ungrouped__', ['europe-1'], {'region': '__ungrouped__', 'ungrouped': False}),
    ('ungrouped=1', ['europe-2'], {'region': None, 'ungrouped': True}),
    ('region=absent', [], {'region': 'absent', 'ungrouped': False}),
])
def test_region_selection_never_uses_name_sentinels(client, test_server, app, query, keys, selection):
    targets = _targets()
    for target, region in zip(targets, ('asia', 'default', '__ungrouped__', '')):
        target['region'] = region
    _configure(app, test_server, targets)
    response = _get(client, test_server, query)
    assert response.status_code == 200
    payload = response.get_json()
    assert [target['key'] for target in payload['targets']] == keys
    assert payload['selection'] == selection
    assert payload['configured'] is True
    assert payload['regions'] == [
        {'region': region, 'ungrouped': region == '', 'target_count': 1}
        for region in ('asia', 'default', '__ungrouped__', '')
    ]


@pytest.mark.parametrize('missing_server', [False, True])
def test_unconfigured_is_really_empty(client, test_server, app, missing_server):
    _configure(app, test_server, [])
    response = _get(client, 999999 if missing_server else test_server)
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['targets'] == payload['regions'] == []
    assert payload['configured'] is False and payload['not_configured'] is True


def test_real_aggregate_metrics_boundaries_and_latest(client, test_server, app):
    target = _configure(app, test_server, [_targets()[0]])[0]
    start, end, width = _window()
    first = start + timedelta(seconds=1)
    second = start + timedelta(seconds=3)
    _seed(app, test_server, target, [
        (start - timedelta(microseconds=1), 1, 999, 0),
        (start, 1, 0, None), (first, 0, 999, None), (second, 1, 20, 20),
        (start + timedelta(seconds=width), 0, 777, None),
        (start + timedelta(seconds=width + 1), 0, None, None),
        (start + timedelta(seconds=3 * width), 1, 0, 0),
        (start + timedelta(seconds=4 * width), 1, 7, None),
        (start + timedelta(seconds=5 * width), 1, 11, 5),
        (end - timedelta(microseconds=1), 1, 31, 0),
        (end, 1, 9, None),
        (datetime.now(timezone.utc) + timedelta(hours=1), 1, 888, 0),
    ])
    response = _get(client, test_server)
    assert response.status_code == 200
    result = response.get_json()['targets'][0]
    slot = result['slots'][0]
    assert slot['status'] == 'loss'
    assert (slot['sample_count'], slot['success_count'], slot['fail_count']) == (3, 2, 1)
    assert slot['latency_ms'] == 10.0 and slot['loss_pct'] == 20.0
    assert slot['report_failure_pct'] == 33.3
    assert slot['first_seen'] == _iso(start) and slot['last_seen'] == _iso(second)
    failed = result['slots'][1]
    assert failed['status'] == 'fail' and failed['latency_ms'] is None
    assert failed['loss_pct'] is None and failed['report_failure_pct'] == 100.0
    assert failed['sample_count'] == failed['fail_count'] == 2
    assert result['slots'][2]['status'] == 'missing'
    assert result['slots'][3]['latency_ms'] == result['slots'][3]['loss_pct'] == 0.0
    assert result['slots'][3]['status'] == 'ok'
    assert result['slots'][4]['loss_pct'] is None and result['slots'][4]['status'] == 'ok'
    assert result['slots'][5]['status'] == 'loss'
    assert result['slots'][-1]['last_seen'] == _iso(end - timedelta(microseconds=1))
    assert sum(slot['sample_count'] for slot in result['slots']) == 9
    summary = result['summary']
    assert summary['observed_at'] == _iso(end)
    assert summary['sample_source'] == 'agent-reported'
    assert summary['latency_ms'] == 9.0 and summary['loss_pct'] is None
    assert summary['sample_count'] == summary['success_count'] == 1
    assert summary['fail_count'] == 0 and summary['status'] == 'ok'
    assert len(result['points']) == 5
    assert all(point['success'] and point['key'] == target['key'] for point in result['points'])
    assert result['points'][1]['latency_ms'] == 0.0


def test_summary_latest_failure_and_id_tie(client, test_server, app):
    target = _configure(app, test_server, [_targets()[0]])[0]
    start, end, _ = _window()
    _seed(app, test_server, target, [(start, 1, 0, 0), (end, 1, 20, 0), (end, 0, 123, None)])
    response = _get(client, test_server)
    assert response.status_code == 200
    summary = response.get_json()['targets'][0]['summary']
    assert summary['status'] == 'fail' and summary['latency_ms'] is None
    assert summary['loss_pct'] is None and summary['report_failure_pct'] == 100.0
    assert summary['observed_at'] == _iso(end)
    assert summary['sample_count'] == summary['fail_count'] == 1


def test_counts_exceed_old_raw_limit_without_losing_oldest_bucket(client, test_server, app, get_sql):
    target = _configure(app, test_server, [_targets()[0]])[0]
    start, _, _ = _window()
    _seed(app, test_server, target, [
        (start + timedelta(seconds=1), 1, 0, None),
        *[(start + timedelta(minutes=56, microseconds=index), index % 2, 10, None)
          for index in range(10025)],
    ])
    get_sql.clear()
    response = _get(client, test_server)
    assert response.status_code == 200
    slots = response.get_json()['targets'][0]['slots']
    assert sum(slot['sample_count'] for slot in slots) == 10026
    assert slots[0]['sample_count'] == 1 and slots[-1]['sample_count'] == 10025
    assert slots[-1]['success_count'] == 5012 and slots[-1]['fail_count'] == 5013
    raw_queries = [sql.upper() for sql in get_sql if 'FROM PING_TARGET_RESULTS' in sql.upper()]
    assert len(raw_queries) <= 2
    assert any('COUNT(' in sql and 'GROUP BY' in sql for sql in raw_queries)
    assert not any('MAX(SUCCESS)' in sql or 'SELECT *' in sql for sql in raw_queries)


def test_canonical_and_unique_alias_reports_merge(client, test_server, app):
    target = _configure(app, test_server, [_targets()[0]])[0]
    start, _, _ = _window()
    for index, key in enumerate((target['key'], target['host'], target['label'])):
        _seed(app, test_server, target, [(start + timedelta(seconds=index), 1, index * 10, 0)], key)
    response = _get(client, test_server)
    assert response.status_code == 200
    results = response.get_json()['targets']
    assert len(results) == 1 and results[0]['key'] == target['key']
    assert results[0]['slots'][0]['sample_count'] == 3
    assert results[0]['slots'][0]['latency_ms'] == 10.0


def test_alias_protocol_port_disambiguation_and_canonical_priority(client, test_server, app):
    base = _targets()[0]
    targets = [
        {**base, 'key': 'tcp443', 'label': 'Shared'},
        {**base, 'key': 'tcp8443', 'label': 'Shared', 'port': 8443},
        {**base, 'key': 'http443', 'label': 'Shared', 'protocol': 'http'},
        {**base, 'key': 'ambiguous', 'label': 'Ambiguous', 'region': 'europe'},
        {**base, 'key': 'owner', 'label': 'Owner', 'host': 'other.example.com'},
        {**base, 'key': 'collision', 'label': 'owner', 'host': 'collision.example.com'},
    ]
    _configure(app, test_server, targets)
    start, _, _ = _window()
    for index, target in enumerate(targets):
        _seed(app, test_server, target, [(start, 1, index + 1, 0)])
    for index in (1, 2):
        _seed(app, test_server, targets[index], [(start, 1, 20, 0)], base['host'])
    _seed(app, test_server, base, [(start, 1, 999, 0)], base['host'])
    _seed(app, test_server, targets[0], [(start, 1, 888, 0)], 'Shared')
    _seed(app, test_server, targets[1], [(start, 1, 777, 0)], 'tcp443')
    response = _get(client, test_server)
    assert response.status_code == 200
    counts = {target['key']: target['slots'][0]['sample_count'] for target in response.get_json()['targets']}
    assert counts == {'tcp443': 2, 'tcp8443': 2, 'http443': 2, 'ambiguous': 1, 'owner': 1, 'collision': 1}
    selected = _get(client, test_server, 'region=asia').get_json()
    assert selected['targets'][0]['slots'][0]['sample_count'] == 2


def test_get_is_read_only_and_missing_table_is_not_bootstrapped(client, test_server, app, get_sql):
    _configure(app, test_server)
    with app.app_context():
        db.session.execute(db.text('DROP TABLE ping_target_results'))
        db.session.commit()
    get_sql.clear()
    response = _get(client, test_server)
    assert response.status_code == 200
    assert all(slot['status'] == 'missing' for target in response.get_json()['targets'] for slot in target['slots'])
    assert get_sql and all(sql.lstrip().upper().startswith(('SELECT', 'WITH')) for sql in get_sql)
    with app.app_context():
        assert db.session.execute(db.text("SELECT name FROM sqlite_master WHERE name='ping_target_results'")).first() is None


def _peer(app):
    with app.app_context():
        peer = Server(name='Peer', ip='8.8.4.4', location='peer-location')
        db.session.add(peer)
        db.session.commit()
        return {'key': f'vps-{peer.id}', 'label': 'Peer · peer-location',
                'host': '8.8.4.4', 'port': 80, 'protocol': 'tcp', 'type': 'peer', 'region': ''}


def test_overview_external_default_and_peer_are_independent(client, test_server, app):
    target = _configure(app, test_server, [_targets()[0]])[0]
    peer = _peer(app)
    start, _, _ = _window()
    _seed(app, test_server, target, [(start, 1, 12, 0)])
    _seed(app, test_server, peer, [(start, 1, 99, None)])
    for source in ('', 'source=public', 'source=external'):
        response = _get(client, test_server, source)
        assert response.status_code == 200
        result = response.get_json()
        assert result['probe_source'] == 'external'
        assert [item['key'] for item in result['targets']] == [target['key']]
        assert result['targets'][0]['slots'][0]['latency_ms'] == 12.0
    response = _get(client, test_server, 'source=agent')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['probe_source'] == 'agent'
    assert [item['key'] for item in payload['targets']] == [peer['key']]
    assert payload['targets'][0]['slots'][0]['latency_ms'] == 99.0
    assert payload['regions'] == [{'region': '', 'ungrouped': True, 'target_count': 1}]


@pytest.mark.parametrize('days', [30, 90])
def test_long_history_source_region_alias_and_prelimit_filter(client, test_server, app, days, get_sql):
    targets = _configure(app, test_server)
    peer = _peer(app)
    observed = datetime.now(timezone.utc).replace(tzinfo=None, minute=0, second=0, microsecond=0) - timedelta(days=20)
    with app.app_context():
        for index, (key, label, protocol) in enumerate([
            (peer['key'], peer['label'], 'tcp'), ('removed', 'Removed', 'tcp'),
            (targets[0]['host'], targets[0]['label'], 'http'),
            (targets[0]['host'], targets[0]['label'], 'tcp'),
            (targets[0]['key'], targets[0]['label'], 'tcp'),
            (targets[2]['key'], targets[2]['label'], 'tcp'),
        ]):
            db.session.add(PingTargetRollup(
                server_id=test_server, target_key=key, label=label, protocol=protocol,
                bucket_start=observed + timedelta(hours=index), sample_count=4,
                success_count=3, latency_sum=120, loss_sum=25,
            ))
        db.session.commit()
    get_sql.clear()
    response = _get(client, test_server, f'hours={days * 24}&source=external&region=asia&limit=2', 'history')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['history_source'] == 'rollup' and payload['hours'] == days * 24
    assert [target['key'] for target in payload['targets']] == [targets[0]['key']]
    target = payload['targets'][0]
    assert target['region'] == 'asia' and target['protocol'] == 'tcp'
    assert len(target['points']) == 2
    assert all(point['key'] == targets[0]['key'] and point['latency_ms'] == 40.0 for point in target['points'])
    assert all(point['loss_pct'] == 6.25 for point in target['points'])
    assert response.headers['Cache-Control'] == 'no-store'
    peer_response = _get(client, test_server, f'hours={days * 24}&source=agent', 'history')
    assert peer_response.status_code == 200
    assert [target['key'] for target in peer_response.get_json()['targets']] == [peer['key']]
    public_response = _get(client, test_server, f'hours={days * 24}', 'history')
    assert public_response.status_code == 200
    assert {target['key'] for target in public_response.get_json()['targets']} == {targets[0]['key'], targets[2]['key']}
    assert all(sql.lstrip().upper().startswith(('SELECT', 'WITH')) for sql in get_sql)


@pytest.mark.parametrize('query', ['region=asia&ungrouped=1', 'region=', 'source=wrong'])
def test_long_history_invalid_selection(client, test_server, query):
    assert _get(client, test_server, f'hours=2160&{query}', 'history').status_code == 400
