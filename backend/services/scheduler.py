"""
services/scheduler.py
后台定时任务：
  - 每 20s  批量 TCP ping 所有服务器
  - 每 30s  抓取探针数据（probe_url）
  - 每 60s  检查告警规则，触发 Telegram 通知
  - 每天凌晨 2 点  清理 30 天前的 probe_results 历史

使用 APScheduler（无需 Celery），轻量部署。
"""
import json
import logging
import os
import socket
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval     import IntervalTrigger
from apscheduler.events import EVENT_JOB_EXECUTED, EVENT_JOB_ERROR, EVENT_JOB_MISSED
from middleware.metrics_middleware import record_scheduler_job, record_alert_fired

log = logging.getLogger(__name__)

# Batch size for chunked DELETE operations (retention cleanup fallback).
# Small enough to avoid long row-lock windows; large enough to finish quickly
# without excessive round-trips.  Each batch is committed independently so
# InnoDB releases its row locks after every _CLEANUP_BATCH rows.
# Partial deletions caused by mid-run errors are intentional: the job is
# idempotent and the next scheduled run will clean up any remaining rows.
_CLEANUP_BATCH = 1_000


def create_scheduler(app):
    # 防止 Gunicorn 多 worker 重复启动调度器
    # 默认情况下 GUNICORN_WORKERS=1（见 Dockerfile），调度器只会启动一次。
    # 若需要 workers>1，可在 Gunicorn post_fork hook 中为每个 worker 设置
    # APP_WORKER_ID（"0" 为主 worker），本检查确保只有主 worker 启动调度器。
    worker_id = os.environ.get("APP_WORKER_ID")
    if worker_id is not None and worker_id != "0":
        log.info(f"Worker {worker_id}: 跳过调度器启动（避免重复）")
        return None

    # 时区从配置项读取，默认 Asia/Shanghai 以保持历史兼容。
    # 修改时区会影响所有 cron 任务的触发时间（如月度流量重置 00:05）。
    tz_name = app.config.get("SCHEDULER_TIMEZONE", "Asia/Shanghai")
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, KeyError):
        log.warning(
            "SCHEDULER_TIMEZONE '%s' 无效，回退到 Asia/Shanghai",
            tz_name,
        )
        tz_name = "Asia/Shanghai"
        tz = ZoneInfo(tz_name)

    scheduler = BackgroundScheduler(timezone=tz_name)

    with app.app_context():
        # ── 任务注册 ────────────────────────────────────────────────────────
        scheduler.add_job(
            func=lambda: _job_tcp_ping(app),
            trigger=IntervalTrigger(seconds=20),
            id="tcp_ping", name="TCP Ping 所有服务器",
            replace_existing=True, misfire_grace_time=10,
        )
        scheduler.add_job(
            func=lambda: _job_fetch_probes(app),
            trigger=IntervalTrigger(seconds=30),
            id="fetch_probes", name="抓取探针数据",
            replace_existing=True, misfire_grace_time=15,
        )
        scheduler.add_job(
            func=lambda: _job_check_alerts(app),
            trigger=IntervalTrigger(seconds=60),
            id="check_alerts", name="告警规则检查",
            replace_existing=True, misfire_grace_time=20,
        )
        scheduler.add_job(
            func=lambda: _job_cleanup(app),
            trigger="cron", hour=2, minute=0,
            id="cleanup", name="历史数据清理（每天凌晨 2 点）",
            replace_existing=True,
        )
        scheduler.add_job(
            func=lambda: _job_traffic_accumulate(app),
            trigger=IntervalTrigger(seconds=30),
            id="traffic_accumulate", name="流量实时累积",
            replace_existing=True, misfire_grace_time=15,
        )
        scheduler.add_job(
            func=lambda: _job_monthly_traffic_reset(app),
            trigger="cron", hour=0, minute=5,
            id="monthly_traffic_reset", name="月度流量重置",
            replace_existing=True,
        )
        scheduler.add_job(
            func=lambda: _job_traffic_alerts(app),
            trigger=IntervalTrigger(seconds=120),
            id="traffic_alerts", name="流量超限告警",
            replace_existing=True, misfire_grace_time=30,
        )
        scheduler.add_job(
            func=lambda: _job_audit_log_cleanup(app),
            trigger="cron", day_of_week="sun", hour=3, minute=0,
            id="audit_log_cleanup", name="审计日志归档（每周日凌晨 3 点）",
            replace_existing=True,
        )
        scheduler.add_job(
            func=lambda: _job_agent_command_cleanup(app),
            trigger="cron", hour=4, minute=0,
            id="agent_command_cleanup", name="过期 Agent 命令清理（每天凌晨 4 点）",
            replace_existing=True,
        )
        scheduler.add_job(
            func=lambda: _job_probe_partition_maintain(app),
            trigger="cron", hour=1, minute=30,
            id="probe_partition_maintain",
            name="ProbeResult 分区预创建（每天凌晨 1:30）",
            replace_existing=True,
        )

    scheduler.add_listener(_build_scheduler_listener(app), EVENT_JOB_EXECUTED | EVENT_JOB_ERROR | EVENT_JOB_MISSED)

    scheduler.start()
    log.info("后台调度器已启动")
    return scheduler



