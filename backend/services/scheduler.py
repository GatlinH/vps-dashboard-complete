"""APScheduler configuration and registration root.

Job implementations live in :mod:`services.scheduler_jobs`; this module keeps
the stable public imports used by the application and older integrations.
"""

import logging
import os
from concurrent.futures import ThreadPoolExecutor
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from apscheduler.events import EVENT_JOB_ERROR, EVENT_JOB_EXECUTED, EVENT_JOB_MISSED
from apscheduler.schedulers.background import BackgroundScheduler

from middleware.metrics_middleware import record_alert_fired, record_scheduler_job
from services.scheduler_jobs import health_jobs, maintenance_jobs, metrics_jobs, probe_jobs
from services.scheduler_registration import register_scheduler_jobs

log = logging.getLogger(__name__)

# Stable compatibility exports.  Keep these names here because tests and local
# extensions have historically imported scheduler job callables directly.
_tcp_ping_one = probe_jobs._tcp_ping_one
_job_fetch_probes = probe_jobs._job_fetch_probes
_health_job_check_alerts = health_jobs._job_check_alerts
_health_send_alert = health_jobs._send_alert
_job_tg_bot_updates = health_jobs._job_tg_bot_updates
_job_cleanup = maintenance_jobs._job_cleanup
_job_audit_log_cleanup = maintenance_jobs._job_audit_log_cleanup
_job_agent_command_cleanup = maintenance_jobs._job_agent_command_cleanup
_job_probe_partition_maintain = maintenance_jobs._job_probe_partition_maintain
_job_traffic_accumulate = metrics_jobs._job_traffic_accumulate
_job_monthly_traffic_reset = metrics_jobs._job_monthly_traffic_reset
_job_traffic_alerts = metrics_jobs._job_traffic_alerts


def _job_tcp_ping(app):
    """Compatibility wrapper that preserves scheduler-level monkeypatch hooks."""
    probe_jobs.ThreadPoolExecutor = ThreadPoolExecutor
    probe_jobs._tcp_ping_one = _tcp_ping_one
    return probe_jobs._job_tcp_ping(app)


def _send_alert(cfg, server, rule_type, cur_val, threshold):
    """Compatibility wrapper preserving the historical metrics patch point."""
    health_jobs.record_alert_fired = record_alert_fired
    return _health_send_alert(cfg, server, rule_type, cur_val, threshold)


def _job_check_alerts(app):
    """Compatibility wrapper preserving the historical alert helper hook."""
    health_jobs._send_alert = _send_alert
    return _health_job_check_alerts(app)


def create_scheduler(app):
    """Create, register, and start the process-local background scheduler."""
    worker_id = os.environ.get("APP_WORKER_ID")
    if worker_id is not None and worker_id != "0":
        log.info("Worker %s: 跳过调度器启动（避免重复）", worker_id)
        return None

    tz_name = app.config.get("SCHEDULER_TIMEZONE", "Asia/Shanghai")
    try:
        ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, KeyError):
        log.warning("SCHEDULER_TIMEZONE '%s' 无效，回退到 Asia/Shanghai", tz_name)
        tz_name = "Asia/Shanghai"

    scheduler = BackgroundScheduler(timezone=tz_name)

    def _run_storage_monitor(target_app):
        from services.storage_monitor import _job_storage_monitor
        _job_storage_monitor(target_app)

    callbacks = {
        "tcp_ping": _job_tcp_ping,
        "fetch_probes": _job_fetch_probes,
        "check_alerts": _job_check_alerts,
        "cleanup": _job_cleanup,
        "traffic_accumulate": _job_traffic_accumulate,
        "monthly_traffic_reset": _job_monthly_traffic_reset,
        "traffic_alerts": _job_traffic_alerts,
        "tg_bot_updates": _job_tg_bot_updates,
        "audit_log_cleanup": _job_audit_log_cleanup,
        "agent_command_cleanup": _job_agent_command_cleanup,
        "probe_partition_maintain": _job_probe_partition_maintain,
        "storage_monitor": _run_storage_monitor,
    }
    with app.app_context():
        register_scheduler_jobs(scheduler, app, callbacks)

    scheduler.add_listener(
        _build_scheduler_listener(app),
        EVENT_JOB_EXECUTED | EVENT_JOB_ERROR | EVENT_JOB_MISSED,
    )
    scheduler.start()
    log.info("后台调度器已启动")
    return scheduler


def _build_scheduler_listener(app):
    """Record job outcomes and alert after repeated scheduler failures."""
    def _listener(event):
        status = "ok"
        if event.code == EVENT_JOB_ERROR:
            status = "error"
        elif event.code == EVENT_JOB_MISSED:
            status = "missed"

        if status == "ok":
            log.info("[scheduler] job=%s status=ok", event.job_id)
            try:
                record_scheduler_job(event.job_id, "ok")
            except Exception:
                pass
            return

        log.warning("[scheduler] job=%s status=%s", event.job_id, status)
        try:
            record_scheduler_job(event.job_id, status)
        except Exception:
            pass
        if not app.config.get("SCHEDULER_ALERT_ON_FAILURE", True):
            return

        from extensions import redis_client
        fail_key = f"vps:scheduler:fail:{event.job_id}"
        try:
            fail_count = redis_client.incr(fail_key)
            redis_client.expire(fail_key, 600)
        except Exception:
            fail_count = 1
        threshold = int(app.config.get("SCHEDULER_FAILURE_ALERT_THRESHOLD", 3))
        if fail_count < threshold:
            return

        try:
            with app.app_context():
                from api.telegram import _full_msg, send_message
                from models.models import TelegramConfig
                cfg = TelegramConfig.query.first()
                if cfg and cfg.enabled and cfg.bot_token and cfg.chat_id:
                    detail = getattr(event, "exception", None)
                    body = (
                        f"⚠️ <b>定时任务异常</b>\n任务 ID：<b>{event.job_id}</b>\n"
                        f"状态：<b>{status}</b>\n10 分钟内失败次数：<b>{fail_count}</b>\n"
                        f"异常：<code>{detail or 'N/A'}</code>"
                    )
                    send_message(_full_msg(cfg.prefix, body))
        except Exception as exc:
            log.warning("scheduler 告警推送失败: %s", exc)

    return _listener
