"""APScheduler registration policy.

Business job implementations stay in ``services.scheduler``; this module owns
only trigger configuration, identifiers, names, and misfire policy.
"""

from collections.abc import Callable

from apscheduler.triggers.interval import IntervalTrigger


INTERVAL_JOBS = (
    ("tcp_ping", "TCP Ping 所有服务器", "SCHEDULER_TCP_PING_SECONDS", 20, 10),
    ("fetch_probes", "抓取探针数据", "SCHEDULER_FETCH_PROBES_SECONDS", 30, 15),
    ("check_alerts", "告警规则检查", "SCHEDULER_CHECK_ALERTS_SECONDS", 60, 20),
    ("traffic_accumulate", "流量实时累积", "SCHEDULER_TRAFFIC_ACCUMULATE_SECONDS", 30, 15),
    ("traffic_alerts", "流量超限告警", "SCHEDULER_TRAFFIC_ALERTS_SECONDS", 120, 30),
    ("tg_bot_updates", "Telegram bot 命令轮询", "SCHEDULER_TG_BOT_UPDATES_SECONDS", 15, 10),
)

CRON_JOBS = (
    ("cleanup", "历史数据清理（每天凌晨 2 点）", {"hour": 2, "minute": 0}),
    ("monthly_traffic_reset", "月度流量重置", {"hour": 0, "minute": 5}),
    (
        "audit_log_cleanup",
        "审计日志归档（每周日凌晨 3 点）",
        {"day_of_week": "sun", "hour": 3, "minute": 0},
    ),
    ("agent_command_cleanup", "过期 Agent 命令清理（每天凌晨 4 点）", {"hour": 4, "minute": 0}),
    (
        "probe_partition_maintain",
        "ProbeResult 分区预创建（每天凌晨 1:30）",
        {"hour": 1, "minute": 30},
    ),
    ("storage_monitor", "存储/保留健康检查（每天凌晨 2:30）", {"hour": 2, "minute": 30}),
)


def _positive_interval(app, config_key: str, default: int) -> int:
    try:
        value = int(app.config.get(config_key, default))
    except (TypeError, ValueError):
        value = default
    return max(1, value)


def register_scheduler_jobs(
    scheduler,
    app,
    callbacks: dict[str, Callable[[object], object]],
) -> None:
    """Register every background job from one explicit policy table."""
    for job_id, name, config_key, default_seconds, misfire_grace_time in INTERVAL_JOBS:
        scheduler.add_job(
            func=lambda callback=callbacks[job_id]: callback(app),
            trigger=IntervalTrigger(
                seconds=_positive_interval(app, config_key, default_seconds),
            ),
            id=job_id,
            name=name,
            replace_existing=True,
            misfire_grace_time=misfire_grace_time,
        )

    for job_id, name, trigger_options in CRON_JOBS:
        scheduler.add_job(
            func=lambda callback=callbacks[job_id]: callback(app),
            trigger="cron",
            id=job_id,
            name=name,
            replace_existing=True,
            **trigger_options,
        )
