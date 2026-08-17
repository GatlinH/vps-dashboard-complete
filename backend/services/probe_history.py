"""Persistence and bounded history queries for PING target samples."""

from datetime import datetime, timedelta, timezone

from flask import current_app

from extensions import db


def _target_history_table_ready():
    """Ensure PING history storage once per process, never once per request.

    The table is normally created by schema_init. This fallback is retained for
    older installs, but repeated CREATE TABLE DDL under concurrent detail/agent
    requests can block InnoDB commits and must be avoided.
    """
    global _PTR_HISTORY_TABLE_READY
    if _PTR_HISTORY_TABLE_READY:
        return True
    try:
        is_mysql = db.engine.dialect.name in ("mysql", "pymysql", "mariadb")
        if is_mysql:
            db.session.execute(db.text("""
                CREATE TABLE IF NOT EXISTS ping_target_results (
                    id BIGINT AUTO_INCREMENT PRIMARY KEY,
                    server_id INT NOT NULL,
                    target_key VARCHAR(128) NOT NULL,
                    label VARCHAR(255) NOT NULL DEFAULT '',
                    host VARCHAR(255) NOT NULL DEFAULT '',
                    port INT NULL,
                    protocol VARCHAR(16) NOT NULL DEFAULT 'icmp',
                    latency_ms DOUBLE NULL,
                    success TINYINT(1) NOT NULL DEFAULT 0,
                    loss_pct DOUBLE NULL,
                    quality INT NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_ptr_server_created (server_id, created_at),
                    INDEX idx_ptr_server_target_created (server_id, target_key, created_at)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """))
            db.session.commit()
            _ensure_ping_target_partitioning()
        else:
            # SQLite (tests) / other dialects: portable DDL without engine/index
            # inline clauses, then create indexes separately.
            db.session.execute(db.text("""
                CREATE TABLE IF NOT EXISTS ping_target_results (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    server_id INTEGER NOT NULL,
                    target_key VARCHAR(128) NOT NULL,
                    label VARCHAR(255) NOT NULL DEFAULT '',
                    host VARCHAR(255) NOT NULL DEFAULT '',
                    port INTEGER NULL,
                    protocol VARCHAR(16) NOT NULL DEFAULT 'icmp',
                    latency_ms DOUBLE NULL,
                    success SMALLINT NOT NULL DEFAULT 0,
                    loss_pct DOUBLE NULL,
                    quality INTEGER NULL,
                    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """))
            db.session.execute(db.text(
                "CREATE INDEX IF NOT EXISTS idx_ptr_server_created "
                "ON ping_target_results (server_id, created_at)"))
            db.session.execute(db.text(
                "CREATE INDEX IF NOT EXISTS idx_ptr_server_target_created "
                "ON ping_target_results (server_id, target_key, created_at)"))
            db.session.commit()
        _PTR_HISTORY_TABLE_READY = True
        return True
    except Exception:
        db.session.rollback()
        return False


_PTR_PARTITION_CHECKED = False
_PTR_HISTORY_TABLE_READY = False


def _ensure_ping_target_partitioning():
    """Idempotently enable daily partitioning on ping_target_results (MySQL only).

    Per-second agent sampling makes this table grow fast; daily RANGE partitions
    let the retention job DROP PARTITION cheaply instead of scanning millions of
    rows. Runs at most once per process; the scheduler maintenance job keeps
    future partitions pre-created and drops expired ones thereafter. Failure here
    must never block writes — the table still works unpartitioned.
    """
    global _PTR_PARTITION_CHECKED
    if _PTR_PARTITION_CHECKED:
        return
    _PTR_PARTITION_CHECKED = True
    try:
        from services.probe_partition import initialize_table_partitioning, is_partitioned
        engine = db.engine
        if not is_partitioned(engine, "ping_target_results"):
            initialize_table_partitioning(engine, "ping_target_results")
    except Exception:
        pass


