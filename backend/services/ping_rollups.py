"""Bounded hourly aggregates for PING target history."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Mapping

from extensions import db
from models.models import PingTargetRollup


def _hour(value: datetime | None = None) -> datetime:
    value = value or datetime.now(timezone.utc)
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.replace(minute=0, second=0, microsecond=0)


def _number(value, default=0.0) -> float:
    try:
        return float(value) if value is not None else default
    except (TypeError, ValueError):
        return default


def record_ping_rollup(server_id: int, target: Mapping, created_at: datetime | None = None) -> PingTargetRollup:
    """Add one persisted target probe to a per-server/per-target UTC-hour bucket.

    Caller owns the transaction. This keeps 90-day PING history at most one row
    per target/hour regardless of the agent sampling interval.
    """
    stats = target.get("stats") or {}
    key = str(target.get("key") or target.get("host") or target.get("label") or "unknown")[:128]
    bucket_start = _hour(created_at)
    row = PingTargetRollup.query.filter_by(
        server_id=int(server_id), target_key=key, bucket_start=bucket_start,
    ).one_or_none()
    if row is None:
        row = PingTargetRollup(
            server_id=int(server_id), target_key=key, bucket_start=bucket_start,
            label=str(target.get("label") or target.get("host") or key)[:255],
            protocol=str(target.get("protocol") or "icmp")[:16],
        )
        db.session.add(row)
    row.sample_count = int(row.sample_count or 0) + 1
    latency = stats.get("avg_ms")
    if latency is not None:
        row.success_count = int(row.success_count or 0) + 1
        row.latency_sum = _number(row.latency_sum) + _number(latency)
    row.loss_sum = _number(row.loss_sum) + _number(stats.get("loss_pct"))
    return row


def query_ping_rollups(server_id: int, since: datetime, limit: int):
    if since.tzinfo is not None:
        since = since.astimezone(timezone.utc).replace(tzinfo=None)
    return (
        PingTargetRollup.query
        .filter(PingTargetRollup.server_id == int(server_id), PingTargetRollup.bucket_start >= since)
        .order_by(PingTargetRollup.bucket_start.asc())
        .limit(max(1, int(limit)))
        .all()
    )


def compact_ping_rollups(*, retention_days: int, now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    cutoff = _hour(now - timedelta(days=max(1, int(retention_days))))
    return PingTargetRollup.query.filter(PingTargetRollup.bucket_start < cutoff).delete(synchronize_session=False)


def serialize_ping_rollups(rows) -> list[dict]:
    grouped: dict[str, dict] = {}
    for row in rows:
        item = grouped.setdefault(row.target_key, {
            "key": row.target_key, "label": row.label or row.target_key,
            "protocol": row.protocol or "icmp", "points": [],
        })
        samples = max(1, int(row.sample_count or 0))
        success = int(row.success_count or 0)
        point = {
            "x": row.bucket_start.replace(tzinfo=timezone.utc).isoformat(),
            "success": bool(success),
            "loss_pct": float(row.loss_sum or 0) / samples,
            "protocol": row.protocol or "icmp",
            "key": row.target_key,
            "label": row.label or row.target_key,
        }
        if success:
            point["latency_ms"] = float(row.latency_sum or 0) / success
        item["points"].append(point)
    return list(grouped.values())
