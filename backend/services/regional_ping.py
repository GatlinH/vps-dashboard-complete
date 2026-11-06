"""Read-only, bounded observations for configured regional PING targets."""

from datetime import datetime, timedelta, timezone

from sqlalchemy.exc import OperationalError, ProgrammingError

from extensions import db
from services.peer_probe import _normalize_ping_target_region


def parse_selection(args, source=None, overview=False):
    for name in ('source', 'region', 'ungrouped', 'hours'):
        if len(args.getlist(name)) > 1:
            raise ValueError(f'duplicate {name}')
    if overview and set(args) - {'source', 'region', 'ungrouped', 'hours'}:
        raise ValueError('unknown query parameter')
    source = str(source if source is not None else args.get('source', 'public')).strip().lower()
    if source not in ('public', 'external', 'agent'):
        raise ValueError('invalid source')
    if 'region' in args and 'ungrouped' in args:
        raise ValueError('region and ungrouped are independent selections')
    region = None
    if 'region' in args:
        literal = args['region']
        region = literal.strip()
        if not region or _normalize_ping_target_region(literal) != literal:
            raise ValueError('invalid region')
    ungrouped = 'ungrouped' in args
    if ungrouped and args['ungrouped'] != '1':
        raise ValueError('ungrouped must be 1')
    return source, {'region': region, 'ungrouped': ungrouped}


def select_targets(targets, selection):
    return [target for target in targets if (
        target.get('region', '') == '' if selection['ungrouped'] else
        selection['region'] is None or target.get('region', '') == selection['region']
    )]


def target_aliases(targets, with_port=True):
    canonical = {target['key'] for target in targets}
    owners = {}
    aliases = {}
    for target in targets:
        signature = (target.get('protocol') or 'icmp',)
        if with_port:
            signature += (target.get('port'),)
        aliases[(target['key'], *signature)] = target
        for alias in (target.get('host'), target.get('label')):
            if alias and alias not in canonical:
                identity = (str(alias), *signature)
                owners.setdefault(identity, {})[target['key']] = target
    for identity, candidates in owners.items():
        if len(candidates) == 1:
            aliases[identity] = next(iter(candidates.values()))
    return aliases


def _iso(value):
    if value is None:
        return None
    if not isinstance(value, datetime):
        value = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def _metrics(row=None):
    row = row or {}
    count = int(row.get('sample_count') or 0)
    success = int(row.get('success_count') or 0)
    failure = count - success
    latency = row.get('latency_ms') if success else None
    loss = row.get('loss_pct')
    status = 'missing' if not count else 'fail' if not success else (
        'loss' if failure or (loss is not None and float(loss) > 0) else 'ok'
    )
    return {
        'status': status, 'sample_count': count, 'success_count': success,
        'fail_count': failure, 'first_seen': _iso(row.get('first_seen')),
        'last_seen': _iso(row.get('last_seen')),
        'latency_ms': round(float(latency), 1) if latency is not None else None,
        'loss_pct': round(float(loss), 1) if loss is not None else None,
        'report_failure_pct': round(failure * 100 / count, 1) if count else None,
    }