def _build_scheduler_listener(app):
    """监听 APScheduler 执行结果，记录实时监控日志并在连续失败时告警。"""

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
                from models.models import TelegramConfig
                from api.telegram import send_message, _full_msg
                cfg = TelegramConfig.query.first()
                if cfg and cfg.enabled and cfg.bot_token and cfg.chat_id:
                    detail = getattr(event, "exception", None)
                    body = (
                        f"⚠️ <b>定时任务异常</b>\n"
                        f"任务 ID：<b>{event.job_id}</b>\n"
                        f"状态：<b>{status}</b>\n"
                        f"10 分钟内失败次数：<b>{fail_count}</b>\n"
                        f"异常：<code>{detail or 'N/A'}</code>"
                    )
                    send_message(_full_msg(cfg.prefix, body))
        except Exception as exc:
            log.warning("scheduler 告警推送失败: %s", exc)

    return _listener

# ── 任务实现 ───────────────────────────────────────────────────────────────────

def _tcp_ping_one(server_id: int, ip: str, timeout: float) -> dict:
    """对单台服务器执行一次 TCP ping，纯 I/O 操作，不访问数据库。

    Parameters:
        server_id: 服务器的数据库 ID，原样透传到返回值以便主线程匹配。
        ip:        目标 IP 地址。
        timeout:   socket 连接超时秒数。

    Returns:
        dict with keys:
            server_id  (int)   — 同入参，供调用方关联结果
            status     (str)   — 'online' | 'warn' | 'offline'
            latency_ms (float|None) — 连接延迟（毫秒），失败时为 None
    """
    start      = time.perf_counter()
    status     = "offline"
    latency_ms = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((ip, 80))
        elapsed = (time.perf_counter() - start) * 1000
        sock.close()
        if result == 0:
            status     = "warn" if elapsed > 300 else "online"
            latency_ms = round(elapsed, 2)
    except Exception:
        pass
    return {"server_id": server_id, "status": status, "latency_ms": latency_ms}


