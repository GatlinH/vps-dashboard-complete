"""Independent C0-C3 checker for raw native browser records. No product imports.

C2/C3 use elementsFromPoint stacks. Option (ii) deliberately drops cross-API
agreement as a correctness requirement: Chromium disagrees at clip boundaries.
Both native results remain evidence; see docs/c2-stack-criterion.md.
"""
import hashlib
import math

KEYS = ('sun', 'earth', 'moon')
STATES = ('idle',) + tuple(f'{action}-{key}' for action in ('hover', 'focus') for key in KEYS)
DIRECTIONS = tuple(f'deg-{i * 22.5:g}' for i in range(16)) + ('toward-moon-probe', 'opposite-moon-probe')
EXPECTED_KEYS = {(d, f, s) for d in (1, 2, 3) for f in (1, 1.25) for s in STATES}


def verdict(failures, **fields):
    return {'status': 'FAIL' if failures else 'PASS', 'failures': sorted(set(failures)), **fields}


def finite(n):
    return type(n) in (int, float) and math.isfinite(n)


def finite_numbers(value):
    if type(value) in (int, float): return math.isfinite(value)
    if isinstance(value, dict): return all(finite_numbers(v) for v in value.values())
    if isinstance(value, list): return all(finite_numbers(v) for v in value)
    return True


def point(p):
    return isinstance(p, dict) and all(finite(p.get(axis)) for axis in ('x', 'y'))


def distance(a, b):
    return math.hypot(a['x'] - b['x'], a['y'] - b['y'])


def native_reference_valid(top, stack, agrees):
    """Validate the recorded flag, without requiring the native APIs to agree."""
    return ((top is None or isinstance(top, str) and bool(top))
            and type(agrees) is bool and agrees == (top == stack[0]))


def check_ray(key, ray):
    failures = []
    rows = ray.get('rows', [])
    center, angle = ray.get('center'), ray.get('angle')
    if len(rows) != 2401 or not point(center) or not finite(angle):
        return {'failures': ['C0_RAY_SHAPE'], 'firstMissIndex': None}
    members = []
    for i, row in enumerate(rows):
        if (not isinstance(row, list) or len(row) != 6 or row[0] != i
                or not finite(row[1]) or not finite(row[2]) or not isinstance(row[4], list)
                or not row[4] or not all(isinstance(node, str) and node for node in row[4])
                or len(set(row[4])) != len(row[4])):
            return {'failures': ['C0_RAW_SAMPLE'], 'firstMissIndex': None}
        # Only serialization/libm arithmetic allowance; never a radius tolerance.
        if (abs(row[1] - (center['x'] + i / 100 * math.cos(angle))) > 1e-12
                or abs(row[2] - (center['y'] + i / 100 * math.sin(angle))) > 1e-12):
            failures.append('C0_RAW_COORDINATE')
        if not native_reference_valid(row[3], row[4], row[5]):
            failures.append('C0_NATIVE_API_REFERENCE')
        members.append(key in row[4])
    j = next((i for i, member in enumerate(members) if not member), -1)
    if not members[0]: failures.append('C3_CENTER_MISSING')
    if not 1198 <= j <= 1203: failures.append('C3_RADIUS_ENVELOPE')
    if j >= 0 and any(members[j:]): failures.append('C3_REENTRY')
    return {'failures': sorted(set(failures)), 'firstMissIndex': j}


def check_spread(indices):
    if len(indices) != 18 or any(type(j) is not int or j < 0 for j in indices):
        return ['C0_DIRECTION_COUNT_OR_INDEX']
    return [] if max(indices) - (min(indices) - 1) <= 5 else ['C3_DIRECTION_SPREAD']


