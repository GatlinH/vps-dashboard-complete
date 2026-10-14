"""Synthetic recorder/checker tests; these are NOT browser measurements."""
import copy
import hashlib
import math

import pytest

from solar_clip_contract import check_ray, check_points, check_matrix, check_record

KEYS = ['sun', 'earth', 'moon']
STATES = ['idle'] + [f'{action}-{key}' for action in ['hover', 'focus'] for key in KEYS]


def ray(key='moon', j=1201):
    return {'id': 'deg-0', 'angle': 0, 'center': {'x': 100, 'y': 70},
            'rows': [[i, 100 + i / 100, 70, 'occluder',
                      ['occluder', key] if i < j else ['occluder'], True]
                     for i in range(2401)]}


def test_stack_membership_not_top_and_integer_envelope():
    for j in [1198, 1201, 1203]:
        result = check_ray('moon', ray(j=j))
        assert result['failures'] == []
        assert result['firstMissIndex'] == j
    for j in [1001, 1197, 1204, 1343, 2401]:
        assert 'C3_RADIUS_ENVELOPE' in check_ray('moon', ray(j=j))['failures']


def test_reentry_even_at_last_sample_is_rejected():
    value = ray()
    value['rows'][-1][4].append('moon')
    assert 'C3_REENTRY' in check_ray('moon', value)['failures']


@pytest.mark.parametrize('change', ['empty', 'short', 'duplicate', 'nan', 'wrong-coordinate', 'api'])
def test_raw_sample_corruption_is_rejected(change):
    value = ray()
    if change == 'empty': value['rows'] = []
    if change == 'short': value['rows'].pop()
    if change == 'duplicate': value['rows'][5] = value['rows'][4]
    if change == 'nan': value['rows'][5][1] = math.nan
    if change == 'wrong-coordinate': value['rows'][5][1] += 1
    if change == 'api': value['rows'][5][5] = False
    assert check_ray('moon', value)['failures']


def test_c2_has_its_own_radius_and_priority_and_rejects_moon_theft():
    centers = {'sun': {'x': 50, 'y': 70}, 'earth': {'x': 100, 'y': 70}, 'moon': {'x': 124.4, 'y': 70}}
    points = [{'kind': kind, 'key': key, **centers[key], 'top': key, 'stack': [key], 'apisAgree': True}
              for kind in ['probe', 'center'] for key in KEYS]
    assert check_points(points, centers)['failures'] == []
    moon = next(p for p in points if p['kind'] == 'probe' and p['key'] == 'moon')
    moon.update(x=113.15, top='earth', stack=['earth', 'moon'])
    checked = check_points(points, centers)
    assert checked['failureCount'] == 1
    assert checked['points'][2]['modelOwner'] == 'moon'
    assert not checked['modelMatchesNative']
    assert check_points([], centers)['failures']


def test_c0_matrix_must_have_exactly_42_unique_keys():
    rows = [{'dpr': d, 'fontScale': f, 'state': s} for d in [1, 2, 3] for f in [1, 1.25] for s in STATES]
    assert check_matrix(rows) == []
    for bad in [[], rows[:-1], rows + [rows[0]], rows[:-1] + [rows[0]]]:
        assert check_matrix(bad)


def test_record_rejects_missing_measurements_without_vacuous_pass():
    for value in [{}, {'buttons': {}}, {'buttons': {'earth': {'rays': []}}}]:
        assert check_record(value)['C0']['status'] != 'PASS'


def test_spread_is_conservative_integer_difference():
    from solar_clip_contract import check_spread
    assert check_spread([1198] + [1202] * 17) == []
    assert check_spread([1198] + [1203] * 17) == ['C3_DIRECTION_SPREAD']
    assert check_spread([])
    assert check_spread([1201] * 17)


