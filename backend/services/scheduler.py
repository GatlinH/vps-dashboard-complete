"""
services/scheduler.py
后台定时任务：
  - 每 20s  批量 TCP ping 所有服务器
  - 每 30s  抓取探针数据（probe_url）
  - 每 60s  检查告警规则，触发 Telegram 通知
  - 每天凌晨 2 点  清理 30 天前的 probe_results 历史

使用 APScheduler（无需 Celery），轻量部署。
"""
import ipaddress
import json
import logging
import os
import shutil
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


_LOCAL_METRICS_PREV = {
    "cpu": None,       # (idle, total)
    "net": None,       # (timestamp, rx_bytes, tx_bytes)
}


def _read_cpu_counters():
    try:
        with open("/proc/stat", "r", encoding="utf-8") as fh:
            parts = fh.readline().split()
        vals = [int(v) for v in parts[1:]]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        return idle, total
    except Exception:
        return None


def _read_mem_percent():
    try:
        data = {}
        with open("/proc/meminfo", "r", encoding="utf-8") as fh:
            for line in fh:
                key, rest = line.split(":", 1)
                data[key] = float(rest.strip().split()[0])
        total = data.get("MemTotal") or 0.0
        available = data.get("MemAvailable")
        if not total or available is None:
            return None
        return max(0.0, min(100.0, (total - available) / total * 100.0))
    except Exception:
        return None


def _default_net_interface():
    try:
        with open("/proc/net/route", "r", encoding="utf-8") as fh:
            for line in fh.readlines()[1:]:
                parts = line.split()
                if len(parts) >= 4 and parts[1] == "00000000" and int(parts[3], 16) & 2:
                    return parts[0]
    except Exception:
        pass
    return None


def _read_net_bytes():
    iface = _default_net_interface()
    try:
        with open("/proc/net/dev", "r", encoding="utf-8") as fh:
            rows = fh.readlines()[2:]
        totals = []
        for row in rows:
            if ":" not in row:
                continue
            name, rest = row.split(":", 1)
            name = name.strip()
            cols = rest.split()
            if len(cols) < 16 or name == "lo":
                continue
            rx = int(cols[0])
            tx = int(cols[8])
            if iface and name == iface:
                return rx, tx
            if not name.startswith(("veth", "br-", "docker")):
                totals.append((rx, tx))
        if totals:
            return max(totals, key=lambda p: p[0] + p[1])
    except Exception:
        return None
    return None


def _format_uptime():
    try:
        seconds = int(float(open("/proc/uptime", "r", encoding="utf-8").read().split()[0]))
        days, rem = divmod(seconds, 86400)
        hours, rem = divmod(rem, 3600)
        minutes, _ = divmod(rem, 60)
        if days:
            return f"{days} days, {hours} hours, {minutes} minutes"
        if hours:
            return f"{hours} hours, {minutes} minutes"
        return f"{minutes} minutes"
    except Exception:
        return None


def _collect_local_host_metrics():
    """Collect real host/container-visible metrics for the local-master node."""
    metrics = {}

    cpu_now = _read_cpu_counters()
    prev_cpu = _LOCAL_METRICS_PREV.get("cpu")
    if cpu_now and prev_cpu:
        idle_delta = cpu_now[0] - prev_cpu[0]
        total_delta = cpu_now[1] - prev_cpu[1]
        if total_delta > 0:
            metrics["cpu_use"] = round(max(0.0, min(100.0, (1.0 - idle_delta / total_delta) * 100.0)), 2)
    _LOCAL_METRICS_PREV["cpu"] = cpu_now

    mem = _read_mem_percent()
    if mem is not None:
        metrics["ram_use"] = round(mem, 2)

    try:
        usage = shutil.disk_usage("/")
        metrics["disk_use"] = round(usage.used / usage.total * 100.0, 2) if usage.total else None
    except Exception:
        pass

    net_now = _read_net_bytes()
    now = time.time()
    prev_net = _LOCAL_METRICS_PREV.get("net")
    if net_now and prev_net:
        dt = max(now - prev_net[0], 0.001)
        rx_delta = max(net_now[0] - prev_net[1], 0)
        tx_delta = max(net_now[1] - prev_net[2], 0)
        # KB/s; frontend labels and traffic accumulator already interpret net_up/down as KB/s.
        metrics["net_down"] = round(rx_delta / 1024.0 / dt, 2)
        metrics["net_up"] = round(tx_delta / 1024.0 / dt, 2)
    if net_now:
        _LOCAL_METRICS_PREV["net"] = (now, net_now[0], net_now[1])

    uptime = _format_uptime()
    if uptime:
        metrics["uptime"] = uptime
    return {k: v for k, v in metrics.items() if v is not None}


