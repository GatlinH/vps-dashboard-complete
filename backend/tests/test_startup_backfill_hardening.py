"""回归：全新库首启时 server_groups backfill 的异常处理必须与数据库后端无关。

历史缺陷：启动时 create_app 在生产分支跳过 create_all，却仍调用
backfill_server_groups()。当 server_groups 表尚不存在时：
  - SQLite（测试）抛 OperationalError  → 被旧的 except 接住，测试全绿；
  - MySQL（生产）抛 ProgrammingError(1146) → 未被接住 → create_app 崩溃。
导致"测试通过但生产全新库首启必崩"的初始化死锁。

修复：捕获同时覆盖 OperationalError 和 ProgrammingError；生产优雅跳过、
非生产仍上抛。
"""
import pytest
from sqlalchemy.exc import OperationalError, ProgrammingError

import app as app_module


def _raiser(exc):
    def _fn():
        raise exc
    return _fn


def _missing_table_error(exc_cls):
    # SQLAlchemy DBAPIError 签名: (statement, params, orig)
    return exc_cls("SELECT 1 FROM server_groups", {}, Exception("table missing"))


@pytest.mark.parametrize("exc_cls", [OperationalError, ProgrammingError])
def test_startup_backfill_skips_missing_table_in_production(monkeypatch, app, exc_cls):
    """生产环境下，无论后端抛哪种缺表异常，都必须优雅跳过而不是崩溃。"""
    monkeypatch.setattr(
        "services.server_groups.backfill_server_groups",
        _raiser(_missing_table_error(exc_cls)),
    )
    with app.app_context():
        # 不得抛异常
        app_module._startup_backfill_server_groups(is_production=True)


@pytest.mark.parametrize("exc_cls", [OperationalError, ProgrammingError])
def test_startup_backfill_reraises_in_non_production(monkeypatch, app, exc_cls):
    """非生产环境必须把缺表异常上抛，避免掩盖本地 schema 问题。"""
    monkeypatch.setattr(
        "services.server_groups.backfill_server_groups",
        _raiser(_missing_table_error(exc_cls)),
    )
    with app.app_context():
        with pytest.raises((OperationalError, ProgrammingError)):
            app_module._startup_backfill_server_groups(is_production=False)
