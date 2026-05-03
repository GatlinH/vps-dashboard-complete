"""
tests/test_p3_3_probe_partition.py

P3-3: ProbeResult 分区与历史清理优化

测试覆盖：
  A. 分区工具单元测试（probe_partition.py）
     A-1  非 MySQL 环境：list/ensure/drop 全部安全返回空
     A-2  _partition_name 命名规则正确
     A-3  _parse_partition_date 解析正确，非日期名返回 None
     A-4  MySQL 模拟：list_partitions 通过 INFORMATION_SCHEMA 查询
     A-5  MySQL 模拟：ensure_future_partitions 幂等，调用 REORGANIZE PARTITION
     A-5b ensure_future_partitions 从最新已有分区后补齐 gap（错过维护日的情况）
     A-6  MySQL 模拟：drop_expired_partitions 调用 DROP PARTITION
     A-7  MySQL 模拟：drop_expired_partitions dry_run 不执行 DDL
     A-8  MySQL 模拟：drop_expired_partitions 不删除 pmax 和非日期分区
     A-9  drop_expired_partitions 保留边界：恰好在保留期内的分区不删除

  B. 调度任务测试（scheduler.py）
     B-1  _job_cleanup 在 SQLite 使用 DELETE 回退路径
     B-2  _job_cleanup 幂等（重复执行不报错）
     B-3  _job_cleanup 删除超期数据，保留期内数据不删除（保留边界）
     B-4  _job_cleanup 在已分区 MySQL 调用 drop_expired_partitions
     B-4b _job_cleanup 在未分区 MySQL（无 pmax）回退到 DELETE
     B-5  _job_probe_partition_maintain 在非 MySQL 直接返回
     B-6  _job_probe_partition_maintain 在 MySQL mock 调用 ensure_future_partitions

  C. 兼容性回归测试
     C-1  ProbeResult 写入语义不变
     C-2  ProbeResult 查询（过滤、排序）语义不变
     C-3  ProbeResult to_dict 结构完整
     C-4  delete_server 显式清理 probe_results

运行方式：
    cd backend && python -m pytest tests/test_p3_3_probe_partition.py -v
"""
import logging
from datetime import date, datetime, timedelta, timezone
from unittest.mock import MagicMock, call, patch

import pytest


# ═══════════════════════════════════════════════════════════════════════════════
# A. probe_partition 单元测试
# ═══════════════════════════════════════════════════════════════════════════════

class TestPartitionHelpers:
    """A-2 / A-3: 命名与解析助手函数。"""

    def test_partition_name_format(self):
        from services.probe_partition import _partition_name
        d = date(2026, 5, 3)
        assert _partition_name(d) == "p20260503"

    def test_partition_name_padding(self):
        from services.probe_partition import _partition_name
        d = date(2026, 1, 9)
        assert _partition_name(d) == "p20260109"

    def test_parse_partition_date_valid(self):
        from services.probe_partition import _parse_partition_date
        assert _parse_partition_date("p20260503") == date(2026, 5, 3)

    def test_parse_partition_date_pmax(self):
        from services.probe_partition import _parse_partition_date
        assert _parse_partition_date("pmax") is None

    def test_parse_partition_date_yearly_legacy(self):
        """旧式年份分区（如 p2026）不应被解析为日期。"""
        from services.probe_partition import _parse_partition_date
        assert _parse_partition_date("p2026") is None

    def test_parse_partition_date_invalid_string(self):
        from services.probe_partition import _parse_partition_date
        assert _parse_partition_date("invalid") is None

    def test_parse_partition_date_empty(self):
        from services.probe_partition import _parse_partition_date
        assert _parse_partition_date("") is None

    def test_parse_partition_date_bad_date(self):
        """格式符合但日期非法（如 99 月）返回 None。"""
        from services.probe_partition import _parse_partition_date
        assert _parse_partition_date("p20261399") is None


