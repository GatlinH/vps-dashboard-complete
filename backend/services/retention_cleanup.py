"""Bounded retention cleanup for high-volume operational tables."""
from datetime import datetime, timedelta, timezone

from models.models import AuditLog, OpsEvent, AgentSecurityAggregate, db

_ALLOWED = {AuditLog: 'audit_logs', OpsEvent: 'ops_events', AgentSecurityAggregate: 'agent_security_aggregates'}

def _bulk_delete(model, cutoff, batch_size):
    if model not in _ALLOWED:
        raise ValueError('model not allowed for retention cleanup')
    total = 0
    while True:
        ids = [r[0] for r in db.session.query(model.id).filter(model.created_at < cutoff).order_by(model.id).limit(batch_size).all()]
        if not ids:
            break
        deleted = db.session.query(model).filter(model.id.in_(ids)).delete(synchronize_session=False)
        db.session.commit()
        total += deleted
    return total


def cleanup_audit_and_ops(app, retention_days=14, batch_size=1000, dry_run=False):
    days = int(app.config.get('AUDIT_OPS_RETENTION_DAYS', retention_days))
    size = max(1, int(app.config.get('AUDIT_OPS_CLEANUP_BATCH_SIZE', batch_size)))
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    result = {'cutoff': cutoff, 'audit_logs': 0, 'ops_events': 0, 'agent_security_aggregates': 0, 'dry_run': bool(dry_run)}
    if dry_run:
        with app.app_context():
            result['audit_logs'] = AuditLog.query.filter(AuditLog.created_at < cutoff).count()
            result['ops_events'] = OpsEvent.query.filter(OpsEvent.created_at < cutoff).count()
            result['agent_security_aggregates'] = AgentSecurityAggregate.query.filter(AgentSecurityAggregate.last_seen < datetime.now(timezone.utc) - timedelta(days=180)).count()
        return result
    with app.app_context():
        for model, key in _ALLOWED.items():
            model_cutoff = cutoff
            if model is AgentSecurityAggregate:
                model_cutoff = datetime.now(timezone.utc) - timedelta(days=180)
                # Aggregate uses last_seen rather than created_at.
                total = 0
                while True:
                    ids = [r[0] for r in db.session.query(model.id).filter(model.last_seen < model_cutoff).limit(size).all()]
                    if not ids: break
                    total += db.session.query(model).filter(model.id.in_(ids)).delete(synchronize_session=False); db.session.commit()
                result[key] = total
            else:
                result[key] = _bulk_delete(model, model_cutoff, size)
    return result
