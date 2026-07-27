"""
services/storage_monitor.py — Storage / retention observability.

Emitted daily to catch the failure mode that took the database down during the
rollup rollout: the root disk filled to 100% and MySQL crash-looped on redo/temp
allocation. This job surfaces disk usage, per-table physical size, 24h write
volume, rollup lag, and rows still stranded in the pmax catchall partition, then
records an OpsEvent and fires a Telegram alert when a threshold is breached.

All metrics degrade safely: on SQLite (tests) or when a query fails, the field
is reported as 0 rather than raising, so monitoring never crashes the scheduler.
"""
from __future__ import annotations

import logging
import shutil
from datetime import datetime, timedelta, timezone

from extensions import db
from models.models import record_ops_event

log = logging.getLogger(__name__)


def _is_mysql() -> bool:
    try:
        return db.engine.dialect.name in ("mysql", "pymysql", "mariadb")
    except Exception:
        return False


def _scalar(sql: str, params: dict | None = None, default=0):
    try:
        val = db.session.execute(db.text(sql), params or {}).scalar()
        return val if val is not None else default
    except Exception:
        db.session.rollback()
        return default


def _table_rows(table: str) -> int:
    # Exact count; these tables are bounded by short retention so COUNT(*) is cheap.
    return int(_scalar(f"SELECT COUNT(*) FROM {table}", default=0) or 0)


def _table_size_mib(table: str) -> float:
    if not _is_mysql():
        return 0.0
    mib = _scalar(
        "SELECT ROUND((data_length + index_length)/1024/1024, 2) "
        "FROM information_schema.tables "
        "WHERE table_schema = DATABASE() AND table_name = :t",
        {"t": table}, default=0.0,
    )
    return float(mib or 0.0)


def _writes_last_24h(table: str) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).replace(tzinfo=None)
    return int(_scalar(
        f"SELECT COUNT(*) FROM {table} WHERE created_at >= :c",
        {"c": cutoff}, default=0,
    ) or 0)


def _rollup_lag_hours(table: str) -> float:
    """Hours since the newest rollup bucket. High lag = aggregation fell behind."""
    newest = _scalar(f"SELECT MAX(bucket_start) FROM {table}", default=None)
    if not newest:
        return 0.0
    if isinstance(newest, str):
        try:
            newest = datetime.fromisoformat(newest)
        except ValueError:
            return 0.0
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    if newest.tzinfo is not None:
        newest = newest.replace(tzinfo=None)
    delta = now - newest
    return round(max(0.0, delta.total_seconds() / 3600.0), 2)


def _pmax_resident_rows() -> int:
    """Rows stranded in the pmax catchall partition of probe_results.

    Non-zero means the daily maintenance job missed pre-creating partitions and
    data landed in pmax, which cannot be cheaply DROP-cleaned. A persistent
    non-zero value is an operational warning.
    """
    if not _is_mysql():
        return 0
    return int(_scalar(
        "SELECT COALESCE(table_rows, 0) FROM information_schema.partitions "
        "WHERE table_schema = DATABASE() AND table_name = 'probe_results' "
        "AND partition_name = 'pmax'",
        default=0,
    ) or 0)


def collect_storage_metrics() -> dict:
    """Gather storage/retention health metrics. Never raises."""
    usage = shutil.disk_usage("/")
    disk_used_pct = round(usage.used / usage.total * 100, 1) if usage.total else 0.0
    disk_avail_gb = round(usage.free / 1024 / 1024 / 1024, 2)

    return {
        "disk_used_pct": disk_used_pct,
        "disk_avail_gb": disk_avail_gb,
        "probe_results_rows": _table_rows("probe_results"),
        "ping_target_results_rows": _table_rows("ping_target_results"),
        "probe_results_size_mib": _table_size_mib("probe_results"),
        "ping_target_results_size_mib": _table_size_mib("ping_target_results"),
        "probe_results_writes_24h": _writes_last_24h("probe_results"),
        "ping_target_results_writes_24h": _writes_last_24h("ping_target_results"),
        "telemetry_rollup_lag_hours": _rollup_lag_hours("telemetry_rollups"),
        "ping_rollup_lag_hours": _rollup_lag_hours("ping_target_rollups"),
        "pmax_resident_rows": _pmax_resident_rows(),
    }


