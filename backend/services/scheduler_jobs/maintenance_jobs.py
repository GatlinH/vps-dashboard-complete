"""Retention, cleanup, and partition maintenance scheduled jobs."""
import logging
import os
from datetime import datetime, timezone, timedelta
log = logging.getLogger(__name__)

_CLEANUP_BATCH = 1_000

# Batch size for chunked DELETE operations (retention cleanup fallback).
# Small enough to avoid long row-lock windows; large enough to finish quickly
# without excessive round-trips.  Each batch is committed independently so
# InnoDB releases its row locks after every _CLEANUP_BATCH rows.
# Partial deletions caused by mid-run errors are intentional: the job is
def _job_cleanup(app):
    """清理历史探针数据（MySQL 优先 DROP PARTITION，非 MySQL 或未分区表降级为 DELETE）。

    保留天数由 PROBE_RESULT_RETENTION_DAYS 控制（默认 30 天）。
    清理过程输出结构化日志：分区名、耗时、影响范围。
    本函数幂等，重复执行不报错。
    """
    import time as _time
    from extensions import db
    from models.models import ProbeResult
    from services.probe_partition import (
        _is_mysql, drop_expired_partitions, list_partitions,
    )

    retention_days = int(app.config.get("PROBE_RESULT_RETENTION_DAYS", 30))
    ptr_retention_days = int(app.config.get("PING_TARGET_RESULT_RETENTION_DAYS", 7))
    rollup_retention_days = int(app.config.get("TELEMETRY_ROLLUP_RETENTION_DAYS", 180))
    ping_rollup_retention_days = int(app.config.get("PING_ROLLUP_RETENTION_DAYS", 180))
    t0 = _time.perf_counter()

    with app.app_context():
        engine = db.engine
        # Materialized hourly history is cheap but bounded as well. It has a
        # separate retention window so 90-day detail views never require raw
        # high-frequency ProbeResult storage.
        try:
            from services.telemetry_rollups import compact_telemetry_rollups
            rollups_deleted = compact_telemetry_rollups(retention_days=rollup_retention_days)
            if rollups_deleted:
                db.session.commit()
            log.info("telemetry_rollup_cleanup: rows=%d retention_days=%d", rollups_deleted, rollup_retention_days)
        except Exception as exc:
            db.session.rollback()
            log.error("telemetry_rollup_cleanup failed: %s", exc)
        try:
            from services.ping_rollups import compact_ping_rollups
            ping_rollups_deleted = compact_ping_rollups(retention_days=ping_rollup_retention_days)
            if ping_rollups_deleted:
                db.session.commit()
            log.info("ping_rollup_cleanup: rows=%d retention_days=%d", ping_rollups_deleted, ping_rollup_retention_days)
        except Exception as exc:
            db.session.rollback()
            log.error("ping_rollup_cleanup failed: %s", exc)

        # ── ping_target_results: DROP PARTITION cleanup on the shorter PTR window.
        # Only runs when the table is actually partitioned; the DELETE fallback
        # below handles pre-migration / SQLite via ProbeResult only, so PTR relies
        # on partitioning (enabled by the maintenance job) for cheap cleanup.
        try:
            from services.probe_partition import drop_expired_partitions, is_partitioned
            if is_partitioned(engine, "ping_target_results"):
                ptr_dropped = drop_expired_partitions(
                    engine, retention_days=ptr_retention_days,
                    table_name="ping_target_results",
                )
                if ptr_dropped:
                    log.info(
                        "ptr_cleanup: method=drop_partition count=%d partitions=%s "
                        "retention_days=%d",
                        len(ptr_dropped), ptr_dropped, ptr_retention_days,
                    )
        except Exception as exc:
            log.error("ptr_cleanup: ping_target_results cleanup failed: %s", exc)

        use_partition = False
        if _is_mysql(engine):
            # Only use DROP PARTITION if the table is actually partitioned.
            # An unpartitioned probe_results (pre-migration) would return an
            # empty list from list_partitions() and silently skip all cleanup.
            partitions = list_partitions(engine)
            has_pmax = any(p["partition_name"] == "pmax" for p in partitions)
            use_partition = bool(partitions) and has_pmax

        if use_partition:
            # ── MySQL: DROP PARTITION（瞬时元数据操作，无行级锁）──────────────
            dropped = drop_expired_partitions(engine, retention_days=retention_days)
            elapsed_ms = round((_time.perf_counter() - t0) * 1000, 1)
            if dropped:
                log.info(
                    "probe_cleanup: method=drop_partition count=%d "
                    "partitions=%s elapsed_ms=%.1f retention_days=%d",
                    len(dropped), dropped, elapsed_ms, retention_days,
                )
            else:
                log.info(
                    "probe_cleanup: method=drop_partition count=0 "
                    "elapsed_ms=%.1f retention_days=%d",
                    elapsed_ms, retention_days,
                )
        else:
            # ── Fallback: batched DELETE（SQLite / non-partitioned MySQL / pre-migration）
            # Materialise IDs in chunks to bound each transaction's row-lock window
            # and avoid a single long-running statement on large tables.
            cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
            try:
                total_deleted = 0
                while True:
                    ids = [
                        row.id
                        for row in db.session.query(ProbeResult.id)
                        .filter(ProbeResult.created_at < cutoff)
                        .order_by(ProbeResult.id)
                        .limit(_CLEANUP_BATCH)
                        .all()
                    ]
                    if not ids:
                        break
                    batch = ProbeResult.query.filter(
                        ProbeResult.id.in_(ids)
                    ).delete(synchronize_session=False)
                    db.session.commit()
                    total_deleted += batch
                elapsed_ms = round((_time.perf_counter() - t0) * 1000, 1)
                log.info(
                    "probe_cleanup: method=delete rows=%d elapsed_ms=%.1f "
                    "retention_days=%d cutoff=%s",
                    total_deleted, elapsed_ms, retention_days, cutoff.date(),
                )
            except Exception as exc:
                db.session.rollback()
                log.error("probe_cleanup: DELETE fallback failed: %s", exc)


