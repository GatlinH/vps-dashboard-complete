"""Traffic and metrics-derived scheduled jobs."""
import logging
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
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