def _emit_storage_alert(title: str, body: str, level: str = "warn") -> None:
    """Record an ops event and push a Telegram alert if configured."""
    try:
        record_ops_event("storage_alert", title, message=body, level=level,
                          payload={"body": body})
        db.session.commit()
    except Exception:
        db.session.rollback()
        log.error("storage_monitor: failed to record ops event", exc_info=True)
    try:
        from models.models import TelegramConfig
        from api.telegram import send_message, _full_msg
        cfg = TelegramConfig.query.first()
        if cfg and cfg.enabled and cfg.bot_token:
            send_message(_full_msg(cfg.prefix, body))
    except Exception:
        log.error("storage_monitor: telegram push failed", exc_info=True)


def run_storage_monitor(app=None) -> dict:
    """Collect metrics, log them, and alert on threshold breaches.

    Returns the collected metrics plus an ``alerted`` flag for testability.
    """
    from flask import current_app

    metrics = collect_storage_metrics()

    cfg = current_app.config
    disk_pct_limit = float(cfg.get("STORAGE_DISK_ALERT_PCT", 85))
    lag_limit = float(cfg.get("STORAGE_ROLLUP_LAG_ALERT_HOURS", 6))
    pmax_limit = int(cfg.get("STORAGE_PMAX_ALERT_ROWS", 1))

    log.info(
        "storage_monitor: disk_used_pct=%.1f disk_avail_gb=%.2f "
        "probe_rows=%d ptr_rows=%d probe_mib=%.1f ptr_mib=%.1f "
        "probe_writes_24h=%d ptr_writes_24h=%d "
        "telemetry_lag_h=%.2f ping_lag_h=%.2f pmax_rows=%d",
        metrics.get("disk_used_pct", 0), metrics.get("disk_avail_gb", 0),
        metrics.get("probe_results_rows", 0), metrics.get("ping_target_results_rows", 0),
        metrics.get("probe_results_size_mib", 0), metrics.get("ping_target_results_size_mib", 0),
        metrics.get("probe_results_writes_24h", 0), metrics.get("ping_target_results_writes_24h", 0),
        metrics.get("telemetry_rollup_lag_hours", 0), metrics.get("ping_rollup_lag_hours", 0),
        metrics.get("pmax_resident_rows", 0),
    )

    breaches: list[str] = []
    if metrics["disk_used_pct"] >= disk_pct_limit:
        breaches.append(
            f"💽 磁盘使用率 {metrics['disk_used_pct']:.1f}% ≥ {disk_pct_limit:.0f}% "
            f"(剩余 {metrics['disk_avail_gb']:.2f} GB)"
        )
    if metrics["telemetry_rollup_lag_hours"] >= lag_limit:
        breaches.append(f"📉 Telemetry rollup 滞后 {metrics['telemetry_rollup_lag_hours']:.1f}h")
    if metrics["ping_rollup_lag_hours"] >= lag_limit:
        breaches.append(f"📉 PING rollup 滞后 {metrics['ping_rollup_lag_hours']:.1f}h")
    if metrics["pmax_resident_rows"] >= pmax_limit:
        breaches.append(
            f"🗂️ probe_results pmax 兜底分区残留 {metrics['pmax_resident_rows']} 行"
            "（分区预建可能滞后）"
        )

    alerted = False
    if breaches:
        body = "⚠️ <b>存储/保留告警</b>\n" + "\n".join(breaches)
        level = "error" if metrics["disk_used_pct"] >= disk_pct_limit else "warn"
        _emit_storage_alert("存储/保留告警", body, level=level)
        alerted = True

    metrics["alerted"] = alerted
    return metrics


def _job_storage_monitor(app):
    """Daily storage/retention health check (scheduler entry point)."""
    with app.app_context():
        try:
            run_storage_monitor(app)
        except Exception as exc:
            log.error("storage_monitor job failed: %s", exc, exc_info=True)