@pytest.fixture
def complete_record():
    """Artificial input to exercise the checker, never written as native evidence."""
    from solar_clip_contract import DIRECTIONS
    centers = {'sun': {'x': 166.4401092529297, 'y': 94.94145965576172},
               'earth': {'x': 148.52980041503906, 'y': 91.24215698242188},
               'moon': {'x': 143.5714111328125, 'y': 67.35126495361328}}
    probes = {'sun': {'x': 160, 'y': 90}, 'earth': {'x': 146.24276406448698, 'y': 80.22257428367872},
              'moon': {'x': 145.85845290736307, 'y': 78.3708542528869}}
    snapshot = {'centers': centers, 'probes': probes, 'canvas': {'left': 0, 'top': 0, 'width': 320, 'height': 180},
                'jd': 2446454.4312, 'running': False, 'playbackPaused': True, 'atHome': True, 'tween': False,
                'ready': True, 'targets': dict.fromkeys(KEYS, True),
                'camera': {'position': [0, 0, 1], 'home': [0, 0, 1], 'target': [0, 0, 0],
                           'projection': [1] * 16, 'world': [1] * 16}}
    registry = {key: {'tag': 'BUTTON', 'connected': True} for key in KEYS}
    registry['occluder'] = {'tag': 'DIV', 'connected': True}
    toward = math.atan2(probes['moon']['y'] - centers['earth']['y'], probes['moon']['x'] - centers['earth']['x'])
    angles = [i * math.pi / 8 for i in range(16)] + [toward, toward + math.pi]
    buttons = {}
    for key in KEYS:
        c = centers[key]
        rays = []
        for name, angle in zip(DIRECTIONS, angles):
            rows = [[i, c['x'] + i / 100 * math.cos(angle), c['y'] + i / 100 * math.sin(angle),
                     'occluder', ['occluder', key] if i < 1201 else ['occluder'], True] for i in range(2401)]
            rays.append({'id': name, 'angle': angle, 'center': c, 'rows': rows})
        buttons[key] = {'node': key, 'rays': rays}
    return {'schema': 1, 'dpr': 1, 'fontScale': 1, 'state': 'idle', 'viewport': [320, 700],
            'devicePixelRatio': 1, 'rootFontSize': 16, 'initialRootFontSize': 16,
            'before': snapshot, 'after': copy.deepcopy(snapshot), 'registry': registry, 'buttons': buttons,
            'witness': {'instance': 'synthetic-checker-test', 'constructor': 'Synthetic', 'calls': 1,
                        'realInstance': True, 'rendererCanvas': True, 'prototypeMethod': True, 'originalUnchanged': True,
                        'functionSource': 'synthetic', 'functionSha256': hashlib.sha256(b'synthetic').hexdigest(),
                        'before': copy.deepcopy(snapshot), 'after': copy.deepcopy(snapshot)},
            'radialQueryCount': 129654, 'totalQueryCount': 129660,
            'points': [{'kind': kind, 'key': key, **coords[key], 'top': key, 'stack': [key], 'apisAgree': True}
                       for kind, coords in [('probe', probes), ('center', centers)] for key in KEYS],
            'interaction': {'active': 'occluder', 'hovered': [], 'focusVisible': []},
            'loadedAssets': [{'type': t, 'matchesBuild': True, 'sha256': '0' * 64, 'file': 'synthetic', 'url': 'synthetic'}
                             for t in ['Script', 'Stylesheet']]}


def test_complete_record_exercises_all_three_buttons(complete_record):
    result = check_record(complete_record)
    assert all(result[key]['status'] == 'PASS' for key in ['C0', 'C1', 'C2', 'C3'])
    assert result['C2']['failureCount'] == 0
    assert set(result['C3']['distributions']) == set(KEYS)


@pytest.mark.parametrize('change', ['button', 'direction', 'row', 'asset', 'sync', 'unknown-node', 'state', 'field'])
def test_complete_record_rejects_missing_or_unwitnessed_data(complete_record, change):
    r = complete_record
    if change == 'button': del r['buttons']['sun']
    if change == 'direction': r['buttons']['moon']['rays'].pop()
    if change == 'row': r['buttons']['sun']['rays'][0]['rows'].pop()
    if change == 'asset': r['loadedAssets'][0]['matchesBuild'] = False
    if change == 'sync': r['witness']['calls'] = 0
    if change == 'unknown-node': r['buttons']['sun']['rays'][0]['rows'][0][4].append('unregistered')
    if change == 'state': r['after']['jd'] += 1
    if change == 'field': del r['interaction']
    assert check_record(r)['C0']['status'] == 'FAIL'


def test_incomplete_scan_cannot_claim_c3_pass(complete_record):
    for key in KEYS: complete_record['buttons'][key]['rays'] = []
    result = check_record(complete_record)
    assert result['C0']['status'] == 'FAIL'
    assert result['C3']['status'] == 'NOT_MEASURED'


