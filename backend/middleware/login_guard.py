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
from extensions import redis_client, db
from models.models import AuditLog
from utils.errors import AuthenticationError

logger = logging.getLogger(__name__)

class LoginGuard:
    """登录安全守卫"""
    
    # 配置常数
    MAX_ATTEMPTS = 5          # 最大尝试次数
    LOCKOUT_DURATION = 900    # 锁定时长（秒）= 15分钟
    ATTEMPT_WINDOW = 300      # 时间窗口（秒）= 5分钟
    
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
        remaining = redis_client.ttl(lock_key)
        
        if remaining > 0:
            return True, remaining
        return False, 0
    
    @staticmethod
    def record_login_attempt(username: str, success: bool, ip_address: str, 
                            user_agent: str, request_obj) -> dict:
        """记录登录尝试"""
        attempt_key = f"login:attempts:{username}"
        # Default is 0 — on successful login the counter is deleted from Redis,
        # so the effective count is 0. This is set explicitly here to prevent a
        # potential NameError if the if/else branches were ever restructured.
        current = 0
        
        if not success:
            # 记录失败尝试
            current = redis_client.incr(attempt_key)
            redis_client.expire(attempt_key, LoginGuard.ATTEMPT_WINDOW)
            
            logger.warning(f"❌ 登录失败: {username} (尝试 {current}/{LoginGuard.MAX_ATTEMPTS})")
            
            # 检查是否超过限制
            if current >= LoginGuard.MAX_ATTEMPTS:
                LoginGuard._lock_account(username)
                logger.critical(f"🔒 账户已锁定: {username}")
        else:
            # 登录成功，清除尝试计数
            redis_client.delete(attempt_key)
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
            'attempts': current,
            'locked': False,
        }
    
    @staticmethod
    def _lock_account(username: str):
        """锁定账户"""
        lock_key = f"login:lock:{username}"
        redis_client.setex(lock_key, LoginGuard.LOCKOUT_DURATION, "1")
        
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
    def check_login_allowed(username: str):
        """检查是否允许登录"""
        locked, remaining = LoginGuard.is_account_locked(username)
        if locked:
            raise AuthenticationError(
                f"账户已被锁定，请在 {remaining} 秒后重试"
            )