def _job_tcp_ping(app):
    """TCP ping 所有有 IP 的服务器并更新状态（并发执行）"""
    from extensions import db, redis_client
    from models.models import Server, ProbeResult
    from middleware.metrics_middleware import (vps_servers_total, vps_servers_online,
                                              vps_servers_offline, vps_probe_latency_ms)

    with app.app_context():
        servers = Server.query.filter(Server.ip != "").all()
        if not servers:
            return

        timeout     = float(app.config.get("PROBE_TIMEOUT_S", 5))
        max_workers = int(app.config.get("PROBE_PING_MAX_WORKERS", 10))

        # ── 并发 TCP ping（纯 I/O，不持有 DB session）──────────────────────
        ping_args = [(s.id, s.ip, timeout) for s in servers]
        results   = {}  # server_id -> {status, latency_ms}

        with ThreadPoolExecutor(max_workers=min(len(servers), max_workers)) as pool:
            futures = {
                pool.submit(_tcp_ping_one, sid, ip, to): sid
                for sid, ip, to in ping_args
            }
            for fut in as_completed(futures):
                try:
                    r = fut.result()
                    results[r["server_id"]] = r
                except Exception as exc:
                    sid = futures[fut]
                    log.warning("tcp_ping worker error server_id=%s: %s", sid, exc)
                    results[sid] = {"server_id": sid, "status": "offline", "latency_ms": None}

        # ── 写库（主线程，单一 DB session）────────────────────────────────
        server_map = {s.id: s for s in servers}
        for sid, r in results.items():
            s          = server_map[sid]
            status     = r["status"]
            latency_ms = r["latency_ms"]

            s.status = status

            db.session.add(ProbeResult(
                server_id=s.id, latency_ms=latency_ms, status=status,
                cpu_use=s.cpu_use, ram_use=s.ram_use,
                disk_use=s.disk_use, net_up=s.net_up, net_down=s.net_down,
            ))

            # 记录延迟指标
            if latency_ms is not None:
                try:
                    vps_probe_latency_ms.observe(latency_ms)
                except Exception:
                    pass

        # 更新服务器状态指标
        try:
            total  = len(servers)
            online = sum(1 for s in servers if results.get(s.id, {}).get("status") == "online")
            vps_servers_total.set(total)
            vps_servers_online.set(online)
            vps_servers_offline.set(total - online)
        except Exception:
            pass

        try:
            db.session.commit()
            redis_client.delete("vps:servers:admin", "vps:servers:public")
        except Exception as e:
            db.session.rollback()
            log.error(f"tcp_ping 写库失败: {e}")


def _job_fetch_probes(app):
    """抓取有 probe_url 的服务器探针数据（复用共享层 fetch_and_parse_probe）"""
    from extensions import db, redis_client
    from models.models import Server, ProbeResult
    from services.probe_fetcher import fetch_and_parse_probe

    with app.app_context():
        servers = Server.query.filter(Server.probe_url != "").all()
        updated_ids = []

        for s in servers:
            fail_key = f"vps:probe_fail:{s.id}"
            snap = {
                "id": s.id, "name": s.name,
                "cpu_use": s.cpu_use or 0.0, "ram_use": s.ram_use or 0.0,
                "disk_use": s.disk_use or 0.0, "net_up": s.net_up or 0.0,
                "net_down": s.net_down or 0.0, "status": s.status,
                "uptime": s.uptime,
            }
            try:
                metrics, err = fetch_and_parse_probe(
                    s.probe_url, snap,
                    timeout=app.config.get("PROBE_FETCH_TIMEOUT_S", 8),
                )
            except Exception as e:
                # Safety net: fetch_and_parse_probe returns (None, err) for all
                # expected errors; this catches only unexpected exceptions (e.g.,
                # bugs inside probe_fetcher itself).
                err = str(e)
                metrics = None

            if err is not None:
                log.warning(f"探针抓取失败 server_id={s.id}: {err}")
                try:
                    fail_count = redis_client.incr(fail_key)
                    redis_client.expire(fail_key, 300)  # 5分钟窗口
                    if fail_count >= 3 and s.status != "offline":
                        s.status = "offline"
                        log.warning(f"服务器 {s.id}({s.name}) 连续 {fail_count} 次探针失败，标记 offline")
                except Exception:
                    pass
                continue

            for k, v in metrics.items():
                setattr(s, k, v)

            db.session.add(ProbeResult(server_id=s.id, **{
                k: metrics.get(k) for k in
                ["cpu_use", "ram_use", "disk_use", "net_up", "net_down", "status"]
            }, latency_ms=None))

            try:
                redis_client.setex(
                    f"vps:server:{s.id}:metrics",
                    app.config.get("PROBE_CACHE_TTL", 15),
                    json.dumps(metrics, ensure_ascii=False),
                )
                # 成功：清除失败计数
                redis_client.delete(fail_key)
            except Exception:
                pass

            updated_ids.append(str(s.id))

        try:
            db.session.commit()
            if updated_ids:
                redis_client.delete("vps:servers:admin", "vps:servers:public")
        except Exception as e:
            db.session.rollback()
            log.error(f"fetch_probes 写库失败: {e}")