def _is_local_master_server(server):
    provider = str(getattr(server, "provider", "") or "").lower()
    name = str(getattr(server, "name", "") or "").lower()
    return provider == "local-master" or name == "192-vps-agent-01"


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
            func=lambda: _job_tg_bot_updates(app),
            trigger=IntervalTrigger(seconds=15),
            id="tg_bot_updates", name="Telegram bot 命令轮询",
            replace_existing=True, misfire_grace_time=10,
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

    IPv6-only nodes must not be marked offline just because the monitor host has
    no IPv6 route. In that case we return ``unknown``: the dashboard cannot
    prove online/offline until an agent/probe URL is installed.
    """
    start      = time.perf_counter()
    status     = "offline"
    latency_ms = None
    err        = None
    try:
        parsed = ipaddress.ip_address(str(ip).strip())
        family = socket.AF_INET6 if parsed.version == 6 else socket.AF_INET
        address = (str(parsed), 80, 0, 0) if family == socket.AF_INET6 else (str(parsed), 80)
        sock = socket.socket(family, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex(address)
        elapsed = (time.perf_counter() - start) * 1000
        sock.close()
        if result == 0:
            status     = "warn" if elapsed > 300 else "online"
            latency_ms = round(elapsed, 2)
        elif family == socket.AF_INET6 and result in {101, 99, 97, 96}:  # no route / cannot assign addr / addr family
            status = "unknown"
            err = "monitor_ipv6_unreachable"
    except OSError as exc:
        if ':' in str(ip):
            status = "unknown"
            err = "monitor_ipv6_unreachable"
        else:
            err = type(exc).__name__
    except Exception as exc:
        err = type(exc).__name__
    return {"server_id": server_id, "status": status, "latency_ms": latency_ms, "error": err}


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
            if _is_local_master_server(s):
                local_metrics = _collect_local_host_metrics()
                for k, v in local_metrics.items():
                    setattr(s, k, v)

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
    """检查告警规则，冷却期内不重复触发。

    P3-8: 冷却判定热路径已迁移到 Redis（SET NX EX）。
    当 ALERT_COOLDOWN_BACKEND=redis（默认）时：
      - 使用 alert:cooldown:{rule_id}:{server_id} Redis key 判定冷却，不读写 DB last_fired。
      - AlertRule.last_fired 不再作为热路径判断依据；该字段保留供审计/展示，新语义：
        "最近一次通过 DB 模式尝试发送告警的时间（best-effort，仅 backend=db 时更新）"。
    当 ALERT_COOLDOWN_BACKEND=db 时：降级使用原 last_fired 逻辑（兼容/回滚路径）。
    """
    from extensions import db, redis_client as _redis
    from models.models import Server, AlertRule, TelegramConfig
    from services.alert_cooldown import check_and_set_cooldown
    from middleware.metrics_middleware import record_cooldown_check

    with app.app_context():
        cfg = TelegramConfig.query.first()
        if not cfg or not cfg.enabled or not cfg.bot_token:
            return

        backend   = app.config.get("ALERT_COOLDOWN_BACKEND", "redis")
        fail_open = app.config.get("ALERT_COOLDOWN_FAIL_OPEN", True)

        rules   = AlertRule.query.filter_by(enabled=True).all()
        servers = {s.id: s for s in Server.query.all()}
        now     = datetime.now(timezone.utc)

        for rule in rules:
            targets = [servers[rule.server_id]] if rule.server_id and rule.server_id in servers \
                       else list(servers.values())

            for s in targets:
                # ── 冷却检查 ─────────────────────────────────────────────────
                # Redis cooldown is enforced later via the atomic gate after
                # the alert condition is evaluated. Only the DB backend needs
                # the legacy early last_fired check here.
                if backend != "redis":
                    # DB backend (legacy / rollback path)
                    if rule.last_fired:
                        lf = rule.last_fired
                        # SQLite returns naive datetimes; normalise to UTC-aware.
                        if lf.tzinfo is None:
                            lf = lf.replace(tzinfo=timezone.utc)
                        elapsed = (now - lf).total_seconds()
                        if elapsed < rule.cool_down_s:
                            continue

                # ── 条件检查 ─────────────────────────────────────────────────
                condition_met = False
                condition_args: tuple = ()

                if rule.rule_type == "cpu" and s.cpu_use >= rule.threshold:
                    condition_met = True
                    condition_args = ("cpu", s.cpu_use, rule.threshold)
                elif rule.rule_type == "ram" and s.ram_use >= rule.threshold:
                    condition_met = True
                    condition_args = ("ram", s.ram_use, rule.threshold)
                elif rule.rule_type == "disk" and s.disk_use >= rule.threshold:
                    condition_met = True
                    condition_args = ("disk", s.disk_use, rule.threshold)
                elif rule.rule_type == "offline" and s.status == "offline":
                    condition_met = True
                    condition_args = ("offline", None, None)
                elif rule.rule_type == "expiry" and s.expiry:
                    days_left = (s.expiry - now.date()).days
                    if 0 <= days_left <= int(rule.threshold or 7):
                        condition_met = True
                        condition_args = ("expiry", days_left, int(rule.threshold or 7))
                elif rule.rule_type == "latency":
                    latest_probe = ProbeResult.query.filter_by(server_id=s.id).order_by(ProbeResult.created_at.desc()).first()
                    latency = latest_probe.latency_ms if latest_probe else None
                    if latency is not None and latency >= rule.threshold:
                        condition_met = True
                        condition_args = ("latency", latency, rule.threshold)
                elif rule.rule_type == "bandwidth":
                    current_kbs = max(float(s.net_up or 0), float(s.net_down or 0))
                    if current_kbs >= float(rule.threshold or 0):
                        condition_met = True
                        condition_args = ("bandwidth", current_kbs, rule.threshold)
                elif rule.rule_type == "consecutive_failures":
                    try:
                        fail_count = int(redis_client.get(f"vps:probe_fail:{s.id}") or 0)
                    except Exception:
                        fail_count = 0
                    if fail_count >= int(rule.threshold or 3):
                        condition_met = True
                        condition_args = ("consecutive_failures", fail_count, int(rule.threshold or 3))

                if not condition_met:
                    continue

                # ── Redis 冷却门控（原子 SET NX EX）─────────────────────────
                if backend == "redis":
                    allowed, reason = check_and_set_cooldown(
                        _redis, rule.id, s.id,
                        rule.cool_down_s, fail_open=fail_open,
                    )
                    try:
                        record_cooldown_check(reason, "redis")
                    except Exception:
                        pass
                    log.debug(
                        "alert_cooldown rule_id=%s server_id=%s fingerprint=%s:%s "
                        "decision=%s backend=redis reason=%s",
                        rule.id, s.id, rule.id, s.id,
                        "allow" if allowed else "suppress", reason,
                    )
                    if not allowed:
                        continue
                else:
                    try:
                        record_cooldown_check("allow", "db")
                    except Exception:
                        pass

                # ── 触发告警 ─────────────────────────────────────────────────
                _send_alert(cfg, s, *condition_args)

                if backend == "db":
                    # DB 模式下保持原语义：写回 last_fired（用于下次检查）
                    rule.last_fired = now
                # Redis 模式下 last_fired 不更新（已由 Redis TTL 控制冷却语义）

        try:
            db.session.commit()
        except Exception as e:
            db.session.rollback()
            log.error("alert 写库失败: %s", e)


def _send_alert(cfg, server, rule_type, cur_val, threshold):
    from api.telegram import send_message, _full_msg
    icons = {"cpu":"🔥","ram":"💾","disk":"💿","bandwidth":"📶","offline":"🔴","expiry":"📅","latency":"📡","consecutive_failures":"🚨"}
    labels = {"cpu":"CPU","ram":"内存","disk":"磁盘","bandwidth":"带宽"}
    icon = icons.get(rule_type, "⚠️")

    if rule_type == "offline":
        body = f"{icon} <b>{server.name}</b> 已离线！\n位置: {server.location}"
    elif rule_type == "expiry":
        body = f"{icon} <b>{server.name}</b> 将在 <b>{int(cur_val)}</b> 天后到期\n到期日: {server.expiry}"
    elif rule_type == "bandwidth":
        body = (f"{icon} <b>{server.name}</b> 带宽告警\n"
                f"当前: <b>{cur_val:.2f} KB/s</b> / 阈值: {threshold} KB/s\n"
                f"位置: {server.location} | IP: {server.ip}")
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
    根据当前实时网速（net_up / net_down KB/s）每30秒累加一次流量计数。
    若探针上报了 bytes_out_snapshot / bytes_in_snapshot，则优先使用差值计算（精确模式）；
    否则降级为速率估算：net_up KB/s × 30s ÷ 1024 ÷ 1024 = GB 增量。

    注意：ProbeResult 与前端详情页均将 net_up/net_down 解释为 KB/s。
    旧代码把它当 MB/s，累计流量会被放大约 1024 倍。
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
            # 降级：速率估算；net_up/net_down 单位是 KB/s。
            delta_up = (s.net_up   or 0) * 30 / 1024 / 1024   # KB/s × 30s → GB
            delta_dn = (s.net_down or 0) * 30 / 1024 / 1024
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


def _job_tg_bot_updates(app):
    with app.app_context():
        from api.telegram import poll_bot_updates
        res = poll_bot_updates()
        if res.get("ok") and res.get("handled"):
            log.info("[tg_bot] handled=%s offset=%s", res.get("handled"), res.get("offset"))
