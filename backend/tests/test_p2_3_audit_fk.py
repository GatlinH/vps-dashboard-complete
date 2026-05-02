"""
P2-3  AuditLog.user_id FK ondelete="SET NULL" 行为测试

覆盖项：
  P2-3-A  删除用户后审计日志条数不变（日志保留）
  P2-3-B  删除用户后对应 audit_log.user_id 自动置 NULL
  P2-3-C  to_dict() / 序列化在 user_id=NULL 时正常工作
  P2-3-D  按 username 过滤的查询在存在 NULL user_id 时不报错
  P2-3-E  模型定义确认：FK 包含 ondelete="SET NULL"，列可空
  P2-3-F  FK 元数据确认：SQLAlchemy 反射到正确的 ondelete 规则
  P2-3-G  非删除场景：写日志、分页、排序不受影响
"""

import sqlite3

import pytest
from sqlalchemy import event, inspect, text
from sqlalchemy.engine import Engine

from extensions import db as _db
from models.audit_log import AuditLog
from models.models import User
from werkzeug.security import generate_password_hash


# ── SQLite FK enforcement ─────────────────────────────────────────────────────
# SQLite disables FK constraints by default.  Enable them so that
# ON DELETE SET NULL is exercised in the in-memory test DB.

def _enable_sqlite_fk(dbapi_connection, _record):
    if isinstance(dbapi_connection, sqlite3.Connection):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


# Guard against duplicate registration when the module is reloaded in long
# test sessions: SQLAlchemy's listen() raises if the same (target, identifier,
# fn) triple is added twice with propagate=True.
if not event.contains(Engine, "connect", _enable_sqlite_fk):
    event.listen(Engine, "connect", _enable_sqlite_fk)


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_user(username: str) -> User:
    u = User(
        username=username,
        password_hash=generate_password_hash("Password@123456"),
        role="admin",
    )
    _db.session.add(u)
    _db.session.flush()   # obtain id without committing
    return u


def _make_audit_log(user: User | None, action: str = "CREATE") -> AuditLog:
    log = AuditLog(
        user_id=user.id if user else None,
        username=user.username if user else "anonymous",
        action=action,
        resource_type="Server",
        resource_id="42",
        method="POST",
        endpoint="/api/v1/servers",
        status_code=201,
        success=True,
    )
    _db.session.add(log)
    _db.session.flush()
    return log


# ── P2-3-A  Deleting a user does NOT delete their audit logs ──────────────────

def test_delete_user_keeps_audit_logs(app):
    """Audit rows must survive user deletion."""
    with app.app_context():
        user = _make_user("p23_user_a")
        log1 = _make_audit_log(user)
        log2 = _make_audit_log(user, action="DELETE")
        _db.session.commit()

        log1_id = log1.id
        log2_id = log2.id

        _db.session.delete(user)
        _db.session.commit()

        # Both logs still exist
        assert AuditLog.query.get(log1_id) is not None, (
            "audit_log row was deleted when user was deleted — expected SET NULL"
        )
        assert AuditLog.query.get(log2_id) is not None


# ── P2-3-B  user_id becomes NULL after user deletion ────────────────────────

def test_user_id_is_null_after_user_deletion(app):
    """user_id column must be set to NULL (not the old user.id) after deletion."""
    with app.app_context():
        user = _make_user("p23_user_b")
        log = _make_audit_log(user)
        _db.session.commit()
        log_id = log.id

        _db.session.delete(user)
        _db.session.commit()

        refreshed = AuditLog.query.get(log_id)
        assert refreshed is not None
        assert refreshed.user_id is None, (
            f"Expected user_id=None after user deletion, got {refreshed.user_id}"
        )


# ── P2-3-C  Serialisation works when user_id is NULL ─────────────────────────

def test_to_dict_does_not_raise_when_user_id_is_null(app):
    """AuditLog.to_dict() must handle user_id=NULL without raising."""
    with app.app_context():
        user = _make_user("p23_user_c")
        log = _make_audit_log(user)
        _db.session.commit()
        log_id = log.id

        _db.session.delete(user)
        _db.session.commit()

        refreshed = AuditLog.query.get(log_id)
        d = refreshed.to_dict()   # must not raise

        assert d["user_id"] is None
        assert d["username"] == "p23_user_c"


# ── P2-3-D  Query / filtering does not break for NULL user_id ────────────────