def _job_check_alerts(app):
    """检查告警规则，冷却期内不重复触发"""
    from extensions import db
    from models.models import Server, AlertRule, TelegramConfig
    from api.telegram import send_message, _full_msg

    with app.app_context():
        cfg = TelegramConfig.query.first()
        if not cfg or not cfg.enabled or not cfg.bot_token:
            return

        rules   = AlertRule.query.filter_by(enabled=True).all()
        servers = {s.id: s for s in Server.query.all()}
        now     = datetime.now(timezone.utc)

        for rule in rules:
            targets = [servers[rule.server_id]] if rule.server_id and rule.server_id in servers \
                       else list(servers.values())

            for s in targets:
                # 冷却检查
                if rule.last_fired:
                    elapsed = (now - rule.last_fired).total_seconds()
                    if elapsed < rule.cool_down_s:
                        continue

                fired = False

                if rule.rule_type == "cpu" and s.cpu_use >= rule.threshold:
                    _send_alert(cfg, s, "cpu", s.cpu_use, rule.threshold)
                    fired = True
                elif rule.rule_type == "ram" and s.ram_use >= rule.threshold:
                    _send_alert(cfg, s, "ram", s.ram_use, rule.threshold)
                    fired = True
                elif rule.rule_type == "disk" and s.disk_use >= rule.threshold:
                    _send_alert(cfg, s, "disk", s.disk_use, rule.threshold)
                    fired = True
                elif rule.rule_type == "offline" and s.status == "offline":
                    _send_alert(cfg, s, "offline", None, None)
                    fired = True
                elif rule.rule_type == "expiry" and s.expiry:
                    days_left = (s.expiry - now.date()).days
                    if 0 <= days_left <= 7:
                        _send_alert(cfg, s, "expiry", days_left, 7)
                        fired = True

                if fired:
                    rule.last_fired = now

        try:
            db.session.commit()
        except Exception as e:
            db.session.rollback()
            log.error(f"alert 写库失败: {e}")


def _send_alert(cfg, server, rule_type, cur_val, threshold):
    from api.telegram import send_message, _full_msg
    icons = {"cpu":"🔥","ram":"💾","disk":"💿","offline":"🔴","expiry":"📅"}
    labels = {"cpu":"CPU","ram":"内存","disk":"磁盘"}
    icon = icons.get(rule_type, "⚠️")

    if rule_type == "offline":
        body = f"{icon} <b>{server.name}</b> 已离线！\n位置: {server.location}"
    elif rule_type == "expiry":
        body = f"{icon} <b>{server.name}</b> 将在 <b>{int(cur_val)}</b> 天后到期\n到期日: {server.expiry}"
    else:
        label = labels.get(rule_type, rule_type.upper())
        body  = (f"{icon} <b>{server.name}</b> {label} 告警\n"
                 f"当前: <b>{cur_val:.1f}%</b> / 阈值: {threshold}%\n"
                 f"位置: {server.location} | IP: {server.ip}")

    send_message(_full_msg(cfg.prefix, body))
    try:
        record_alert_fired(rule_type, "telegram")
    except Exception:
        pass


