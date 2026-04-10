# backend/middleware/login_guard.py - 新文件

"""
登录安全保护中间件
- 防暴力破解（登录尝试限制）
- 异常地点检测
- 审计记录
- 账户锁定机制
"""
import logging
from datetime import datetime, timedelta
import extensions
from extensions import db
from models.models import AuditLog
from utils.errors import AuthenticationError

logger = logging.getLogger(__name__)

class LoginGuard:
    """登录安全守卫"""
    
    # 用户名锁定配置
    MAX_ATTEMPTS = 5          # 最大尝试次数
    LOCKOUT_DURATION = 900    # 锁定时长（秒）= 15分钟
    ATTEMPT_WINDOW = 300      # 时间窗口（秒）= 5分钟

    # IP 锁定配置
    MAX_IP_ATTEMPTS = 20      # IP 最大失败次数
    IP_LOCKOUT_DURATION = 1800  # IP 锁定时长（秒）= 30分钟
    IP_ATTEMPT_WINDOW = 300   # IP 时间窗口（秒）= 5分钟
    
    @staticmethod
    def get_client_fingerprint(request) -> str:
        """获取客户端指纹（用于异常检测）"""
        user_agent = request.user_agent.string or 'unknown'
        ip = request.remote_addr or 'unknown'
        return f"{ip}:{user_agent[:50]}"
    
    @staticmethod
    def is_account_locked(username: str) -> tuple:
        """检查账户是否被锁定"""
        lock_key = f"login:lock:{username}"
        remaining = extensions.redis_client.ttl(lock_key)
        
        if remaining > 0:
            return True, remaining
        return False, 0

    @staticmethod
    def is_ip_locked(ip_address: str) -> tuple:
        """检查 IP 是否被锁定"""
        lock_key = f"login:ip_lock:{ip_address}"
        remaining = extensions.redis_client.ttl(lock_key)
        if remaining > 0:
            return True, remaining
        return False, 0

    @staticmethod
    def _lock_ip(ip_address: str):
        """锁定 IP"""
        lock_key = f"login:ip_lock:{ip_address}"
        extensions.redis_client.setex(lock_key, LoginGuard.IP_LOCKOUT_DURATION, "1")
    
    @staticmethod
    def record_login_attempt(username: str, success: bool, ip_address: str, 
                            user_agent: str, request_obj) -> dict:
        """记录登录尝试"""
        attempt_key = f"login:attempts:{username}"
        current = 0  # 确保任何代码路径都有定义

        if not success:
            # 记录用户名失败尝试
            current = extensions.redis_client.incr(attempt_key)
            extensions.redis_client.expire(attempt_key, LoginGuard.ATTEMPT_WINDOW)
            
            logger.warning(f"❌ 登录失败: {username} (尝试 {current}/{LoginGuard.MAX_ATTEMPTS})")
            
            # 检查用户名是否超过限制
            if current >= LoginGuard.MAX_ATTEMPTS:
                LoginGuard._lock_account(username)
                logger.critical(f"🔒 账户已锁定: {username}")

            # 记录 IP 失败尝试
            if ip_address:
                ip_attempt_key = f"login:ip_attempts:{ip_address}"
                ip_current = extensions.redis_client.incr(ip_attempt_key)
                extensions.redis_client.expire(ip_attempt_key, LoginGuard.IP_ATTEMPT_WINDOW)
                if ip_current >= LoginGuard.MAX_IP_ATTEMPTS:
                    LoginGuard._lock_ip(ip_address)
                    logger.critical(f"🔒 IP 已锁定: {ip_address}")
        else:
            # 登录成功，清除用户名尝试计数
            extensions.redis_client.delete(attempt_key)
            logger.info(f"✅ 登录成功: {username}")
        
        # 记录审计日志
        try:
            audit_log = AuditLog(
                username=username,
                action='LOGIN_ATTEMPT',
                resource_type='User',
                resource_id=username,
                method='POST',
                endpoint='/api/auth/login',
                status_code=200 if success else 401,
                success=success,
                ip_address=ip_address,
                user_agent=user_agent[:255],
            )
            db.session.add(audit_log)
            db.session.commit()
        except Exception as e:
            logger.warning(f"⚠️ 审计日志记录失败: {e}")
            db.session.rollback()
        
        return {
            'success': success,
            'attempts': current if not success else 0,
            'locked': False,
        }
    
    @staticmethod
    def _lock_account(username: str):
        """锁定账户"""
        lock_key = f"login:lock:{username}"
        extensions.redis_client.setex(lock_key, LoginGuard.LOCKOUT_DURATION, "1")
        
        # 记录审计日志
        try:
            audit_log = AuditLog(
                username=username,
                action='ACCOUNT_LOCKED',
                resource_type='User',
                resource_id=username,
                status_code=403,
                success=False,
                error_message=f"Account locked after {LoginGuard.MAX_ATTEMPTS} failed attempts",
            )
            db.session.add(audit_log)
            db.session.commit()
        except Exception as e:
            logger.warning(f"⚠️ 审计日志记录失败: {e}")
            db.session.rollback()
    
    @staticmethod
    def check_login_allowed(username: str, ip_address: str = None):
        """检查是否允许登录（用户名锁定 + IP 锁定）"""
        locked, remaining = LoginGuard.is_account_locked(username)
        if locked:
            exc = AuthenticationError(
                f"账户已被锁定，请在 {remaining} 秒后重试"
            )
            exc.retry_after = remaining
            raise exc

        if ip_address:
            ip_locked, ip_remaining = LoginGuard.is_ip_locked(ip_address)
            if ip_locked:
                exc = AuthenticationError(
                    f"IP 访问已被限制，请在 {ip_remaining} 秒后重试"
                )
                exc.retry_after = ip_remaining
                raise exc