def _job_audit_log_cleanup(app):
    """每周日凌晨 3 点清理 90 天前的审计日志"""
    import os
    from extensions import db
    from models.models import AuditLog
    retention_days = int(os.environ.get("AUDIT_LOG_RETENTION_DAYS", 90))
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    with app.app_context():
        try:
            deleted = AuditLog.query.filter(AuditLog.created_at < cutoff).delete()
            db.session.commit()
            log.info(f"审计日志归档: 删除 {deleted} 条 {retention_days} 天前的记录")
        except Exception as e:
            db.session.rollback()
            log.error(f"审计日志归档失败: {e}")


def _job_agent_command_cleanup(app):
    """每天凌晨 4 点清理已过期或已完成的 AgentCommand 记录（保留 7 天）"""
    from extensions import db
    from models.models import AgentCommand
    retention_days = int(app.config.get("AGENT_COMMAND_RETENTION_DAYS", 7))
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    with app.app_context():
        try:
            deleted = (
                AgentCommand.query
                .filter(
                    AgentCommand.created_at < cutoff,
                    AgentCommand.status.in_(["executed", "pending"]),
                )
                .delete(synchronize_session=False)
            )
            db.session.commit()
            if deleted:
                log.info(
                    "agent_command_cleanup: 删除 %d 条 %d 天前的 agent_commands",
                    deleted, retention_days,
                )
        except Exception as e:
            db.session.rollback()
            log.error("agent_command_cleanup 失败: %s", e)


def _job_probe_partition_maintain(app):
    """每天凌晨 1:30 预创建 probe_results 未来 N 天分区。

    确保写入数据始终落入精确的日级分区而非 pmax 兜底分区，
    从而支持后续精确的 DROP PARTITION 清理操作。
    仅 MySQL 环境执行；SQLite / 非分区环境直接返回。
    """
    from extensions import db
    from services.probe_partition import (
        _is_mysql,
        ensure_future_partitions,
        initialize_table_partitioning,
        is_partitioned,
        list_partitions,
    )

    days_ahead = int(app.config.get("PROBE_RESULT_PARTITION_DAYS_AHEAD", 30))
    retention_days = int(app.config.get("PROBE_RESULT_RETENTION_DAYS", 30))
    ptr_retention_days = int(app.config.get("PING_TARGET_RESULT_RETENTION_DAYS", 7))
    with app.app_context():
        if not _is_mysql(db.engine):
            return

        # Enable partitioning on first run if probe_results is still a plain
        # table (older installs). This performs an online migration: drop the FK
        # to servers, switch to a composite (id, created_at) PK, and convert to
        # daily RANGE partitions. After this, retention cleanup can use the cheap
        # DROP PARTITION path instead of a batched DELETE.
        if not is_partitioned(db.engine):
            if initialize_table_partitioning(db.engine, "probe_results"):
                log.info(
                    "probe_partition_maintain: enabled partitioning for probe_results"
                )

        partitions = list_partitions(db.engine)
        has_pmax = any(p["partition_name"] == "pmax" for p in partitions)
        if not partitions or not has_pmax:
            log.warning(
                "probe_partition_maintain: partitioning is not enabled for "
                "probe_results; skipping maintenance"
            )
        else:
            created = ensure_future_partitions(
                db.engine, days_ahead=days_ahead, max_backfill_days=retention_days,
            )
            if created:
                log.info(
                    "probe_partition_maintain: created %d partition(s): %s",
                    len(created), created,
                )
            else:
                log.info("probe_partition_maintain: all partitions up to date")

        # ── ping_target_results: enable partitioning on first run, then keep
        # future daily partitions pre-created. Retention is the shorter PTR window.
        try:
            if not is_partitioned(db.engine, "ping_target_results"):
                if initialize_table_partitioning(db.engine, "ping_target_results"):
                    log.info(
                        "probe_partition_maintain: enabled partitioning for "
                        "ping_target_results"
                    )
            if is_partitioned(db.engine, "ping_target_results"):
                ptr_created = ensure_future_partitions(
                    db.engine, days_ahead=days_ahead,
                    max_backfill_days=ptr_retention_days,
                    table_name="ping_target_results",
                )
                if ptr_created:
                    log.info(
                        "probe_partition_maintain: ping_target_results created "
                        "%d partition(s): %s", len(ptr_created), ptr_created,
                    )
        except Exception as exc:
            log.error(
                "probe_partition_maintain: ping_target_results maintenance failed: %s",
                exc,
            )