class TestNonMySQLSafety:
    """A-1: 非 MySQL 环境所有操作安全返回空值。"""

    def _sqlite_engine(self):
        mock_engine = MagicMock()
        mock_engine.dialect.name = "sqlite"
        return mock_engine

    def test_list_partitions_sqlite_returns_empty(self):
        from services.probe_partition import list_partitions
        assert list_partitions(self._sqlite_engine()) == []

    def test_ensure_future_partitions_sqlite_returns_empty(self):
        from services.probe_partition import ensure_future_partitions
        result = ensure_future_partitions(
            self._sqlite_engine(), days_ahead=7, today=date(2026, 5, 3)
        )
        assert result == []

    def test_drop_expired_partitions_sqlite_returns_empty(self):
        from services.probe_partition import drop_expired_partitions
        result = drop_expired_partitions(
            self._sqlite_engine(), retention_days=30, today=date(2026, 5, 3)
        )
        assert result == []

    def test_drop_expired_partitions_dry_run_sqlite_returns_empty(self):
        from services.probe_partition import drop_expired_partitions
        result = drop_expired_partitions(
            self._sqlite_engine(), retention_days=30, dry_run=True,
            today=date(2026, 5, 3),
        )
        assert result == []


def _make_mysql_engine(partitions: list[dict]):
    """Build a mock MySQL engine that returns the given partition list."""
    mock_engine = MagicMock()
    mock_engine.dialect.name = "mysql"

    # list_partitions uses engine.connect() as context manager
    mock_conn = MagicMock()
    mock_conn.__enter__ = MagicMock(return_value=mock_conn)
    mock_conn.__exit__ = MagicMock(return_value=False)

    # Build fetchall rows from the partition dicts
    rows = [
        (p["partition_name"], p["partition_description"], p.get("table_rows", 0))
        for p in partitions
    ]
    mock_conn.execute.return_value.fetchall.return_value = rows
    mock_engine.connect.return_value = mock_conn
    return mock_engine


