"""Bounded retention cleanup for high-volume operational tables."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_

from models.models import AuditLog, OpsEvent, AgentSecurityAggregate, db

_ALLOWED = {AuditLog: 'audit_logs', OpsEvent: 'ops_events', AgentSecurityAggregate: 'agent_security_aggregates'}

def _bulk_delete(model, predicate, batch_size):
    if model not in _ALLOWED:
        raise ValueError('model not allowed for retention cleanup')
    total = 0
    while True:
        ids = [r[0] for r in db.session.query(model.id).filter(predicate).order_by(model.id).limit(batch_size).all()]
        if not ids:
            break
        deleted = db.session.query(model).filter(model.id.in_(ids)).delete(synchronize_session=False)
        db.session.commit()
        total += deleted
    return total


def cleanup_audit_and_ops(app, retention_days=None, batch_size=1000, dry_run=False, now=None):
    """Apply explicit retention tiers without ever touching ProbeResult."""
    size = max(1, int(app.config.get('AUDIT_OPS_CLEANUP_BATCH_SIZE', batch_size)))
    now = now or datetime.now(timezone.utc)
    audit_days = int(retention_days) if retention_days is not None else 90
    cutoffs = {
        'audit_logs_90d': now - timedelta(days=audit_days),
        'known_agent_ops_30d': now - timedelta(days=30),
        'unknown_scanner_ops_14d': now - timedelta(days=14),
        'legacy_ops_90d': now - timedelta(days=90),
        'agent_security_aggregates_180d': now - timedelta(days=180),
    }
    known_classes = ('known_agent_auth', 'diagnostic_agent_auth')
    predicates = {
        'audit_logs_90d': AuditLog.created_at < cutoffs['audit_logs_90d'],
        'known_agent_ops_30d': and_(OpsEvent.classification.in_(known_classes), OpsEvent.created_at < cutoffs['known_agent_ops_30d']),
        'unknown_scanner_ops_14d': and_(OpsEvent.classification == 'unknown_scanner', OpsEvent.created_at < cutoffs['unknown_scanner_ops_14d']),
        'legacy_ops_90d': and_(or_(OpsEvent.classification.is_(None), ~OpsEvent.classification.in_(known_classes + ('unknown_scanner',))), OpsEvent.created_at < cutoffs['legacy_ops_90d']),
        'agent_security_aggregates_180d': AgentSecurityAggregate.last_seen < cutoffs['agent_security_aggregates_180d'],
    }
    result = {'cutoffs': cutoffs, 'dry_run': bool(dry_run)}
    with app.app_context():
        specs = (
            (AuditLog, 'audit_logs_90d'),
            (OpsEvent, 'known_agent_ops_30d'),
            (OpsEvent, 'unknown_scanner_ops_14d'),
            (OpsEvent, 'legacy_ops_90d'),
            (AgentSecurityAggregate, 'agent_security_aggregates_180d'),
        )
        for model, key in specs:
            result[key] = db.session.query(model.id).filter(predicates[key]).count() if dry_run else _bulk_delete(model, predicates[key], size)
    result['audit_logs'] = result['audit_logs_90d']
    result['ops_events'] = sum(result[key] for key in ('known_agent_ops_30d', 'unknown_scanner_ops_14d', 'legacy_ops_90d'))
    result['agent_security_aggregates'] = result['agent_security_aggregates_180d']
    return result