def check_points(points, centers):
    required = {(kind, key) for kind in ('probe', 'center') for key in KEYS}
    if (not isinstance(points, list) or len(points) != 6
            or {(p.get('kind'), p.get('key')) for p in points} != required
            or any(not point(centers.get(key)) for key in KEYS)):
        return verdict(['C0_SIX_POINTS'], failureCount=6, modelMatchesNative=False, points=[])
    checked = []
    for p in points:
        if not point(p) or not isinstance(p.get('stack'), list) or not p['stack']:
            return verdict(['C0_POINT_FIELDS'], failureCount=6, modelMatchesNative=False, points=[])
        if 'top' not in p or not native_reference_valid(p['top'], p['stack'], p.get('apisAgree')):
            return verdict(['C0_NATIVE_API_REFERENCE'], failureCount=6, modelMatchesNative=False, points=[])
        # This is deliberately independent of SolarHitLayout/classifySolarHitLayout.
        model = next((key for key in KEYS if distance(p, centers[key]) <= 12), None)
        native = p['stack'][0]  # Keep occluders: membership alone cannot prove ownership.
        correct = native == model == p['key']
        if p['kind'] == 'probe' and p['key'] == 'moon':
            correct = correct and 'moon' in p['stack'] and 'earth' not in p['stack']
        checked.append({**p, 'nativeOwner': native, 'modelOwner': model,
                        'modelMatchesNative': model == native, 'correct': correct})
    count = sum(not p['correct'] for p in checked)
    return verdict(['C2_OWNERSHIP'] if count else [], failureCount=count,
                   modelMatchesNative=all(p['modelMatchesNative'] for p in checked), points=checked)


def check_matrix(records):
    keys = [(r.get('dpr'), r.get('fontScale'), r.get('state')) for r in records]
    return [] if len(keys) == 42 and set(keys) == EXPECTED_KEYS else ['C0_EXACT_42_KEYS']


def check_record(record):
    try:
        return _check_record(record)
    except (KeyError, TypeError, ValueError, IndexError, AttributeError) as error:
        return {'C0': verdict(['C0_MALFORMED_RECORD'], detail=str(error)),
                **{k: {'status': 'NOT_MEASURED'} for k in ('C1', 'C2', 'C3')}}


