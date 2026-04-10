# backend/services/alert_service.py - 完整版本
# 告警服务：检测、推送、升级、恢复通知

"""
告警服务（完整版）
功能：
  - CPU/内存/磁盘告警检测
  - 离线和过期告警
  - Telegram 推送
  - 告警冷却机制
  - 告警升级处理
  - 恢复通知
  - 手动 Mute/UnMute
"""

import logging
import requests
from datetime import datetime, timezone, timedelta
from typing import Optional, Dict
from extensions import db, redis_client
from models.models import Server, AlertRule, TelegramConfig, AuditLog

logger = logging.getLogger(__name__)

# ===== 常量定义 =====

class AlertConfig:
    """告警配置"""
    # 阈值
    CPU_THRESHOLD = 90
    RAM_THRESHOLD = 90
    DISK_THRESHOLD = 85
    
    # 冷却时间（秒）
    DEFAULT_COOLDOWN = 1800  # 30 分钟
    OFFLINE_COOLDOWN = 300  # 5 分钟
    
    # 告警升级
    ESCALATION_THRESHOLD = 3  # 3 次触发后升级
    ESCALATION_COOLDOWN = 3600  # 升级冷却 1 小时

# ===== Telegram 通知器 =====

class TelegramNotifier:
    """Telegram 通知器"""
    
    API_URL = "https://api.telegram.org/bot{token}/{method}"
    
    def __init__(self, config: Optional[TelegramConfig] = None):
        """初始化 Telegram 通知器"""
        self.config = config
        self.enabled = config and config.enabled and config.bot_token and config.chat_id
    
    def send_message(self, message: str, parse_mode: str = 'HTML',
                    disable_preview: bool = True) -> tuple:
        """
        发送 Telegram 消息
        
        返回：
          (success: bool, response: dict)
        """
        if not self.enabled:
            logger.warning("⚠️ Telegram 未启用或配置不完整")
            return False, {"error": "Telegram 未启用"}
        
        try:
            url = self.API_URL.format(
                token=self.config.bot_token,
                method='sendMessage'
            )
            
            payload = {
                'chat_id': self.config.chat_id,
                'text': f"{self.config.prefix}\n\n{message}",
                'parse_mode': parse_mode,
                'disable_web_page_preview': disable_preview,
            }
            
            response = requests.post(
                url,
                json=payload,
                timeout=8,
                headers={'User-Agent': 'VPS-Dashboard/1.0'}
            )
            
            result = response.json()
            
            if result.get('ok'):
                logger.info(f"✅ Telegram 消息已发送")
                return True, result
            else:
                error_msg = result.get('description', 'Unknown error')
                logger.error(f"❌ Telegram 发送失败: {error_msg}")
                return False, result
        
        except requests.exceptions.Timeout:
            logger.error("❌ Telegram 请求超时")
            return False, {"error": "timeout"}
        except requests.exceptions.RequestException as e:
            logger.error(f"❌ Telegram 请求异常: {e}")
            return False, {"error": str(e)}
        except Exception as e:
            logger.error(f"❌ Telegram 异常: {e}")
            return False, {"error": str(e)}

# ===== 告警服务 =====

