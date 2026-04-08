# backend/services/alert_service.py - 完整版本

import logging
from datetime import datetime, timedelta
from typing import List, Optional
from extensions import db, redis_client
from models.models import Server, AlertRule, TelegramConfig, User
import requests
import json

logger = logging.getLogger(__name__)

class TelegramService:
    """Telegram 服务"""
    
    def __init__(self, config: TelegramConfig = None):
        self.config = config
    
    def send_message(self, message: str, parse_mode: str = 'HTML') -> bool:
        """发送消息"""
        if not self.config or not self.config.enabled or not self.config.bot_token:
            logger.warning("Telegram 未配置")
            return False
        
        try:
            url = f"https://api.telegram.org/bot{self.config.bot_token}/sendMessage"
            payload = {
                'chat_id': self.config.chat_id,
                'text': f"{self.config.prefix}\n{message}",
                'parse_mode': parse_mode,
                'disable_web_page_preview': True,
            }
            
            response = requests.post(url, json=payload, timeout=5)
            if response.status_code == 200:
                logger.info(f"✓ Telegram 消息已发送: {message[:30]}...")
                return True
            else:
                logger.error(f"✗ Telegram 发送失败: {response.text}")
                return False
        
        except Exception as e:
            logger.error(f"✗ Telegram 异常: {e}")
            return False


class AlertService:
    """告警服务"""
    
    def __init__(self):
        self.telegram_service = None
        self.reload_config()
    
    def reload_config(self):
        """重新加载配置"""
        try:
            config = TelegramConfig.query.first()
            self.telegram_service = TelegramService(config)
        except Exception as e:
            logger.error(f"加载 Telegram 配置失败: {e}")
    
    def check_and_alert(self):
        """定期检查告警规则并发送（应该由 APScheduler 调用）"""
        try:
            servers = Server.query.all()
            
            for server in servers:
                # CPU 告警
                if server.cpu_use and server.cpu_use > 90:
                    self._check_alert(
                        server,
                        'CPU_HIGH',
                        f"🔴 <b>CPU 告警</b>\n"
                        f"服务器: {server.name}\n"
                        f"CPU: {server.cpu_use}%\n"
                        f"时间: {datetime.utcnow().isoformat()}"
                    )
                
                # 内存告警
                if server.ram_use and server.ram_use > 85:
                    self._check_alert(
                        server,
                        'RAM_HIGH',
                        f"⚠️ <b>内存告警</b>\n"
                        f"服务器: {server.name}\n"
                        f"内存: {server.ram_use}%\n"
                        f"时间: {datetime.utcnow().isoformat()}"
                    )
                
                # 磁盘告警
                if server.disk_use and server.disk_use > 90:
                    self._check_alert(
                        server,
                        'DISK_HIGH',
                        f"🔴 <b>磁盘告警</b>\n"
                        f"服务器: {server.name}\n"
                        f"磁盘: {server.disk_use}%\n"
                        f"时间: {datetime.utcnow().isoformat()}"
                    )
                
                # 离线告警
                if server.status == 'offline':
                    self._check_alert(
                        server,
                        'OFFLINE',
                        f"💔 <b>服务器离线</b>\n"
                        f"服务器: {server.name}\n"
                        f"IP: {server.ip}\n"
                        f"时间: {datetime.utcnow().isoformat()}"
                    )
                
                # 即将过期告警
                if server.expiry:
                    days_left = (server.expiry - datetime.now().date()).days
                    if 0 < days_left <= 7:
                        self._check_alert(
                            server,
                            'EXPIRY_SOON',
                            f"📅 <b>服务器即将过期</b>\n"
                            f"服务器: {server.name}\n"
                            f"剩余: {days_left} 天\n"
                            f"过期日期: {server.expiry}"
                        )
                
                # 已过期告警
                if server.expiry and server.expiry < datetime.now().date():
                    self._check_alert(
                        server,
                        'EXPIRED',
                        f"💀 <b>服务器已过期</b>\n"
                        f"服务器: {server.name}\n"
                        f"过期日期: {server.expiry}"
                    )
        
        except Exception as e:
            logger.error(f"告警检查异常: {e}", exc_info=True)
    
    def _check_alert(self, server: Server, alert_type: str, message: str) -> bool:
        """检查是否应该发送告警（考虑冷却期）"""
        cache_key = f"vps:alert:{server.id}:{alert_type}"
        
        # 检查冷却期
        if redis_client.exists(cache_key):
            logger.debug(f"告警在冷却期: {cache_key}")
            return False
        
        # 获取或创建告警规则
        rule = AlertRule.query.filter_by(
            server_id=server.id,
            rule_type=alert_type
        ).first()
        
        if not rule:
            # 从全局规则读取
            rule = AlertRule.query.filter_by(
                server_id=None,
                rule_type=alert_type
            ).first()
        
        if rule and not rule.enabled:
            logger.debug(f"告警规则已禁用: {alert_type}")
            return False
        
        # 发送告警
        success = self.telegram_service.send_message(message)
        
        if success:
            # 设置冷却期（默认 30 分钟）
            cool_down = rule.cool_down_s if rule else 1800
            redis_client.setex(cache_key, cool_down, "1")
            
            # 更新告警规则的最后触发时间
            if rule:
                rule.last_fired = datetime.utcnow()
                db.session.commit()
        
        return success
    
    def send_manual_alert(self, message: str) -> bool:
        """手动发送告警消息"""
        return self.telegram_service.send_message(message)


