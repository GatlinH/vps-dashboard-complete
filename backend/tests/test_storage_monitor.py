"""TDD: storage/retention observability job must surface disk + table health.

The rollup rollout was followed by a real production incident where the root
disk filled to 100% and MySQL crash-looped. This job exists so that condition
is detected and recorded/alerted before it takes the database down again.
"""
from datetime import datetime, timedelta, timezone


def test_collect_storage_metrics_reports_core_fields(app, test_server):
    from services.storage_monitor import collect_storage_metrics

    with app.app_context():
        metrics = collect_storage_metrics()

    # Disk usage is always available (host stat), even on SQLite test env.
    assert "disk_used_pct" in metrics
    assert 0 <= metrics["disk_used_pct"] <= 100
    # Table + rollup observability keys are always present (0 on empty/sqlite).
    for key in (
        "probe_results_rows",
        "ping_target_results_rows",
        "telemetry_rollup_lag_hours",
        "ping_rollup_lag_hours",
        "pmax_resident_rows",
    ):
        assert key in metrics


def test_storage_monitor_alerts_when_disk_over_threshold(app, monkeypatch):
    from services import storage_monitor

    fired = {}

    def _fake_collect():
        return {
            "disk_used_pct": 95.0,
            "disk_avail_gb": 0.4,
            "probe_results_rows": 10,
            "ping_target_results_rows": 10,
            "probe_results_size_mib": 1.0,
            "ping_target_results_size_mib": 1.0,
            "telemetry_rollup_lag_hours": 0,
            "ping_rollup_lag_hours": 0,
            "pmax_resident_rows": 0,
        }

    def _fake_alert(title, body, level="warn"):
        fired["title"] = title
        fired["level"] = level

    monkeypatch.setattr(storage_monitor, "collect_storage_metrics", _fake_collect)
    monkeypatch.setattr(storage_monitor, "_emit_storage_alert", _fake_alert)

    with app.app_context():
        app.config["STORAGE_DISK_ALERT_PCT"] = 90
        result = storage_monitor.run_storage_monitor()

    assert result["disk_used_pct"] == 95.0
    assert result["alerted"] is True
    assert "title" in fired


def test_storage_monitor_no_alert_when_healthy(app, monkeypatch):
    from services import storage_monitor

    def _fake_collect():
        return {
            "disk_used_pct": 40.0,
            "disk_avail_gb": 12.0,
            "probe_results_rows": 10,
            "ping_target_results_rows": 10,
            "probe_results_size_mib": 1.0,
            "ping_target_results_size_mib": 1.0,
            "telemetry_rollup_lag_hours": 0,
            "ping_rollup_lag_hours": 0,
            "pmax_resident_rows": 0,
        }

    calls = {"n": 0}

    def _fake_alert(title, body, level="warn"):
        calls["n"] += 1

    monkeypatch.setattr(storage_monitor, "collect_storage_metrics", _fake_collect)
    monkeypatch.setattr(storage_monitor, "_emit_storage_alert", _fake_alert)

    with app.app_context():
        app.config["STORAGE_DISK_ALERT_PCT"] = 90
        result = storage_monitor.run_storage_monitor()

    assert result["alerted"] is False
    assert calls["n"] == 0