def _job_cleanup(app):
    """清理历史探针数据（MySQL 优先 DROP PARTITION，非 MySQL 或未分区表降级为 DELETE）。

    保留天数由 PROBE_RESULT_RETENTION_DAYS 控制（默认 30 天）。
    清理过程输出结构化日志：分区名、耗时、影响范围。
    本函数幂等，重复执行不报错。
    """
    import time as _time
    from extensions import db
    from models.models import ProbeResult
    from services.probe_partition import (
        _is_mysql, drop_expired_partitions, list_partitions,
    )

    retention_days = int(app.config.get("PROBE_RESULT_RETENTION_DAYS", 30))
    t0 = _time.perf_counter()

    with app.app_context():
        engine = db.engine
        use_partition = False
        if _is_mysql(engine):
            # Only use DROP PARTITION if the table is actually partitioned.
            # An unpartitioned probe_results (pre-migration) would return an
            # empty list from list_partitions() and silently skip all cleanup.
            partitions = list_partitions(engine)
            has_pmax = any(p["partition_name"] == "pmax" for p in partitions)
            use_partition = bool(partitions) and has_pmax

        if use_partition:
            # ── MySQL: DROP PARTITION（瞬时元数据操作，无行级锁）──────────────
            dropped = drop_expired_partitions(engine, retention_days=retention_days)
            elapsed_ms = round((_time.perf_counter() - t0) * 1000, 1)
            if dropped:
                log.info(
                    "probe_cleanup: method=drop_partition count=%d "
                    "partitions=%s elapsed_ms=%.1f retention_days=%d",
                    len(dropped), dropped, elapsed_ms, retention_days,
                )
            else:
                log.info(
                    "probe_cleanup: method=drop_partition count=0 "
                    "elapsed_ms=%.1f retention_days=%d",
                    elapsed_ms, retention_days,
                )
        else:
            # ── Fallback: batched DELETE（SQLite / non-partitioned MySQL / pre-migration）
            # Materialise IDs in chunks to bound each transaction's row-lock window
            # and avoid a single long-running statement on large tables.
            cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
            try:
                total_deleted = 0
                while True:
                    ids = [
                        row.id
                        for row in db.session.query(ProbeResult.id)
                        .filter(ProbeResult.created_at < cutoff)
                        .order_by(ProbeResult.id)
                        .limit(_CLEANUP_BATCH)
                        .all()
                    ]
                    if not ids:
                        break
                    batch = ProbeResult.query.filter(
                        ProbeResult.id.in_(ids)
                    ).delete(synchronize_session=False)
                    db.session.commit()
                    total_deleted += batch
                elapsed_ms = round((_time.perf_counter() - t0) * 1000, 1)
                log.info(
                    "probe_cleanup: method=delete rows=%d elapsed_ms=%.1f "
                    "retention_days=%d cutoff=%s",
                    total_deleted, elapsed_ms, retention_days, cutoff.date(),
                )
            except Exception as exc:
                db.session.rollback()
                log.error("probe_cleanup: DELETE fallback failed: %s", exc)


def _job_traffic_accumulate(app):
    """
    根据当前实时网速（net_up / net_down MB/s）每30秒累加一次流量计数。
    若探针上报了 bytes_out_snapshot / bytes_in_snapshot，则优先使用差值计算（精确模式）；
    否则降级为速率估算：net_up MB/s × 30s ÷ 1024 = GB 增量
    """
    from extensions import db, redis_client
    from models.models import Server
    with app.app_context():
        servers = Server.query.filter(Server.status != 'offline').all()
        for s in servers:
            # 优先用字节快照差值（精确），快照由 push_metrics 接口写入，
            # traffic_up_gb/traffic_down_gb 已在 push_metrics 时更新；
            # 若无快照，则降级为速率估算。
            if s.bytes_out_snapshot and s.bytes_in_snapshot:
                continue  # 精确模式：流量已由 push_metrics 实时累加，跳过估算
            # 降级：速率估算
            delta_up = (s.net_up   or 0) * 30 / 1024   # MB/s × 30s → GB
            delta_dn = (s.net_down or 0) * 30 / 1024
            if delta_up == 0 and delta_dn == 0:
                continue
            s.traffic_up_gb   = round((s.traffic_up_gb   or 0) + delta_up, 6)
            s.traffic_down_gb = round((s.traffic_down_gb or 0) + delta_dn, 6)
            s.traffic_used_gb = s.traffic_up_gb + s.traffic_down_gb
            # Invalidate cache
            try:
                redis_client.delete(f"vps:traffic:{s.id}")
            except Exception:
                pass
        try:
            db.session.commit()
            redis_client.delete("vps:traffic:summary")
            redis_client.delete("vps:servers:admin", "vps:servers:public")
        except Exception as e:
            db.session.rollback()
            log.error(f"traffic_accumulate 写库失败: {e}")