def _query_observations(sid, configured, targets, start, end, requested, width):
    if not targets:
        return {}, {}
    aliases = target_aliases(configured)
    params = {
        'sid': sid, 'start': start.replace(tzinfo=None), 'end': end.replace(tzinfo=None),
        'requested': requested.replace(tzinfo=None), 'width': width,
    }
    conditions = []
    for index, target in enumerate(targets):
        keys = [identity[0] for identity, owner in aliases.items() if owner['key'] == target['key']]
        placeholders = []
        for alias_index, key in enumerate(keys):
            name = f'key_{index}_{alias_index}'
            params[name] = key
            placeholders.append(f':{name}')
        params[f'canonical_{index}'] = target['key']
        params[f'protocol_{index}'] = target['protocol']
        params[f'port_{index}'] = target.get('port')
        port_clause = f'{{prefix}}port = :port_{index}' if target.get('port') is not None else '{prefix}port IS NULL'
        conditions.append(
            f'({{prefix}}target_key IN ({", ".join(placeholders)}) '
            f'AND {{prefix}}protocol = :protocol_{index} AND {port_clause})'
        )

    def matching(prefix=''):
        return '(' + ' OR '.join(condition.format(prefix=prefix) for condition in conditions) + ')'

    def canonical(prefix=''):
        branches = ' '.join(
            f'WHEN {condition.format(prefix=prefix)} THEN :canonical_{index}'
            for index, condition in enumerate(conditions)
        )
        return f'CASE {branches} END'

    aggregates_sql = f'''
        SELECT {canonical()} AS canonical_key,
               FLOOR(UNIX_TIMESTAMP(created_at) / :width) * :width AS bucket_epoch,
               COUNT(*) AS sample_count,
               SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success_count,
               MIN(created_at) AS first_seen, MAX(created_at) AS last_seen,
               AVG(CASE WHEN success = 1 THEN latency_ms END) AS latency_ms,
               AVG(loss_pct) AS loss_pct
        FROM ping_target_results
        WHERE server_id = :sid AND created_at >= :start AND created_at < :end
          AND {matching()}
        GROUP BY canonical_key, bucket_epoch
        ORDER BY bucket_epoch ASC
    '''
    same_target = ' OR '.join(
        f'({condition.format(prefix="sample.")} AND {condition.format(prefix="newer.")})'
        for condition in conditions
    )
    latest_sql = f'''
        SELECT {canonical('sample.')} AS canonical_key,
               sample.created_at AS first_seen, sample.created_at AS last_seen,
               sample.latency_ms, sample.loss_pct, 1 AS sample_count,
               CASE WHEN sample.success = 1 THEN 1 ELSE 0 END AS success_count
        FROM ping_target_results sample
        JOIN (
            SELECT {canonical()} AS canonical_key, MAX(created_at) AS observed_at
            FROM ping_target_results
            WHERE server_id = :sid AND created_at >= :start AND created_at < :requested
              AND {matching()}
            GROUP BY canonical_key
        ) recent ON sample.created_at = recent.observed_at
                   AND {canonical('sample.')} = recent.canonical_key
        WHERE sample.server_id = :sid AND sample.created_at >= :start
          AND sample.created_at < :requested AND {matching('sample.')}
          AND NOT EXISTS (
              SELECT 1 FROM ping_target_results newer
              WHERE newer.server_id = :sid AND newer.created_at = sample.created_at
                AND newer.id > sample.id AND ({same_target})
          )
    '''
    try:
        with db.session.no_autoflush:
            aggregates = db.session.execute(db.text(aggregates_sql), params).mappings().all()
            latest = db.session.execute(db.text(latest_sql), params).mappings().all()
    except (OperationalError, ProgrammingError) as exc:
        message = str(exc.orig).lower()
        if 'ping_target_results' in message and ('no such table' in message or "doesn't exist" in message):
            return {}, {}
        raise
    return (
        {(row['canonical_key'], int(row['bucket_epoch'])): row for row in aggregates},
        {row['canonical_key']: row for row in latest},
    )


def build_overview(sid, configured, selection, hours, source, requested=None):
    requested = requested or datetime.now(timezone.utc)
    width = {1: 300, 6: 900, 24: 3600}[hours]
    count = hours * 3600 // width
    end = datetime.fromtimestamp(int(requested.timestamp()) // width * width, timezone.utc)
    start = end - timedelta(hours=hours)
    selected = select_targets(configured, selection)
    aggregates, latest = _query_observations(sid, configured, selected, start, end, requested, width)
    regions = {}
    for target in configured:
        region = target.get('region', '')
        group = regions.setdefault(region, {'region': region, 'ungrouped': region == '', 'target_count': 0})
        group['target_count'] += 1
    targets = []
    for target in selected:
        item = {name: target.get(name, '' if name == 'region' else None) for name in (
            'key', 'label', 'host', 'port', 'protocol', 'type', 'region',
        )}
        observation = latest.get(target['key'])
        item['summary'] = {
            **_metrics(observation), 'observed_at': _iso(observation['last_seen']) if observation else None,
            'sample_source': 'agent-reported' if observation else 'missing',
        }
        item['slots'] = []
        item['points'] = []
        for index in range(count):
            slot_start = start + timedelta(seconds=index * width)
            slot = {
                'start': _iso(slot_start), 'end': _iso(slot_start + timedelta(seconds=width)),
                **_metrics(aggregates.get((target['key'], int(slot_start.timestamp())))),
            }
            item['slots'].append(slot)
            if slot['success_count'] and slot['latency_ms'] is not None:
                item['points'].append({
                    'x': slot['last_seen'], 'latency_ms': slot['latency_ms'], 'success': True,
                    'loss_pct': slot['loss_pct'], 'protocol': target['protocol'],
                    'key': target['key'], 'label': target['label'],
                })
        targets.append(item)
    return {
        'server_id': sid, 'configured': bool(configured), 'not_configured': not configured,
        'probe_source': 'agent' if source == 'agent' else 'external',
        'derived_from': 'persisted agent peer results' if source == 'agent' else 'persisted ping_target_results',
        'requested_at': _iso(requested), 'window_hours': hours, 'bucket_seconds': width,
        'slot_count': count, 'window_start': _iso(start), 'window_end': _iso(end),
        'regions': list(regions.values()), 'selection': selection, 'targets': targets,
    }