def test_list_query_not_broken_by_null_user_id(app):
    """Paginated list query must return rows with user_id=NULL without error."""
    with app.app_context():
        # Create one log with a deleted user (user_id will be NULL after delete)
        user = _make_user("p23_user_d")
        log_with_user = _make_audit_log(user)
        # Create one log with no user from the start
        log_anon = AuditLog(
            user_id=None,
            username="anonymous",
            action="LOGIN",
            resource_type="User",
            resource_id="0",
            method="POST",
            endpoint="/api/v1/auth/login",
            status_code=200,
            success=True,
        )
        _db.session.add(log_anon)
        _db.session.commit()

        _db.session.delete(user)
        _db.session.commit()

        # Paginated query — mirroring the API implementation
        query = AuditLog.query.order_by(AuditLog.created_at.desc())
        pagination = query.paginate(page=1, per_page=50, error_out=False)

        dicts = [row.to_dict() for row in pagination.items]  # must not raise

        null_user_ids = [d for d in dicts if d["user_id"] is None]
        assert len(null_user_ids) == 2, (
            f"Expected exactly 2 rows with user_id=None (1 deleted-user + 1 anonymous), got {len(null_user_ids)}"
        )

        # username-filter path must also be safe
        filtered = (
            AuditLog.query
            .filter(AuditLog.username.ilike("%p23_user_d%"))
            .all()
        )
        assert len(filtered) >= 1
        assert all(r.user_id is None for r in filtered)


# ── P2-3-E  ORM model definition: FK has ondelete="SET NULL", column nullable ─

def test_orm_model_fk_ondelete_is_set_null():
    """The ForeignKey definition on AuditLog.user_id must use ondelete='SET NULL'."""
    col = AuditLog.__table__.c.user_id

    # Column must be nullable
    assert col.nullable is True, "AuditLog.user_id must be nullable"

    # FK ondelete must be SET NULL (case-insensitive)
    fks = list(col.foreign_keys)
    assert fks, "AuditLog.user_id must have a ForeignKey constraint"
    fk = fks[0]
    assert (fk.ondelete or "").upper() == "SET NULL", (
        f"Expected ondelete='SET NULL', got ondelete={fk.ondelete!r}"
    )


# ── P2-3-F  DB-level FK metadata after schema creation ───────────────────────

def test_db_fk_rule_is_set_null_in_sqlite(app):
    """After db.create_all(), SQLite information reflects ON DELETE SET NULL."""
    with app.app_context():
        # SQLite PRAGMA foreign_key_list returns ondelete as the 'on_delete' field
        result = _db.session.execute(
            text("PRAGMA foreign_key_list('audit_logs')")
        ).fetchall()

        user_fk_rows = [row for row in result if row[2] == "users"]
        assert user_fk_rows, (
            "No FK from audit_logs → users found in PRAGMA foreign_key_list"
        )
        for row in user_fk_rows:
            # Row layout: id, seq, table, from, to, on_update, on_delete, match
            on_delete = row[6]
            assert on_delete.upper() == "SET NULL", (
                f"Expected ON DELETE SET NULL in PRAGMA, got {on_delete!r}"
            )


# ── P2-3-G  Non-deletion paths are unaffected ────────────────────────────────

def test_write_read_paginate_sort_unaffected(app):
    """Normal write / read / paginate / sort operations must work unchanged."""
    with app.app_context():
        user = _make_user("p23_user_g")
        logs = [_make_audit_log(user, action=a) for a in ("CREATE", "UPDATE", "DELETE")]
        _db.session.commit()

        # Read
        for log in logs:
            fetched = AuditLog.query.get(log.id)
            assert fetched is not None
            assert fetched.user_id == user.id
            d = fetched.to_dict()
            assert d["user_id"] == user.id

        # Sort descending by created_at
        sorted_logs = (
            AuditLog.query
            .filter(AuditLog.user_id == user.id)
            .order_by(AuditLog.created_at.desc())
            .all()
        )
        assert len(sorted_logs) == 3

        # Paginate
        pagination = (
            AuditLog.query
            .filter(AuditLog.user_id == user.id)
            .order_by(AuditLog.created_at.desc())
            .paginate(page=1, per_page=2, error_out=False)
        )
        assert pagination.total == 3
        assert len(pagination.items) == 2
