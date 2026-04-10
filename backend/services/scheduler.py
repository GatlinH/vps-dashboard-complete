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
from datetime import datetime, timezone, timedelta
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval     import IntervalTrigger

log = logging.getLogger(__name__)


def create_scheduler(app):
    # 防止 Gunicorn 多 worker 重复启动调度器
    # 默认情况下 GUNICORN_WORKERS=1（见 Dockerfile），调度器只会启动一次。
    # 若需要 workers>1，可在 Gunicorn post_fork hook 中为每个 worker 设置
    # APP_WORKER_ID（"0" 为主 worker），本检查确保只有主 worker 启动调度器。
    worker_id = os.environ.get("APP_WORKER_ID")
    if worker_id is not None and worker_id != "0":
        log.info(f"Worker {worker_id}: 跳过调度器启动（避免重复）")
        return None

    scheduler = BackgroundScheduler(timezone="Asia/Shanghai")

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

    scheduler.start()
    log.info("后台调度器已启动")
    return scheduler


# ── 任务实现 ───────────────────────────────────────────────────────────────────

def _job_tcp_ping(app):
    """TCP ping 所有有 IP 的服务器并更新状态"""
    import socket
    import time
    from extensions import db, redis_client
    from models.models import Server, ProbeResult
    from utils.metrics import (vps_servers_total, vps_servers_online,
                               vps_servers_offline, vps_probe_latency_ms)

    with app.app_context():
        servers = Server.query.filter(Server.ip != "").all()
        timeout = app.config.get("PROBE_TIMEOUT_S", 5)

        for s in servers:
            start  = time.perf_counter()
            status = "offline"
            lat    = None
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(float(timeout))
                result = sock.connect_ex((s.ip, 80))
                elapsed = (time.perf_counter() - start) * 1000
                sock.close()
                if result == 0:
                    status = "warn" if elapsed > 300 else "online"
                    lat    = round(elapsed, 2)
            except Exception:
                pass

            old_status = s.status
            s.status   = status

            db.session.add(ProbeResult(
                server_id=s.id, latency_ms=lat, status=status,
                cpu_use=s.cpu_use, ram_use=s.ram_use,
                disk_use=s.disk_use, net_up=s.net_up, net_down=s.net_down,
            ))

            # 记录延迟指标
            if lat is not None:
                try:
                    vps_probe_latency_ms.observe(lat)
                except Exception:
                    pass

        # 更新服务器状态指标
        try:
            total  = len(servers)
            online = sum(1 for s in servers if s.status == "online")
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
    """抓取有 probe_url 的服务器探针数据"""
    import urllib.request
    from extensions import db, redis_client
    from models.models import Server, ProbeResult
    from api.probe import _parse_probe_payload

    with app.app_context():
        servers = Server.query.filter(Server.probe_url != "").all()
        updated_ids = []

        for s in servers:
            fail_key = f"vps:probe_fail:{s.id}"
            try:
                req = urllib.request.Request(
                    s.probe_url,
                    headers={"User-Agent": "VPS-Dashboard/1.0"},
                )
                with urllib.request.urlopen(req, timeout=8) as resp:
                    payload = json.loads(resp.read().decode())

                metrics = _parse_probe_payload(payload, s)
                for k, v in metrics.items():
                    setattr(s, k, v)

                db.session.add(ProbeResult(server_id=s.id, **{
                    k: metrics.get(k) for k in
                    ["cpu_use","ram_use","disk_use","net_up","net_down","status"]
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

                updated_ids.append(s.id)
            except Exception as e:
                log.warning(f"探针抓取失败 server_id={s.id}: {e}")
                # 失败计数
                try:
                    fail_count = redis_client.incr(fail_key)
                    redis_client.expire(fail_key, 300)  # 5分钟窗口
                    if fail_count >= 3 and s.status != "offline":
                        s.status = "offline"
                        log.warning(f"服务器 {s.id}({s.name}) 连续 {fail_count} 次探针失败，标记 offline")
                except Exception:
                    pass

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


def _job_cleanup(app):
    """清理 30 天前的历史探针数据"""
    from extensions import db
    from models.models import ProbeResult
    cutoff = datetime.now(timezone.utc) - timedelta(days=30)
    with app.app_context():
        deleted = ProbeResult.query.filter(ProbeResult.created_at < cutoff).delete()
        db.session.commit()
        if deleted:
            log.info(f"历史数据清理: 删除 {deleted} 条 probe_results")


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
            if (hasattr(s, 'bytes_out_snapshot') and s.bytes_out_snapshot
                    and hasattr(s, 'bytes_in_snapshot') and s.bytes_in_snapshot):
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
    """每天 00:05 检查并重置到达重置日的服务器流量"""
    from api.traffic import check_monthly_resets
    with app.app_context():
        reset_ids = check_monthly_resets()
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