def _check_record(record):
    failures = []
    try:
        assert finite_numbers(record), 'non-finite number'
        assert record['schema'] == 1
        before, after, witness = record['before'], record['after'], record['witness']
        centers, probes, canvas = before['centers'], before['probes'], before['canvas']
        assert set(centers) == set(probes) == set(record['buttons']) == set(KEYS)
        assert all(point(centers[k]) and point(probes[k]) for k in KEYS)
        assert before == after, 'query state changed'
        assert witness['after'] == before, 'state changed since original sync'
        assert witness['instance'] and witness['constructor'] and witness['calls'] == 1
        assert all(witness[k] is True for k in ('realInstance', 'rendererCanvas', 'prototypeMethod', 'originalUnchanged'))
        assert witness['functionSha256'] == hashlib.sha256(witness['functionSource'].encode()).hexdigest()
        assert witness['before']['jd'] == before['jd']
        assert witness['before']['camera'] == before['camera']
        for name, size in [('position', 3), ('target', 3), ('home', 3), ('projection', 16), ('world', 16)]:
            values = before['camera'][name]
            assert len(values) == size and all(finite(v) for v in values)
        assert record['radialQueryCount'] == 129654 and record['totalQueryCount'] == 129660
        assert len(record['points']) == 6
        registry = record['registry']
        assert registry
        for k in KEYS:
            assert registry[k]['tag'] == 'BUTTON' and registry[k]['connected'] is True
            assert record['buttons'][k]['node'] == k
        # Provenance is acquired from actual CDP response bodies, not a model.
        assets = record['loadedAssets']
        assert assets and {a['type'] for a in assets} >= {'Script', 'Stylesheet'}
        assert all(a['matchesBuild'] is True and len(a['sha256']) == 64 and a['file'] and a['url'] for a in assets)
    except (KeyError, TypeError, AssertionError, ValueError) as error:
        return {'C0': verdict(['C0_RECORD_FIELDS_OR_WITNESS'], detail=str(error)),
                **{k: {'status': 'NOT_MEASURED'} for k in ('C1', 'C2', 'C3')}}

    c1 = []
    if (record['viewport'] != [320, 700] or record['devicePixelRatio'] != record['dpr']
            or before['jd'] != 2446454.4312 or before['running'] is not False
            or before['playbackPaused'] is not True or before['atHome'] is not True
            or before['tween'] is not False or before['ready'] is not True
            or not all(before['targets'].get(k) is True for k in KEYS)
            or before['camera']['position'] != before['camera']['home']
            or canvas['width'] != 320 or canvas['height'] != 180
            or not finite(record.get('initialRootFontSize')) or record['initialRootFontSize'] <= 0
            or record['rootFontSize'] != record['initialRootFontSize'] * record['fontScale']):
        c1.append('C1_CONFIGURATION')
    references = [(probes['moon'], (145.85845290736307, 78.3708542528869)),
                  (centers['earth'], (148.52980041503906, 91.24215698242188)),
                  (centers['moon'], (143.5714111328125, 67.35126495361328))]
    if any(abs(p[axis] - canvas[origin] - ref[i]) > .001
           for p, ref in references for i, (axis, origin) in enumerate((('x', 'left'), ('y', 'top')))):
        c1.append('C1_REFERENCE_COORDINATES')
    separation = distance(centers['earth'], centers['moon'])
    if separation < 24.4: c1.append('C1_HARD_SEPARATION')
    if distance(probes['moon'], centers['moon']) > 11.97 or distance(probes['moon'], centers['earth']) < 12.03:
        c1.append('C1_PROBE_MARGINS')
    state, interaction = record['state'], record['interaction']
    if state.startswith('focus-'):
        key = state.removeprefix('focus-')
        if interaction['active'] != key or key not in interaction['focusVisible'] or interaction['hovered']:
            c1.append('C1_KEYBOARD_STATE')
        if not record.get('inputWitness', {}).get('tabEvents'): c1.append('C1_REAL_TAB_REQUIRED')
    elif state.startswith('hover-'):
        if interaction['hovered'] != [state.removeprefix('hover-')]: c1.append('C1_HOVER_STATE')
    elif state != 'idle' or interaction['hovered'] or interaction['active'] in KEYS:
        c1.append('C1_IDLE_STATE')

    c2 = check_points(record['points'], centers)
    failures.extend(f for f in c2['failures'] if f.startswith('C0'))
    for p in record['points']:
        expected = (probes if p['kind'] == 'probe' else centers)[p['key']]
        if p['x'] != expected['x'] or p['y'] != expected['y']:
            failures.append('C0_POINT_COORDINATES')
        nodes = p['stack'] + ([p['top']] if p.get('top') is not None else [])
        if any(not isinstance(node, str) or node not in registry for node in nodes): failures.append('C0_UNKNOWN_ID')
    c3, distributions, measured_rays = [], {}, 0
    toward = math.atan2(probes['moon']['y'] - centers['earth']['y'], probes['moon']['x'] - centers['earth']['x'])
    angles = [i * math.pi / 8 for i in range(16)] + [toward, toward + math.pi]
    for key in KEYS:
        rays = record['buttons'][key].get('rays', [])
        if len(rays) != 18 or [r.get('id') for r in rays] != list(DIRECTIONS):
            failures.append('C0_DIRECTIONS')
            continue
        js = []
        for ray, angle in zip(rays, angles):
            result = check_ray(key, ray)
            if result['firstMissIndex'] is not None: measured_rays += 1
            if (ray.get('center') != centers[key] or not finite(ray.get('angle'))
                    or abs(ray['angle'] - angle) > 1e-12): failures.append('C0_RAY_IDENTITY')
            failures.extend(f for f in result['failures'] if f.startswith('C0'))
            c3.extend(f for f in result['failures'] if f.startswith('C3'))
            js.append(result['firstMissIndex'])
            for row in ray.get('rows', []):
                if len(row) == 6 and isinstance(row[4], list):
                    nodes = row[4] + ([row[3]] if row[3] is not None else [])
                    if any(not isinstance(node, str) or node not in registry for node in nodes):
                        failures.append('C0_UNKNOWN_ID')
                        break
        c3.extend(check_spread(js))
        distributions[key] = {'firstMissIndices': js}
        if all(type(j) is int and j >= 0 for j in js):
            distributions[key].update(minJ=min(js), maxJ=max(js), spreadIndices=max(js) - (min(js) - 1))
    c2['status'] = 'FAIL' if c2['failures'] else 'PASS'
    c3_result = verdict(c3, distributions=distributions)
    if measured_rays != 54 and not c3: c3_result['status'] = 'NOT_MEASURED'
    return {'C0': verdict(failures), 'C1': verdict(c1, separation=separation),
            'C2': c2, 'C3': c3_result}