def _persist_ping_target_results(server_id, targets, created_at=None):
    if not targets or not _target_history_table_ready():
        return
    created_at = created_at or datetime.now(timezone.utc)
    try:
        for t in targets:
            stats = t.get("stats") or {}
            avg_ms = stats.get("avg_ms")
            success = avg_ms is not None
            db.session.execute(db.text("""
                INSERT INTO ping_target_results
                  (server_id, target_key, label, host, port, protocol, latency_ms, success, loss_pct, quality, created_at)
                VALUES
                  (:server_id, :target_key, :label, :host, :port, :protocol, :latency_ms, :success, :loss_pct, :quality, :created_at)
            """), {
                "server_id": server_id,
                "target_key": str(t.get("key") or t.get("host") or t.get("label") or "unknown")[:128],
                "label": str(t.get("label") or t.get("host") or "")[:255],
                "host": str(t.get("host") or "")[:255],
                "port": t.get("port"),
                "protocol": str(t.get("protocol") or "icmp")[:16],
                "latency_ms": float(avg_ms) if avg_ms is not None else None,
                "success": 1 if success else 0,
                "loss_pct": stats.get("loss_pct"),
                "quality": t.get("quality"),
                "created_at": created_at.replace(tzinfo=None) if hasattr(created_at, "replace") else created_at,
            })
            # Long-range charts read one aggregate per target/hour rather than
            # scanning raw per-second samples. It shares this transaction with
            # the raw insert so a successful sample is represented consistently.
            try:
                from services.ping_rollups import record_ping_rollup
                record_ping_rollup(server_id, t, created_at)
            except Exception:
                current_app.logger.exception("ping rollup write failed", extra={"server_id": server_id})
        db.session.commit()
    except Exception:
        db.session.rollback()


def _fetch_ping_target_history(server_id, hours=12, limit=2000, target_keys=None):
    if not _target_history_table_ready():
        return []
    hours = max(1, min(int(hours or 12), 168))
    limit = max(1, min(int(limit or 2000), 10000))
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    since_naive = since.replace(tzinfo=None)
    # Filter the shared raw table before bucket/limit. Otherwise dense peer rows
    # can consume the aggregate budget and hide a configured external target.
    keys = sorted({str(key) for key in (target_keys or []) if str(key)})
    if target_keys is not None and not keys:
        return []
    key_clause = ""
    params = {"server_id": server_id, "since": since_naive}
    if keys:
        placeholders = []
        for index, key in enumerate(keys):
            name = f"target_key_{index}"
            placeholders.append(f":{name}")
            params[name] = key
        key_clause = f" AND target_key IN ({', '.join(placeholders)})"
    # The agent writes second-level samples. Returning raw rows with a global
    # LIMIT makes a busy target consume the response and leaves later targets
    # blank; it also returns only a short tail of a 12h axis. Aggregate by a
    # dynamic time bucket instead: preserve the whole requested time span while
    # keeping total points near the caller's chart-safe limit.
    target_count = db.session.execute(db.text("""
        SELECT COUNT(DISTINCT target_key)
        FROM ping_target_results
        WHERE server_id = :server_id AND created_at >= :since""" + key_clause + """
    """), params).scalar() or 1
    points_per_target = max(1, limit // max(1, int(target_count)))
    bucket_seconds = max(60, int((hours * 3600 + points_per_target - 1) // points_per_target))
    params.update({"bucket_seconds": bucket_seconds, "limit": limit})
    rows = db.session.execute(db.text("""
        SELECT
          :server_id AS server_id,
          target_key,
          MAX(label) AS label,
          MAX(host) AS host,
          MAX(port) AS port,
          MAX(protocol) AS protocol,
          AVG(latency_ms) AS latency_ms,
          MAX(success) AS success,
          AVG(loss_pct) AS loss_pct,
          MAX(quality) AS quality,
          MAX(created_at) AS created_at
        FROM ping_target_results
        WHERE server_id = :server_id AND created_at >= :since""" + key_clause + """
        GROUP BY target_key, FLOOR(UNIX_TIMESTAMP(created_at) / :bucket_seconds)
        ORDER BY created_at ASC
        LIMIT :limit
    """), params).mappings().all()
    return [dict(r) for r in rows]