class AlertService:
    """告警服务"""
    
    def __init__(self):
        """初始化告警服务"""
        self.notifier = None
        self.reload_config()
    
    def reload_config(self):
        """重新加载配置"""
        try:
            config = TelegramConfig.query.first()
            self.notifier = TelegramNotifier(config)
            logger.info("✓ 告警服务已初始化")
        except Exception as e:
            logger.error(f"❌ 加载告警配置失败: {e}")
            self.notifier = TelegramNotifier(None)
    
    # ===== 主告警检查方法 =====
    
    def check_and_alert(self):
        """
        定期检查所有告警规则并发送通知
        由 APScheduler 每 5 分钟调用一次
        """
        try:
            logger.info("🔔 开始检查告警规则...")
            
            servers = Server.query.all()
            alert_count = 0
            
            for server in servers:
                # ① CPU 告警
                if server.cpu_use is not None and server.cpu_use > AlertConfig.CPU_THRESHOLD:
                    if self._trigger_alert(
                        server, 'CPU_HIGH',
                        f"🔴 <b>CPU 告警</b>\n"
                        f"服务器：{server.name}\n"
                        f"CPU 使用率：<b>{server.cpu_use}%</b>\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}"
                    ):
                        alert_count += 1
                
                # ② 内存告警
                if server.ram_use is not None and server.ram_use > AlertConfig.RAM_THRESHOLD:
                    if self._trigger_alert(
                        server, 'RAM_HIGH',
                        f"⚠️ <b>内存告警</b>\n"
                        f"服务器：{server.name}\n"
                        f"内存使用率：<b>{server.ram_use}%</b>\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}"
                    ):
                        alert_count += 1
                
                # ③ 磁盘告警
                if server.disk_use is not None and server.disk_use > AlertConfig.DISK_THRESHOLD:
                    if self._trigger_alert(
                        server, 'DISK_HIGH',
                        f"💾 <b>磁盘告警</b>\n"
                        f"服务器：{server.name}\n"
                        f"磁盘使用率：<b>{server.disk_use}%</b>\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}"
                    ):
                        alert_count += 1
                
                # ④ 离线告警
                if server.status == 'offline':
                    if self._trigger_alert(
                        server, 'OFFLINE',
                        f"💔 <b>服务器离线</b>\n"
                        f"服务器：{server.name}\n"
                        f"IP：{server.ip}\n"
                        f"位置：{server.location}\n"
                        f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}",
                        cooldown=AlertConfig.OFFLINE_COOLDOWN
                    ):
                        alert_count += 1
                
                # ⑤ 即将过期告警
                if server.expiry:
                    days_left = (server.expiry - datetime.now().date()).days
                    if 0 < days_left <= 7:
                        if self._trigger_alert(
                            server, 'EXPIRY_SOON',
                            f"📅 <b>服务器即将过期</b>\n"
                            f"服务器：{server.name}\n"
                            f"剩余时间：<b>{days_left} 天</b>\n"
                            f"过期日期：{server.expiry}\n"
                            f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}"
                        ):
                            alert_count += 1
                
                # ⑥ 已过期告警
                elif server.expiry and server.expiry < datetime.now().date():
                    if self._trigger_alert(
                        server, 'EXPIRED',
                        f"💀 <b>服务器已过期</b>\n"
                        f"服务器：{server.name}\n"
                        f"过期日期：{server.expiry}\n"
                        f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}"
                    ):
                        alert_count += 1
                
                # ⑦ 检查恢复状态
                self._check_recovery_status(server)
            
            logger.info(f"✓ 告警检查完成，共触发 {alert_count} 个告警")
        
        except Exception as e:
            logger.error(f"❌ 告警检查异常: {e}", exc_info=True)
    
    # ===== 内部方法 =====
    
    def _trigger_alert(self, server: Server, alert_type: str, message: str,
                      cooldown: Optional[int] = None) -> bool:
        """
        触发告警（考虑冷却和升级）
        
        返回：
          True 表示告警已发送，False 表示被冷却期忽略
        """
        if cooldown is None:
            cooldown = AlertConfig.DEFAULT_COOLDOWN
        
        # ① 检查 Mute 状态
        mute_key = f"vps:alert:muted:{server.id}:{alert_type}"
        if redis_client.exists(mute_key):
            logger.debug(f"⏸ 告警已 Mute: {server.name} - {alert_type}")
            return False
        
        # ② 检查冷却期
        cache_key = f"vps:alert:{server.id}:{alert_type}"
        if redis_client.exists(cache_key):
            logger.debug(f"⏳ 告警在冷却期: {server.name} - {alert_type}")
            return False
        
        # ③ 获取告警规则
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
        
        # ④ 检查规则是否启用
        if rule and not rule.enabled:
            logger.debug(f"🔇 告警规则已禁用: {server.name} - {alert_type}")
            return False
        
        # ⑤ 检查升级条件
        count_key = f"vps:alert:count:{server.id}:{alert_type}"
        current_count = int(redis_client.get(count_key) or 0)
        current_count += 1
        redis_client.setex(count_key, 3600, current_count)  # 计数保留 1 小时
        
        if current_count >= AlertConfig.ESCALATION_THRESHOLD:
            message = (
                f"⬆️ <b>【告警升级】{alert_type}</b>\n"
                f"（已连续触发 {current_count} 次）\n\n" +
                message
            )
            logger.warning(f"🚨 告警升级: {server.id} - {alert_type} (第 {current_count} 次)")
        
        # ⑥ 发送告警
        success, response = self.notifier.send_message(message)
        
        if not success:
            logger.error(f"❌ 告警推送失败: {response}")
            # 推送失败时仍然设置冷却期，避免重复推送
        
        # ⑦ 设置冷却期
        redis_client.setex(cache_key, cooldown, "1")
        
        # ⑧ 更新规则的最后触发时间
        if rule:
            try:
                rule.last_fired = datetime.now(timezone.utc)
                db.session.commit()
            except Exception as e:
                logger.warning(f"⚠️ 更新告警规则失败: {e}")
                db.session.rollback()
        
        # ⑨ 记录审计日志
        self._record_alert_audit(server, alert_type, success)
        
        return success
    
    def _check_recovery_status(self, server: Server):
        """
        检查服务器是否恢复（发送恢复通知）
        """
        try:
            recovery_key = f"vps:recovery_notified:{server.id}"
            
            # 检查是否已通知恢复
            if redis_client.exists(recovery_key):
                return
            
            # 检查恢复条件（所有指标正常）
            if (server.status == 'online' and
                server.cpu_use is not None and server.cpu_use < 80 and
                server.ram_use is not None and server.ram_use < 80 and
                server.disk_use is not None and server.disk_use < 80):
                
                # 检查是否之前有过告警
                alert_count = 0
                for alert_type in ['CPU_HIGH', 'RAM_HIGH', 'DISK_HIGH', 'OFFLINE']:
                    count_key = f"vps:alert:count:{server.id}:{alert_type}"
                    count = int(redis_client.get(count_key) or 0)
                    if count > 0:
                        alert_count += 1
                
                # 如果之前有告警，现在恢复了，发送恢复通知
                if alert_count > 0:
                    recovery_message = (
                        f"✅ <b>服务器已恢复</b>\n"
                        f"服务器：{server.name}\n"
                        f"状态：{server.status}\n"
                        f"CPU：{server.cpu_use}%\n"
                        f"内存：{server.ram_use}%\n"
                        f"磁盘：{server.disk_use}%\n"
                        f"时间：{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                    
                    success, _ = self.notifier.send_message(recovery_message)
                    
                    if success:
                        # 标记已通知恢复
                        redis_client.setex(recovery_key, 3600, "1")
                        logger.info(f"✓ 恢复通知已发送: {server.name}")
                        
                        # 清除告警计数
                        for alert_type in ['CPU_HIGH', 'RAM_HIGH', 'DISK_HIGH', 'OFFLINE']:
                            count_key = f"vps:alert:count:{server.id}:{alert_type}"
                            redis_client.delete(count_key)
        
        except Exception as e:
            logger.warning(f"⚠️ 恢复检查异常: {e}")
    
    def _record_alert_audit(self, server: Server, alert_type: str, success: bool):
        """记录告警审计日志"""
        try:
            audit_log = AuditLog(
                username='system',
                action='ALERT_TRIGGERED',
                resource_type='Server',
                resource_id=str(server.id),
                success=success,
                endpoint='/scheduler/alert',
                status_code=200 if success else 502,
                error_message=f"Alert Type: {alert_type}" if not success else None,
            )
            db.session.add(audit_log)
            db.session.commit()
        except Exception as e:
            logger.warning(f"⚠️ 审计日志记录失败: {e}")
            db.session.rollback()
    
    # ===== 公共接口方法 =====
    
    def send_manual_alert(self, message: str) -> tuple:
        """
        手动发送告警消息
        
        返回：
          (success: bool, response: dict)
        """
        return self.notifier.send_message(message)
    
    def mute_alert(self, server_id: int, alert_type: str, duration: int = 3600) -> bool:
        """
        Mute 告警（指定时间内不发送该告警）
        
        参数：
          server_id: 服务器 ID
          alert_type: 告警类型
          duration: Mute 时长（秒）
        
        返回：
          True 表示成功
        """
        try:
            mute_key = f"vps:alert:muted:{server_id}:{alert_type}"
            redis_client.setex(mute_key, duration, "1")
            logger.info(f"✓ 告警已 Mute: Server {server_id} - {alert_type} ({duration}s)")
            return True
        except Exception as e:
            logger.error(f"❌ Mute 告警失败: {e}")
            return False
    
    def unmute_alert(self, server_id: int, alert_type: str) -> bool:
        """
        取消 Mute 告警
        
        返回：
          True 表示成功
        """
        try:
            mute_key = f"vps:alert:muted:{server_id}:{alert_type}"
            redis_client.delete(mute_key)
            logger.info(f"✓ 告警已取消 Mute: Server {server_id} - {alert_type}")
            return True
        except Exception as e:
            logger.error(f"❌ UnMute 告警失败: {e}")
            return False
    
    def get_alert_status(self, server_id: int) -> Dict:
        """
        获取服务器的完整告警状态
        
        返回：
          {
            'CPU_HIGH': {'count': 2, 'muted': False, 'escalated': True},
            'RAM_HIGH': {'count': 0, 'muted': False, 'escalated': False},
            ...
          }
        """
        try:
            alert_types = ['CPU_HIGH', 'RAM_HIGH', 'DISK_HIGH', 'OFFLINE', 'EXPIRY_SOON', 'EXPIRED']
            status = {}
            
            for alert_type in alert_types:
                count_key = f"vps:alert:count:{server_id}:{alert_type}"
                mute_key = f"vps:alert:muted:{server_id}:{alert_type}"
                
                count = int(redis_client.get(count_key) or 0)
                
                status[alert_type] = {
                    'count': count,
                    'muted': redis_client.exists(mute_key),
                    'escalated': count >= AlertConfig.ESCALATION_THRESHOLD,
                }
            
            return status
        
        except Exception as e:
            logger.error(f"❌ 获取告警状态失败: {e}")
            return {}
    
    def reset_alert_count(self, server_id: int, alert_type: Optional[str] = None) -> bool:
        """
        重置告警计数
        
        参数：
          server_id: 服务器 ID
          alert_type: 告警类型（None=重置所有）
        
        返回：
          True 表示成功
        """
        try:
            if alert_type:
                # 重置单个告警类型
                count_key = f"vps:alert:count:{server_id}:{alert_type}"
                redis_client.delete(count_key)
                logger.info(f"✓ 告警计数已重置: Server {server_id} - {alert_type}")
            else:
                # 重置所有告警类型
                alert_types = ['CPU_HIGH', 'RAM_HIGH', 'DISK_HIGH', 'OFFLINE', 'EXPIRY_SOON', 'EXPIRED']
                for at in alert_types:
                    count_key = f"vps:alert:count:{server_id}:{at}"
                    redis_client.delete(count_key)
                logger.info(f"✓ 所有告警计数已重置: Server {server_id}")
            
            return True
        
        except Exception as e:
            logger.error(f"❌ 重置告警计数失败: {e}")
            return False


# ===== 全局实例 =====

alert_service = AlertService()
