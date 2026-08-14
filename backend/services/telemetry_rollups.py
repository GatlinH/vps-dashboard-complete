"""Bounded, materialized telemetry rollups for long-range detail charts."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Mapping

from sqlalchemy import func

from extensions import db
from models.models import TelemetryRollup

HOURLY_RESOLUTION_MINUTES = 60


def mysql_epoch_bucket_expression(timestamp_column, *, bucket_seconds: int):
    """Return the canonical MySQL epoch bucket expression used by raw telemetry APIs."""
    seconds = int(bucket_seconds)
    if seconds <= 0:
        raise ValueError("bucket_seconds must be positive")
    return (
        func.floor(func.unix_timestamp(timestamp_column) / seconds) * seconds
    ).label("bucket_ts")


def _utc_naive_hour(value: datetime | None = None) -> datetime:
    value = value or datetime.now(timezone.utc)
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.replace(minute=0, second=0, microsecond=0)


def _metric(value) -> float:
    try:
        return float(value) if value is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def record_telemetry_rollup(server_id: int, metrics: Mapping, created_at: datetime | None = None) -> TelemetryRollup:
    """Add one accepted telemetry sample to its server's UTC-hour bucket.

    The caller owns the SQLAlchemy transaction. The unique bucket key prevents
    storage growth with sampling frequency: a server writes at most 24 hourly
    rows per day per rollup resolution.
    """
    bucket_start = _utc_naive_hour(created_at)
    row = TelemetryRollup.query.filter_by(
        server_id=int(server_id),
        resolution_minutes=HOURLY_RESOLUTION_MINUTES,
        bucket_start=bucket_start,
    ).one_or_none()
    if row is None:
        row = TelemetryRollup(
            server_id=int(server_id),
            resolution_minutes=HOURLY_RESOLUTION_MINUTES,
            bucket_start=bucket_start,
            sample_count=0,
        )
        db.session.add(row)

    row.sample_count = int(row.sample_count or 0) + 1
    row.cpu_sum = _metric(row.cpu_sum) + _metric(metrics.get("cpu_use"))
    row.ram_sum = _metric(row.ram_sum) + _metric(metrics.get("ram_use"))
    row.disk_sum = _metric(row.disk_sum) + _metric(metrics.get("disk_use"))
    row.net_up_sum = _metric(row.net_up_sum) + _metric(metrics.get("net_up"))
    row.net_down_sum = _metric(row.net_down_sum) + _metric(metrics.get("net_down"))
    return row


def query_hourly_telemetry_rollups(server_id: int, since: datetime, limit: int):
    """Return bounded hourly rollups ordered for chart consumption."""
    if since.tzinfo is not None:
        since = since.astimezone(timezone.utc).replace(tzinfo=None)
    return (
        TelemetryRollup.query
        .filter(
            TelemetryRollup.server_id == int(server_id),
            TelemetryRollup.resolution_minutes == HOURLY_RESOLUTION_MINUTES,
            TelemetryRollup.bucket_start >= since,
        )
        .order_by(TelemetryRollup.bucket_start.asc())
        .limit(max(1, int(limit)))
        .all()
    )


def serialize_hourly_telemetry_rollup(row: TelemetryRollup) -> dict:
    samples = max(1, int(row.sample_count or 0))
    return {
        "created_at": row.bucket_start.replace(tzinfo=timezone.utc).isoformat(),
        "cpu_use": float(row.cpu_sum or 0) / samples,
        "ram_use": float(row.ram_sum or 0) / samples,
        "disk_use": float(row.disk_sum or 0) / samples,
        "net_up": float(row.net_up_sum or 0) / samples,
        "net_down": float(row.net_down_sum or 0) / samples,
        "samples": samples,
        "bucket_minutes": HOURLY_RESOLUTION_MINUTES,
    }


def compact_telemetry_rollups(*, retention_days: int, now: datetime | None = None) -> int:
    """Delete old rollup buckets; caller owns the transaction."""
    from datetime import timedelta
    now = now or datetime.now(timezone.utc)
    cutoff = _utc_naive_hour(now - timedelta(days=max(1, int(retention_days))))
    return TelemetryRollup.query.filter(TelemetryRollup.bucket_start < cutoff).delete(synchronize_session=False)