@pytest.mark.parametrize('index,top', [(600, 'moon'), (1201, 'moon'), (2134, 'earth')])
def test_c2_accepts_truthful_api_disagreement_in_radial_samples(complete_record, index, top):
    row = complete_record['buttons']['moon']['rays'][0]['rows'][index]
    row[3], row[5] = top, False
    assert row[3] != row[4][0]
    if index == 600:
        assert 'moon' in row[4]  # Membership survives a different native top.
    else:
        assert 'moon' not in row[4]  # A miss after the boundary is legitimate.
    result = check_record(complete_record)
    assert all(result[c]['status'] == 'PASS' for c in ('C0', 'C1', 'C3'))
    assert result['C2']['status'] == 'PASS', result['C2']['failures']
    assert result['C2']['failureCount'] == 0
    assert result['C2']['modelMatchesNative'] is True
    assert row[3] == top and row[5] is False  # Reference evidence stays intact.


def test_missing_interior_member_cannot_be_rescued_by_native_top(complete_record):
    row = complete_record['buttons']['moon']['rays'][0]['rows'][600]
    row[3], row[4], row[5] = 'moon', ['occluder'], False
    result = check_record(complete_record)
    assert result['C0']['status'] == 'PASS'
    assert result['C3']['status'] == 'FAIL'
    assert result['C3']['distributions']['moon']['firstMissIndices'][0] == 600
    assert 'C3_RADIUS_ENVELOPE' in result['C3']['failures']
    assert 'C3_REENTRY' in result['C3']['failures']


@pytest.mark.parametrize('kind', ['probe', 'center'])
def test_c2_point_ownership_uses_stack_with_native_top_as_reference(complete_record, kind):
    p = next(p for p in complete_record['points'] if p['kind'] == kind and p['key'] == 'moon')
    p.update(top='occluder', apisAgree=False)
    result = check_record(complete_record)
    assert all(result[c]['status'] == 'PASS' for c in ('C0', 'C1', 'C3'))
    assert result['C2']['status'] == 'PASS', result['C2']['failures']
    assert result['C2']['failureCount'] == 0
    assert result['C2']['modelMatchesNative'] is True
    checked = next(p for p in result['C2']['points'] if p['kind'] == kind and p['key'] == 'moon')
    assert checked['nativeOwner'] == checked['modelOwner'] == 'moon'
    assert checked['top'] == 'occluder' and checked['apisAgree'] is False


@pytest.mark.parametrize('stack', [['occluder'], ['earth', 'moon'], ['occluder', 'moon'], ['moon', 'earth']])
def test_c2_rejects_missing_stolen_or_nonexclusive_moon_probe(complete_record, stack):
    p = next(p for p in complete_record['points'] if p['kind'] == 'probe' and p['key'] == 'moon')
    p.update(stack=stack, apisAgree=p['top'] == stack[0])
    result = check_record(complete_record)
    assert result['C0']['status'] == 'PASS'
    assert result['C2']['status'] == 'FAIL'
    assert 'C2_OWNERSHIP' in result['C2']['failures']
    assert result['C2']['failureCount'] == 1
    checked = next(p for p in result['C2']['points'] if p['kind'] == 'probe' and p['key'] == 'moon')
    assert checked['correct'] is False


@pytest.mark.parametrize('location', ['ray', 'point'])
@pytest.mark.parametrize('change', ['false-disagreement', 'false-agreement', 'nonboolean'])
def test_reference_flag_must_truthfully_encode_raw_values(complete_record, location, change):
    if location == 'ray':
        row = complete_record['buttons']['moon']['rays'][0]['rows'][600]
        if change == 'false-disagreement': row[5] = False
        if change == 'false-agreement': row[3] = 'moon'
        if change == 'nonboolean': row[5] = 1
    else:
        p = complete_record['points'][2]
        if change == 'false-disagreement': p['apisAgree'] = False
        if change == 'false-agreement': p['top'] = 'occluder'
        if change == 'nonboolean': p['apisAgree'] = 1
    result = check_record(complete_record)
    assert result['C0']['status'] == 'FAIL'
    assert 'C0_NATIVE_API_REFERENCE' in result['C0']['failures']


@pytest.mark.parametrize('location', ['ray', 'point'])
def test_reference_top_still_requires_a_registered_node(complete_record, location):
    if location == 'ray':
        row = complete_record['buttons']['moon']['rays'][0]['rows'][600]
        row[3], row[5] = 'unregistered', False
    else:
        complete_record['points'][2].update(top='unregistered', apisAgree=False)
    result = check_record(complete_record)
    assert result['C0']['status'] == 'FAIL'
    assert 'C0_UNKNOWN_ID' in result['C0']['failures']