class TestMySQLListPartitions:
    """A-4: list_partitions 通过 INFORMATION_SCHEMA 查询。"""

    def test_list_partitions_returns_partition_dicts(self):
        from services.probe_partition import list_partitions
        partitions = [
            {"partition_name": "p20260501", "partition_description": "'2026-05-02'", "table_rows": 1000},
            {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
        ]
        engine = _make_mysql_engine(partitions)
        result = list_partitions(engine)
        assert len(result) == 2
        assert result[0]["partition_name"] == "p20260501"
        assert result[1]["partition_name"] == "pmax"

    def test_list_partitions_error_returns_empty(self):
        """DB error must be caught and return empty list, not raise."""
        from services.probe_partition import list_partitions
        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"
        mock_engine.connect.side_effect = Exception("connection refused")
        result = list_partitions(mock_engine)
        assert result == []


class TestMySQLEnsureFuturePartitions:
    """A-5: ensure_future_partitions 幂等，调用 REORGANIZE PARTITION。"""

    def _make_engine_with_existing(self, existing_names: list[str]):
        """Engine where list_partitions returns the given names + pmax."""
        partitions = [
            {"partition_name": n, "partition_description": "", "table_rows": 0}
            for n in existing_names
        ] + [{"partition_name": "pmax", "partition_description": "MAXVALUE", "table_rows": 0}]
        return _make_mysql_engine(partitions)

    def test_creates_missing_partitions(self):
        """Should create partitions for days not yet present."""
        from services.probe_partition import ensure_future_partitions

        today = date(2026, 5, 3)
        # Only p20260503 exists; p20260504 and p20260505 are missing
        engine = self._make_engine_with_existing(["p20260503"])

        with patch("services.probe_partition.list_partitions") as mock_list, \
             patch.object(engine, "connect") as mock_connect:

            call_count = 0
            def _side_effect(*_a, **_kw):
                nonlocal call_count
                call_count += 1
                if call_count == 1:
                    return [
                        {"partition_name": "p20260503", "partition_description": "", "table_rows": 0},
                        {"partition_name": "pmax",      "partition_description": "MAXVALUE", "table_rows": 0},
                    ]
                return []

            mock_list.side_effect = _side_effect

            mock_conn = MagicMock()
            mock_conn.__enter__ = MagicMock(return_value=mock_conn)
            mock_conn.__exit__ = MagicMock(return_value=False)
            mock_connect.return_value = mock_conn

            created = ensure_future_partitions(engine, days_ahead=2, today=today)

        # p20260504 and p20260505 should be created
        assert "p20260504" in created
        assert "p20260505" in created
        assert "p20260503" not in created  # already existed

    def test_no_creation_when_all_exist(self):
        """Should not call DDL when all partitions already exist."""
        from services.probe_partition import ensure_future_partitions

        today = date(2026, 5, 3)
        existing = ["p20260503", "p20260504", "p20260505"]

        with patch("services.probe_partition.list_partitions") as mock_list, \
             patch("services.probe_partition._is_mysql", return_value=True):

            mock_list.return_value = [
                {"partition_name": n, "partition_description": "", "table_rows": 0}
                for n in existing + ["pmax"]
            ]

            mock_engine = MagicMock()
            mock_engine.dialect.name = "mysql"

            created = ensure_future_partitions(mock_engine, days_ahead=2, today=today)

        assert created == []
        mock_engine.connect.assert_not_called()

    def test_gap_fill_creates_intermediate_partitions(self):
        """A-5b: If the job missed days, partitions for missed days should be created.

        Scenario: last daily partition is p20260501 (3 days ago).
        today=2026-05-04, days_ahead=2.
        Expected: p20260502, p20260503, p20260504, p20260505, p20260506 are all created.
        """
        from services.probe_partition import ensure_future_partitions

        today = date(2026, 5, 4)
        # Only p20260501 existed; gap covers p20260502 and p20260503 before today
        existing_names = {"p20260501", "pmax"}

        with patch("services.probe_partition.list_partitions") as mock_list, \
             patch("services.probe_partition._is_mysql", return_value=True):

            mock_list.return_value = [
                {"partition_name": "p20260501", "partition_description": "'2026-05-02'", "table_rows": 0},
                {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
            ]

            mock_engine = MagicMock()
            mock_engine.dialect.name = "mysql"
            mock_conn = MagicMock()
            mock_conn.__enter__ = MagicMock(return_value=mock_conn)
            mock_conn.__exit__ = MagicMock(return_value=False)
            mock_engine.connect.return_value = mock_conn

            created = ensure_future_partitions(mock_engine, days_ahead=2, today=today)

        # p20260502 (gap), p20260503 (gap), p20260504 (today), p20260505, p20260506
        for expected in ["p20260502", "p20260503", "p20260504", "p20260505", "p20260506"]:
            assert expected in created, f"Expected {expected} to be created (gap-fill)"
        assert "p20260501" not in created  # already existed


class TestMySQLDropExpiredPartitions:
    """A-6 / A-7 / A-8 / A-9: drop_expired_partitions 行为验证。"""

    def test_drops_expired_partition(self):
        """Partitions older than retention_days should be dropped."""
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        # p20260401 is 32 days ago (> 30 days retention)
        partitions = [
            {"partition_name": "p20260401", "partition_description": "'2026-04-02'", "table_rows": 5000},
            {"partition_name": "p20260502", "partition_description": "'2026-05-03'", "table_rows": 100},
            {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
        ]

        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_engine.connect.return_value = mock_conn

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            dropped = drop_expired_partitions(mock_engine, retention_days=30, today=today)

        assert dropped == ["p20260401"]
        # Verify DROP PARTITION DDL was executed
        executed_sqls = [str(c.args[0]) for c in mock_conn.execute.call_args_list]
        assert any("DROP PARTITION" in sql and "p20260401" in sql for sql in executed_sqls)

    def test_dry_run_does_not_execute_ddl(self):
        """dry_run=True returns list but does NOT execute DROP PARTITION."""
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        partitions = [
            {"partition_name": "p20260401", "partition_description": "'2026-04-02'", "table_rows": 100},
            {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
        ]

        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            result = drop_expired_partitions(
                mock_engine, retention_days=30, dry_run=True, today=today
            )

        assert result == ["p20260401"]
        mock_engine.connect.assert_not_called()  # no DDL executed

    def test_pmax_never_dropped(self):
        """pmax partition must never appear in the drop list."""
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        partitions = [
            {"partition_name": "pmax", "partition_description": "MAXVALUE", "table_rows": 0},
        ]
        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            result = drop_expired_partitions(mock_engine, retention_days=0, today=today)

        assert result == []

    def test_yearly_legacy_partition_not_dropped(self):
        """Legacy yearly partition names (p2026) must be skipped."""
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        partitions = [
            {"partition_name": "p2024", "partition_description": "2025", "table_rows": 0},
            {"partition_name": "pmax",  "partition_description": "MAXVALUE", "table_rows": 0},
        ]
        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            result = drop_expired_partitions(mock_engine, retention_days=0, today=today)

        assert result == []

    def test_retention_boundary_exact_cutoff_not_dropped(self):
        """A partition exactly at today - retention_days should NOT be dropped.

        cutoff = today - 30.  A partition dated cutoff is NOT older than cutoff
        (d < cutoff is False when d == cutoff).
        """
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        retention_days = 30
        cutoff = today - timedelta(days=retention_days)  # 2026-04-03
        boundary_name = f"p{cutoff.strftime('%Y%m%d')}"  # p20260403

        partitions = [
            {"partition_name": boundary_name, "partition_description": "", "table_rows": 10},
            {"partition_name": "pmax",        "partition_description": "MAXVALUE", "table_rows": 0},
        ]
        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            result = drop_expired_partitions(mock_engine, retention_days=retention_days, today=today)

        assert result == [], (
            f"Partition {boundary_name} (date={cutoff}) should NOT be dropped "
            f"when cutoff={cutoff} (retention={retention_days} days)"
        )

    def test_retention_boundary_one_day_before_cutoff_is_dropped(self):
        """A partition one day before cutoff SHOULD be dropped."""
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        retention_days = 30
        cutoff = today - timedelta(days=retention_days)          # 2026-04-03
        expired_date = cutoff - timedelta(days=1)                # 2026-04-02
        expired_name = f"p{expired_date.strftime('%Y%m%d')}"    # p20260402

        partitions = [
            {"partition_name": expired_name, "partition_description": "", "table_rows": 10},
            {"partition_name": "pmax",       "partition_description": "MAXVALUE", "table_rows": 0},
        ]
        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"
        mock_conn = MagicMock()
        mock_conn.__enter__ = MagicMock(return_value=mock_conn)
        mock_conn.__exit__ = MagicMock(return_value=False)
        mock_engine.connect.return_value = mock_conn

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            result = drop_expired_partitions(mock_engine, retention_days=retention_days, today=today)

        assert result == [expired_name]

    def test_no_expired_partitions_returns_empty(self):
        """When no partitions are expired, return empty list without error."""
        from services.probe_partition import drop_expired_partitions

        today = date(2026, 5, 3)
        partitions = [
            {"partition_name": "p20260502", "partition_description": "'2026-05-03'", "table_rows": 50},
            {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
        ]
        mock_engine = MagicMock()
        mock_engine.dialect.name = "mysql"

        with patch("services.probe_partition.list_partitions", return_value=partitions):
            result = drop_expired_partitions(mock_engine, retention_days=30, today=today)

        assert result == []


# ═══════════════════════════════════════════════════════════════════════════════
# B. 调度任务测试
# ═══════════════════════════════════════════════════════════════════════════════

class TestJobCleanupSQLite:
    """B-1 / B-2 / B-3: _job_cleanup on SQLite (DELETE fallback path)."""

    def test_cleanup_uses_delete_on_sqlite(self, app):
        """_job_cleanup must fall back to DELETE on non-MySQL engines."""
        from extensions import db
        from models.models import Server, ProbeResult
        from services.scheduler import _job_cleanup

        with app.app_context():
            s = Server(
                name="cleanup-test-srv", ip="10.50.0.1",
                group_name="test", cpu_cores=1, ram_gb=1.0,
                disk_gb=10, price=5.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

            old_ts = datetime.now(timezone.utc) - timedelta(days=35)
            recent_ts = datetime.now(timezone.utc) - timedelta(days=1)

            old_pr = ProbeResult(server_id=sid, status="online", created_at=old_ts)
            new_pr = ProbeResult(server_id=sid, status="online", created_at=recent_ts)
            db.session.add_all([old_pr, new_pr])
            db.session.commit()

        app.config["PROBE_RESULT_RETENTION_DAYS"] = 30
        _job_cleanup(app)

        with app.app_context():
            remaining = ProbeResult.query.all()
            assert len(remaining) == 1
            assert remaining[0].created_at.replace(tzinfo=timezone.utc) >= \
                   datetime.now(timezone.utc) - timedelta(days=2)

    def test_cleanup_idempotent(self, app):
        """Running _job_cleanup twice must not raise."""
        from services.scheduler import _job_cleanup
        app.config["PROBE_RESULT_RETENTION_DAYS"] = 30
        _job_cleanup(app)
        _job_cleanup(app)  # second call must succeed without exception

    def test_cleanup_retention_boundary(self, app):
        """Data exactly at today - retention_days should be deleted; newer data kept."""
        from extensions import db
        from models.models import Server, ProbeResult
        from services.scheduler import _job_cleanup

        with app.app_context():
            s = Server(
                name="boundary-srv", ip="10.50.0.2",
                group_name="test", cpu_cores=1, ram_gb=1.0,
                disk_gb=10, price=5.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

            retention_days = 30
            cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)

            # Record created 1 second before the cutoff — older than cutoff, so it IS deleted
            boundary_pr = ProbeResult(
                server_id=sid, status="online",
                created_at=cutoff - timedelta(seconds=1),  # 1s before cutoff → deleted
            )
            # Recent record: definitely within retention window, must be kept
            recent_pr = ProbeResult(
                server_id=sid, status="online",
                created_at=cutoff + timedelta(hours=1),
            )
            db.session.add_all([boundary_pr, recent_pr])
            db.session.commit()
            boundary_id = boundary_pr.id
            recent_id = recent_pr.id

        app.config["PROBE_RESULT_RETENTION_DAYS"] = retention_days
        _job_cleanup(app)

        with app.app_context():
            assert ProbeResult.query.get(boundary_id) is None, (
                "Record 1s before cutoff must be deleted"
            )
            assert ProbeResult.query.get(recent_id) is not None, (
                "Recent record must be kept"
            )


class TestJobCleanupMySQLPath:
    """B-4 / B-4b: _job_cleanup MySQL dispatch logic."""

    def test_cleanup_calls_drop_partitions_on_partitioned_mysql(self, app):
        """B-4: On partitioned MySQL (has pmax), must use drop_expired_partitions."""
        from services.scheduler import _job_cleanup

        app.config["PROBE_RESULT_RETENTION_DAYS"] = 30

        partitions_with_pmax = [
            {"partition_name": "p20260401", "partition_description": "'2026-04-02'", "table_rows": 1000},
            {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
        ]

        with patch("services.probe_partition._is_mysql", return_value=True), \
             patch("services.probe_partition.list_partitions", return_value=partitions_with_pmax), \
             patch("services.probe_partition.drop_expired_partitions", return_value=["p20260401"]) \
             as mock_drop:
            _job_cleanup(app)

        mock_drop.assert_called_once()

    def test_cleanup_falls_back_to_delete_on_unpartitioned_mysql(self, app):
        """B-4b: MySQL table with no partitions (pre-migration) must fall back to DELETE."""
        from extensions import db
        from models.models import Server, ProbeResult
        from services.scheduler import _job_cleanup

        with app.app_context():
            s = Server(
                name="unpart-srv", ip="10.70.0.1",
                group_name="test", cpu_cores=1, ram_gb=1.0,
                disk_gb=10, price=5.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

            old_ts = datetime.now(timezone.utc) - timedelta(days=35)
            db.session.add(ProbeResult(server_id=sid, status="online", created_at=old_ts))
            db.session.commit()

        app.config["PROBE_RESULT_RETENTION_DAYS"] = 30

        # MySQL engine but list_partitions returns empty (unpartitioned table)
        with patch("services.probe_partition._is_mysql", return_value=True), \
             patch("services.probe_partition.list_partitions", return_value=[]), \
             patch("services.probe_partition.drop_expired_partitions") as mock_drop:
            _job_cleanup(app)

        # DROP PARTITION should NOT be called on unpartitioned tables
        mock_drop.assert_not_called()

        # The old row should have been removed via DELETE fallback
        with app.app_context():
            remaining = ProbeResult.query.all()
            assert len(remaining) == 0


class TestJobProbePartitionMaintain:
    """B-5 / B-6: _job_probe_partition_maintain."""

    def test_maintain_noop_on_non_mysql(self, app):
        """Must return immediately on non-MySQL without calling ensure_future_partitions."""
        from services.scheduler import _job_probe_partition_maintain

        with patch("services.probe_partition._is_mysql", return_value=False), \
             patch("services.probe_partition.ensure_future_partitions") as mock_ensure:
            _job_probe_partition_maintain(app)

        mock_ensure.assert_not_called()

    def test_maintain_calls_ensure_on_mysql(self, app):
        """Must call ensure_future_partitions with configured days_ahead on MySQL."""
        from services.scheduler import _job_probe_partition_maintain

        app.config["PROBE_RESULT_PARTITION_DAYS_AHEAD"] = 7

        partitions_with_pmax = [
            {"partition_name": "p20260502", "partition_description": "'2026-05-03'", "table_rows": 0},
            {"partition_name": "pmax",      "partition_description": "MAXVALUE",     "table_rows": 0},
        ]

        with patch("services.probe_partition._is_mysql", return_value=True), \
             patch("services.probe_partition.list_partitions", return_value=partitions_with_pmax), \
             patch("services.probe_partition.ensure_future_partitions", return_value=["p20260510"]) \
             as mock_ensure:
            _job_probe_partition_maintain(app)

        mock_ensure.assert_called_once()


# ═══════════════════════════════════════════════════════════════════════════════
# C. ProbeResult 兼容性回归测试
# ═══════════════════════════════════════════════════════════════════════════════

class TestProbeResultCompatibility:
    """C-1 / C-2 / C-3: 现有写入/查询/序列化语义不变。"""

    def test_probe_result_write(self, app):
        """C-1: 写入 ProbeResult 路径不受影响。"""
        from extensions import db
        from models.models import Server, ProbeResult

        with app.app_context():
            s = Server(
                name="compat-srv", ip="10.60.0.1",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

            pr = ProbeResult(
                server_id=sid,
                cpu_use=42.0, ram_use=55.0, disk_use=30.0,
                net_up=2.0, net_down=3.0, latency_ms=12.5,
                status="online",
                created_at=datetime.now(timezone.utc),
            )
            db.session.add(pr)
            db.session.commit()
            pr_id = pr.id

        with app.app_context():
            loaded = ProbeResult.query.get(pr_id)
            assert loaded is not None
            assert loaded.cpu_use == 42.0
            assert loaded.status == "online"

    def test_probe_result_filter_by_server_and_time(self, app):
        """C-2: 按 server_id 和时间范围查询返回正确结果。"""
        from extensions import db
        from models.models import Server, ProbeResult

        with app.app_context():
            s = Server(
                name="query-srv", ip="10.60.0.2",
                group_name="test", cpu_cores=1, ram_gb=1.0,
                disk_gb=10, price=5.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

            now = datetime.now(timezone.utc)
            for i in range(5):
                pr = ProbeResult(
                    server_id=sid, status="online",
                    created_at=now - timedelta(hours=i),
                )
                db.session.add(pr)
            db.session.commit()

            cutoff = now - timedelta(hours=3)
            results = (
                ProbeResult.query
                .filter(
                    ProbeResult.server_id == sid,
                    ProbeResult.created_at >= cutoff,
                )
                .order_by(ProbeResult.created_at.desc())
                .all()
            )
            # hours 0, 1, 2, 3 are >= cutoff
            assert len(results) == 4

    def test_probe_result_to_dict_structure(self, app):
        """C-3: to_dict 返回预期字段集合。"""
        from extensions import db
        from models.models import Server, ProbeResult

        with app.app_context():
            s = Server(
                name="dict-srv", ip="10.60.0.3",
                group_name="test", cpu_cores=1, ram_gb=1.0,
                disk_gb=10, price=5.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()

            pr = ProbeResult(
                server_id=s.id,
                cpu_use=10.0, ram_use=20.0, disk_use=30.0,
                net_up=1.0, net_down=2.0, latency_ms=5.0,
                status="online",
                created_at=datetime.now(timezone.utc),
            )
            db.session.add(pr)
            db.session.commit()

            d = pr.to_dict()

        expected_keys = {
            "id", "server_id", "cpu_use", "ram_use", "disk_use",
            "net_up", "net_down", "latency_ms", "status", "created_at",
        }
        assert expected_keys == set(d.keys())
        assert isinstance(d["created_at"], str)
        assert d["status"] == "online"

    def test_delete_server_cleans_probe_results(self, app, auth_headers):
        """C-4: Deleting a server via API must also delete its ProbeResult rows.

        This verifies the explicit ProbeResult cleanup in delete_server,
        which replaces the removed MySQL FK CASCADE.
        """
        from extensions import db
        from models.models import Server, ProbeResult

        with app.app_context():
            s = Server(
                name="del-cascade-srv", ip="10.60.0.9",
                group_name="test", cpu_cores=1, ram_gb=1.0,
                disk_gb=10, price=5.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

            for i in range(3):
                db.session.add(ProbeResult(
                    server_id=sid, status="online",
                    created_at=datetime.now(timezone.utc) - timedelta(hours=i),
                ))
            db.session.commit()

            # Confirm rows exist before delete
            assert ProbeResult.query.filter_by(server_id=sid).count() == 3

        with app.test_client() as client:
            resp = client.delete(f"/api/v1/servers/{sid}", headers=auth_headers)
        assert resp.status_code == 200

        with app.app_context():
            remaining = ProbeResult.query.filter_by(server_id=sid).all()
            assert remaining == [], (
                "ProbeResult rows for deleted server must be removed by delete_server"
            )
