# backend/services/alert_service.py - 完整版本

"""
告警服务 - 处理所有告警逻辑
包括：CPU/内存/磁盘/离线/过期告警
"""
import logging
from datetime import datetime, timedelta
from typing import Optional, List
from extensions import db, redis_client
from models.models import Server, AlertRule, TelegramConfig, AuditLog
import requests
import json

logger = logging.getLogger(__name__)


class TelegramNotifier:
    """Telegram 通知器"""
    
    def __init__(self, config: TelegramConfig = None):
        self.config = config
        self.api_url = "https://api.telegram.org/bot{token}/{method}"
    
    def send_message(self, message: str, parse_mode: str = 'HTML') -> bool:
        """发送 Telegram 消息"""
        if not self.config or not self.config.enabled or not self.config.bot_token:
            logger.warning("Telegram 未配置")
            return False
        
        try:
            url = self.api_url.format(
                token=self.config.bot_token,
                method='sendMessage'
            )
            payload = {
                'chat_id': self.config.chat_id,
                'text': f"{self.config.prefix}\n{message}",
                'parse_mode': parse_mode,
                'disable_web_page_preview': True,
            }
            
            response = requests.post(url, json=payload, timeout=5)
            result = response.json()
            
            if result.get('ok'):
                logger.info(f"✓ Telegram 消息已发送: {message[:30]}...")
                return True
            else:
                logger.error(f"✗ Telegram 发送失败: {result.get('description', 'Unknown')}")
                return False
        
        except Exception as e:
            logger.error(f"✗ Telegram 异常: {e}")
            return False


class AlertService:
    """告警服务"""
    
    # 告警类型定义
    ALERT_TYPES = {
        'CPU_HIGH': ('🔴', '高 CPU 使用率'),
        'RAM_HIGH': ('⚠️', '高内存使用率'),
        'DISK_HIGH': ('💾', '高磁盘使用率'),
        'OFFLINE': ('💔', '服务器离线'),
        'EXPIRY_SOON': ('📅', '服务器即将过期'),
        'EXPIRED': ('💀', '服务器已过期'),
    }
    
    # 默认阈值
    DEFAULT_THRESHOLDS = {
        'CPU_HIGH': 90,
        'RAM_HIGH': 85,
        'DISK_HIGH': 90,
    }
    
    # 默认冷却时间（秒）
    DEFAULT_COOLDOWN = 1800  # 30 分钟
    
    def __init__(self):
        self.telegram_config = None
        self.notifier = None
        self.reload_config()
    
    def reload_config(self):
        """重新加载 Telegram 配置"""
        try:
            self.telegram_config = TelegramConfig.query.first()
            self.notifier = TelegramNotifier(self.telegram_config)
            logger.info("✓ Telegram 配置已加载")
        except Exception as e:
            logger.error(f"✗ 加载 Telegram 配置失败: {e}")
    
    def check_and_alert(self):
        """检查所有告警规则并发送通知"""
        try:
            servers = Server.query.all()
            
            for server in servers:
                # CPU 告警
                if server.cpu_use and server.cpu_use > 90:
                    self._trigger_alert(
                        server,
                        'CPU_HIGH',
                        f"🔴 <b>CPU 告警</b>\n"
                        f"服务器：{server.name}\n"
                        f"CPU 使用率：{server.cpu_use}%\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                
                # 内存告警
                if server.ram_use and server.ram_use > 85:
                    self._trigger_alert(
                        server,
                        'RAM_HIGH',
                        f"⚠️ <b>内存告警</b>\n"
                        f"服务器：{server.name}\n"
                        f"内存使用率：{server.ram_use}%\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                
                # 磁盘告警
                if server.disk_use and server.disk_use > 90:
                    self._trigger_alert(
                        server,
                        'DISK_HIGH',
                        f"💾 <b>磁盘告警</b>\n"
                        f"服务器：{server.name}\n"
                        f"磁盘使用率：{server.disk_use}%\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                
                # 离线告警
                if server.status == 'offline':
                    self._trigger_alert(
                        server,
                        'OFFLINE',
                        f"💔 <b>服务器离线</b>\n"
                        f"服务器：{server.name}\n"
                        f"IP：{server.ip}\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                
                # 即将过期告警
                if server.expiry:
                    days_left = (server.expiry - datetime.now().date()).days
                    if 0 < days_left <= 7:
                        self._trigger_alert(
                            server,
                            'EXPIRY_SOON',
                            f"📅 <b>服务器即将过期</b>\n"
                            f"服务器：{server.name}\n"
                            f"剩余天数：{days_left} 天\n"
                            f"过期日期：{server.expiry}\n"
                            f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}"
                        )
                
                # 已过期告警
                elif server.expiry and server.expiry < datetime.now().date():
                    self._trigger_alert(
                        server,
                        'EXPIRED',
                        f"💀 <b>服务器已过期</b>\n"
                        f"服务器：{server.name}\n"
                        f"过期日期：{server.expiry}\n"
                        f"时间：{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
        
        except Exception as e:
            logger.error(f"✗ 告警检查异常: {e}", exc_info=True)
    
    def _trigger_alert(self, server: Server, alert_type: str, message: str) -> bool:
        """触发告警（考虑冷却期）"""
        cache_key = f"vps:alert:{server.id}:{alert_type}"
        
        # 检查冷却期
        if redis_client.exists(cache_key):
            logger.debug(f"告警在冷却期: {cache_key}")
            return False
        
        # 获取告警规则
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
        success = self.notifier.send_message(message)
        
        if success:
            # 设置冷却期
            cool_down = rule.cool_down_s if rule else self.DEFAULT_COOLDOWN
            redis_client.setex(cache_key, cool_down, "1")
            
            # 更新告警规则的最后触发时间
            if rule:
                rule.last_fired = datetime.utcnow()
                try:
                    db.session.commit()
                except Exception as e:
                    logger.error(f"✗ 更新告警规则失败: {e}")
                    db.session.rollback()
            
            # 记录审计日志
            try:
                audit_log = AuditLog(
                    username='system',
                    action='ALERT_TRIGGERED',
                    resource_type='Server',
                    resource_id=str(server.id),
                    success=True,
                    endpoint='/scheduler/alert',
                    status_code=200,
                )
                db.session.add(audit_log)
                db.session.commit()
            except Exception as e:
                logger.warning(f"⚠️ 审计日志记录失败: {e}")
                db.session.rollback()
        
        return success
    
    def send_manual_alert(self, message: str) -> bool:
        """手动发送告警消息"""
        return self.notifier.send_message(message)
    
    def get_alert_status(self, server_id: int, alert_type: str) -> dict:
        """获取告警状态"""
        cache_key = f"vps:alert:{server_id}:{alert_type}"
        in_cooldown = redis_client.exists(cache_key)
        
        rule = AlertRule.query.filter_by(
            server_id=server_id,
            rule_type=alert_type
        ).first()
        
        if not rule:
            rule = AlertRule.query.filter_by(
                server_id=None,
                rule_type=alert_type
            ).first()
        
        return {
            'alert_type': alert_type,
            'in_cooldown': bool(in_cooldown),
            'enabled': rule.enabled if rule else True,
            'threshold': rule.threshold if rule else self.DEFAULT_THRESHOLDS.get(alert_type),
            'last_fired': rule.last_fired.isoformat() if rule and rule.last_fired else None,
        }


# 全局实例
alert_service = AlertService()
