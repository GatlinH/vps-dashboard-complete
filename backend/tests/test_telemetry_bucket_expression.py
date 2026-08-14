"""Shared raw-telemetry bucket expression regression tests."""

from sqlalchemy import column
from sqlalchemy.dialects import mysql


def test_mysql_epoch_bucket_expression_has_shared_timestamp_contract():
    from services.telemetry_rollups import mysql_epoch_bucket_expression

    expr = mysql_epoch_bucket_expression(column("created_at"), bucket_seconds=300)
    compiled = str(expr.compile(dialect=mysql.dialect(), compile_kwargs={"literal_binds": True}))

    assert "floor(unix_timestamp(created_at) / 300) * 300" in compiled.lower()
    assert expr.name == "bucket_ts"


def test_mysql_epoch_bucket_expression_rejects_non_positive_bucket():
    from services.telemetry_rollups import mysql_epoch_bucket_expression

    try:
        mysql_epoch_bucket_expression(column("created_at"), bucket_seconds=0)
    except ValueError as exc:
        assert "bucket_seconds" in str(exc)
    else:
        raise AssertionError("non-positive bucket_seconds must be rejected")
