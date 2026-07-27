"""P3: probe_results online partition migration must drop the FK first.

MySQL RANGE partitioning is incompatible with foreign keys. probe_results
ships with probe_results_ibfk_1 → servers, so initialize_table_partitioning
must drop any FK constraint before switching the PK and converting to
partitions. These tests assert that ordering with a mocked MySQL engine and
confirm non-MySQL stays a safe no-op.
"""
from datetime import date
from unittest.mock import MagicMock, patch


def _mysql_engine():
    engine = MagicMock()
    engine.dialect.name = "mysql"
    return engine


def test_initialize_drops_foreign_keys_before_partitioning():
    from services.probe_partition import initialize_table_partitioning

    engine = _mysql_engine()
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=False)
    engine.connect.return_value = conn

    # information_schema FK lookup returns one constraint; other execs return
    # an empty result set.
    def _execute(stmt, params=None):
        sql = str(stmt)
        result = MagicMock()
        if "information_schema.table_constraints" in sql:
            result.fetchall.return_value = [("probe_results_ibfk_1",)]
        else:
            result.fetchall.return_value = []
        return result

    conn.execute.side_effect = _execute

    with patch("services.probe_partition.is_partitioned", return_value=False):
        assert initialize_table_partitioning(engine, "probe_results", today=date(2026, 7, 27)) is True

    executed = [str(c.args[0]) for c in conn.execute.call_args_list]
    drop_fk_idx = next(i for i, s in enumerate(executed) if "DROP FOREIGN KEY probe_results_ibfk_1" in s)
    pk_idx = next(i for i, s in enumerate(executed) if "DROP PRIMARY KEY" in s)
    part_idx = next(i for i, s in enumerate(executed) if "PARTITION BY RANGE COLUMNS" in s)
    # FK must be dropped before the PK swap and before partitioning.
    assert drop_fk_idx < pk_idx < part_idx


def test_initialize_is_noop_on_non_mysql():
    from services.probe_partition import initialize_table_partitioning

    engine = MagicMock()
    engine.dialect.name = "sqlite"
    assert initialize_table_partitioning(engine, "probe_results") is False
    engine.connect.assert_not_called()
