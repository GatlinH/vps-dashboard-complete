#!/usr/bin/env python3
"""Idempotently rebuild hourly rollups from retained raw rows.

Safe to rerun: each affected bucket is replaced with a fresh GROUP BY aggregate,
not incremented. It does not delete raw telemetry or historical rollup buckets
outside the retained raw range.
"""
from app import create_app
from extensions import db


def main() -> None:
    app = create_app()
    with app.app_context():
        if db.engine.dialect.name not in ('mysql', 'pymysql', 'mariadb'):
            raise SystemExit('backfill_hourly_rollups requires MySQL-compatible production storage')
        # UTC epoch-hour groups. ON DUPLICATE KEY replaces the aggregate, so
        # reruns cannot double-count samples.
        telemetry = db.session.execute(db.text('''
            INSERT INTO telemetry_rollups
              (server_id, resolution_minutes, bucket_start, sample_count, cpu_sum, ram_sum, disk_sum, net_up_sum, net_down_sum, created_at, updated_at)
            SELECT server_id, 60,
              FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) / 3600) * 3600),
              COUNT(*), COALESCE(SUM(cpu_use),0), COALESCE(SUM(ram_use),0), COALESCE(SUM(disk_use),0),
              COALESCE(SUM(net_up),0), COALESCE(SUM(net_down),0), UTC_TIMESTAMP(), UTC_TIMESTAMP()
            FROM probe_results
            GROUP BY server_id, FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) / 3600) * 3600)
            ON DUPLICATE KEY UPDATE
              sample_count=VALUES(sample_count), cpu_sum=VALUES(cpu_sum), ram_sum=VALUES(ram_sum),
              disk_sum=VALUES(disk_sum), net_up_sum=VALUES(net_up_sum), net_down_sum=VALUES(net_down_sum),
              updated_at=UTC_TIMESTAMP()
        ''')).rowcount
        ping = db.session.execute(db.text('''
            INSERT INTO ping_target_rollups
              (server_id, target_key, label, protocol, bucket_start, sample_count, success_count, latency_sum, loss_sum, created_at, updated_at)
            SELECT server_id, target_key, MAX(label), MAX(protocol),
              FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) / 3600) * 3600),
              COUNT(*), SUM(CASE WHEN latency_ms IS NULL THEN 0 ELSE 1 END),
              COALESCE(SUM(latency_ms),0), COALESCE(SUM(loss_pct),0), UTC_TIMESTAMP(), UTC_TIMESTAMP()
            FROM ping_target_results
            GROUP BY server_id, target_key, FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(created_at) / 3600) * 3600)
            ON DUPLICATE KEY UPDATE
              label=VALUES(label), protocol=VALUES(protocol), sample_count=VALUES(sample_count),
              success_count=VALUES(success_count), latency_sum=VALUES(latency_sum), loss_sum=VALUES(loss_sum),
              updated_at=UTC_TIMESTAMP()
        ''')).rowcount
        db.session.commit()
        print(f'rollup_backfill telemetry_buckets={telemetry} ping_buckets={ping}')


if __name__ == '__main__':
    main()
