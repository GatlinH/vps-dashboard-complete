"""Regression: PING history fallback DDL is process-scoped, not request-scoped."""


def test_ping_history_table_ddl_runs_only_once_per_process(app, monkeypatch):
    import services.probe_history as probe_history

    calls = []
    original_execute = probe_history.db.session.execute

    def tracked_execute(*args, **kwargs):
        calls.append(str(args[0]))
        return original_execute(*args, **kwargs)

    with app.app_context():
        probe_history._PTR_HISTORY_TABLE_READY = False
        monkeypatch.setattr(probe_history.db.session, 'execute', tracked_execute)
        assert probe_history._target_history_table_ready() is True
        assert probe_history._target_history_table_ready() is True

    ddl = [sql for sql in calls if 'CREATE TABLE IF NOT EXISTS ping_target_results' in sql]
    assert len(ddl) == 1
