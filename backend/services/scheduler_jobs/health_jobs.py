"""Agent/server health alerts and notification polling jobs."""
import logging
from datetime import datetime, timezone
from middleware.metrics_middleware import record_alert_fired
log = logging.getLogger(__name__)
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


def _job_tg_bot_updates(app):
    with app.app_context():
        from api.telegram import poll_bot_updates
        res = poll_bot_updates()
        if res.get("ok") and res.get("handled"):
            log.info("[tg_bot] handled=%s offset=%s", res.get("handled"), res.get("offset"))