def _job_monthly_traffic_reset(app):
    """每天 00:05 检查并重置到达重置日的服务器流量。

    使用调度器配置的时区（SCHEDULER_TIMEZONE）计算"今天"的日期，避免系统时区
    与调度器时区不一致时，date.today() 返回错误日期导致重置时机偏差。
    """
    from api.traffic import check_monthly_resets
    tz_name = app.config.get("SCHEDULER_TIMEZONE", "Asia/Shanghai")
    try:
        tz = ZoneInfo(tz_name)
    except (ZoneInfoNotFoundError, KeyError):
        tz = ZoneInfo("Asia/Shanghai")
    today_in_tz = datetime.now(tz).date()
    with app.app_context():
        reset_ids = check_monthly_resets(today=today_in_tz)
        if reset_ids:
            log.info(f"月度流量重置: server_ids={reset_ids}")


def _job_traffic_alerts(app):
    """每2分钟检查流量超限，触发 Telegram 推送"""
    from extensions import db
    from models.models import Server, TelegramConfig
    from api.traffic import _check_and_fire_traffic_alert
    with app.app_context():
        cfg = TelegramConfig.query.first()
        if not cfg or not cfg.enabled or not cfg.bot_token:
            return
        servers = Server.query.filter(Server.traffic_limit_gb > 0).all()
        for s in servers:
            _check_and_fire_traffic_alert(s)


def _job_audit_log_cleanup(app):
    """每周日凌晨 3 点清理 90 天前的审计日志"""
    import os
    from extensions import db
    from models.models import AuditLog
    retention_days = int(os.environ.get("AUDIT_LOG_RETENTION_DAYS", 90))
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    with app.app_context():
        try:
            deleted = AuditLog.query.filter(AuditLog.created_at < cutoff).delete()
            db.session.commit()
            log.info(f"审计日志归档: 删除 {deleted} 条 {retention_days} 天前的记录")
        except Exception as e:
            db.session.rollback()
            log.error(f"审计日志归档失败: {e}")


def _job_agent_command_cleanup(app):
    """每天凌晨 4 点清理已过期或已完成的 AgentCommand 记录（保留 7 天）"""
    from extensions import db
    from models.models import AgentCommand
    retention_days = int(app.config.get("AGENT_COMMAND_RETENTION_DAYS", 7))
    cutoff = datetime.now(timezone.utc) - timedelta(days=retention_days)
    with app.app_context():
        try:
            deleted = (
                AgentCommand.query
                .filter(
                    AgentCommand.created_at < cutoff,
                    AgentCommand.status.in_(["executed", "pending"]),
                )
                .delete(synchronize_session=False)
            )
            db.session.commit()
            if deleted:
                log.info(
                    "agent_command_cleanup: 删除 %d 条 %d 天前的 agent_commands",
                    deleted, retention_days,
                )
        except Exception as e:
            db.session.rollback()
            log.error("agent_command_cleanup 失败: %s", e)


def _job_probe_partition_maintain(app):
    """每天凌晨 1:30 预创建 probe_results 未来 N 天分区。

    确保写入数据始终落入精确的日级分区而非 pmax 兜底分区，
    从而支持后续精确的 DROP PARTITION 清理操作。
    仅 MySQL 环境执行；SQLite / 非分区环境直接返回。
    """
    from extensions import db
    from services.probe_partition import (
        _is_mysql,
        ensure_future_partitions,
        list_partitions,
    )

    days_ahead = int(app.config.get("PROBE_RESULT_PARTITION_DAYS_AHEAD", 30))
    retention_days = int(app.config.get("PROBE_RESULT_RETENTION_DAYS", 30))
    with app.app_context():
        if not _is_mysql(db.engine):
            return

        partitions = list_partitions(db.engine)
        has_pmax = any(p["partition_name"] == "pmax" for p in partitions)
        if not partitions or not has_pmax:
            log.warning(
                "probe_partition_maintain: partitioning is not enabled for "
                "probe_results; skipping maintenance"
            )
            return

        created = ensure_future_partitions(
            db.engine, days_ahead=days_ahead, max_backfill_days=retention_days,
        )
        if created:
            log.info(
                "probe_partition_maintain: created %d partition(s): %s",
                len(created), created,
            )
        else:
            log.info("probe_partition_maintain: all partitions up to date")