# 任务调度配置
# backend/services/scheduler.py

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from datetime import datetime
import logging

logger = logging.getLogger(__name__)

class SchedulerService:
    """后台任务调度"""
    
    def __init__(self, app=None):
        self.scheduler = BackgroundScheduler(daemon=True)
        self.app = app
    
    def init_app(self, app):
        """初始化应用"""
        self.app = app
        self.setup_jobs()
    
    def setup_jobs(self):
        """设置定时任务"""
        
        # 每 5 分钟检查一次告警
        self.scheduler.add_job(
            func=self._check_alerts_job,
            trigger=CronTrigger(minute="*/5"),
            id='check_alerts',
            name='检查告警规则',
            replace_existing=True,
        )
        
        # 每小时清理过期探针数据
        self.scheduler.add_job(
            func=self._cleanup_old_data_job,
            trigger=CronTrigger(hour="*/1"),
            id='cleanup_data',
            name='清理过期数据',
            replace_existing=True,
        )
        
        # 每天凌晨 2 点执行数据库备份
        self.scheduler.add_job(
            func=self._backup_database_job,
            trigger=CronTrigger(hour=2, minute=0),
            id='backup_db',
            name='数据库备份',
            replace_existing=True,
        )
        
        logger.info("✓ 定时任务已配置")
    
    def _check_alerts_job(self):
        """告警检查任务"""
        try:
            with self.app.app_context():
                from services.alert_service import AlertService
                alert_service = AlertService()
                alert_service.check_and_alert()
                logger.info("✓ 告警检查完成")
        except Exception as e:
            logger.error(f"✗ 告警检查失败: {e}", exc_info=True)
    
    def _cleanup_old_data_job(self):
        """数据清理任务"""
        try:
            with self.app.app_context():
                from models.models import ProbeResult
                from extensions import db
                
                # 删除 30 天前的探针数据
                cutoff_date = datetime.utcnow() - timedelta(days=30)
                deleted = ProbeResult.query.filter(
                    ProbeResult.created_at < cutoff_date
                ).delete()
                db.session.commit()
                
                logger.info(f"✓ 已删除 {deleted} 条过期数据")
        except Exception as e:
            logger.error(f"✗ 数据清理失败: {e}", exc_info=True)
    
    def _backup_database_job(self):
        """数据库备份任务"""
        try:
            import subprocess
            from datetime import datetime
            
            config = self.app.config
            backup_file = f"/backup/vps-db-{datetime.now().strftime('%Y%m%d-%H%M%S')}.sql.gz"
            
            cmd = (
                f"mysqldump -h {config['MYSQL_HOST']} "
                f"-u {config['MYSQL_USER']} "
                f"-p{config['MYSQL_PASSWORD']} "
                f"{config['MYSQL_DB']} | gzip > {backup_file}"
            )
            
            result = subprocess.run(cmd, shell=True, capture_output=True)
            if result.returncode == 0:
                logger.info(f"✓ 数据库备份成功: {backup_file}")
            else:
                logger.error(f"✗ 数据库备份失败: {result.stderr.decode()}")
        except Exception as e:
            logger.error(f"✗ 备份异常: {e}", exc_info=True)
    
    def start(self):
        """启动调度器"""
        if not self.scheduler.running:
            self.scheduler.start()
            logger.info("✓ 后台任务调度器已启动")
    
    def stop(self):
        """停止调度器"""
        if self.scheduler.running:
            self.scheduler.shutdown()
            logger.info("✓ 后台任务调度器已停止")


# 在 app.py 中使用
scheduler = SchedulerService()

def create_app(config_class=Config):
    app = Flask(__name__)
    app.config.from_object(config_class)
    
    # ... 其他初始化 ...
    
    scheduler.init_app(app)
    
    @app.before_request
    def start_scheduler():
        scheduler.start()
    
    @app.teardown_appcontext
    def stop_scheduler(exception=None):
        # 不要在每个请求后停止，只在应用关闭时停止
        pass
    
    return app
