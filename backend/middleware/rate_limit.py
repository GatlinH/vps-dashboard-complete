from flask import Flask, request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_limiter.errors import RateLimitExceeded
from flask_jwt_extended import get_jwt_identity, verify_jwt_in_request
import logging

log = logging.getLogger(__name__)

def _resolve_user_rate_limit_key(user_identity):
    """将 JWT identity 规范化为可读且稳定的 user key 片段。"""
    if user_identity is None:
        return None

    if isinstance(user_identity, dict):
        for field in ("user_id", "id", "sub", "uid"):
            value = user_identity.get(field)
            if value is not None:
                return str(value)
        return None

    return str(user_identity)


def custom_key_func():
    """
    自定义限流键：
    1. 如果请求携带了有效的 JWT token，则按 User ID 限流
    2. 否则，降级按 IP 限流
    """
    try:
        # 尝试在不强制要求 token 的情况下验证 JWT
        # 这样不会拦截非登录接口，但能获取到已登录用户的身份
        verify_jwt_in_request(optional=True)
        user_identity = _resolve_user_rate_limit_key(get_jwt_identity())
        if user_identity:
            return f"user:{user_identity}"
    except Exception:
        # 捕获 Token 过期、未携带等异常，直接吃掉并走 IP 降级
        pass
    
    # 降级：基于 IP 限流
    return f"ip:{get_remote_address()}"


# 全局 limiter 实例，方便在各个蓝图中直接导入：from middleware.rate_limit import limiter
limiter = Limiter(
    key_func=custom_key_func,
    default_limits=["200 per minute"],
    strategy="fixed-window",
    swallow_errors=True,  # 在 Redis 故障时不中断业务
)

class RateLimitConfig:
    """速率限制配置"""
    
    @staticmethod
    def init_app(app: Flask):
        """初始化速率限制"""
        
        # 验证 Redis 配置，若无配置则使用内存存储（如测试环境）
        storage_uri = app.config.get('REDIS_URL', 'memory://')
        
        # 将 limiter 与 app 绑定（兼容不同 flask-limiter 版本）
        app.config.setdefault("RATELIMIT_STORAGE_URI", storage_uri)
        try:
            limiter.init_app(app, storage_uri=storage_uri)
        except TypeError:
            limiter.init_app(app)
        app.limiter = limiter
        
        # 自定义全局限流错误处理
        @app.errorhandler(RateLimitExceeded)
        def handle_rate_limit_exceeded(error):
            log.warning(f"Rate limit exceeded: {request.remote_addr} - {request.path}")
            return {
                'success': False,
                'error_code': 'RATE_LIMIT_EXCEEDED',
                'message': '请求过于频繁，请稍后再试',
                # 尝试从 error 获取描述，提取需要的等待时间，默认给 60s
                'retry_after': getattr(error.description, 'retry_after', 60), 
            }, 429
        
        log.info(f"Rate limiting initialized. Storage: {storage_uri}")
        return limiter


# 预定义限速级别常量（供各蓝图通过 @limiter.limit(LIMIT) 装饰器使用）
LOGIN_LIMIT = "10 per minute"    # 登录接口：严格防暴力破解
PING_LIMIT  = "5 per minute"     # Probe ping：防 TCP 探测滥用
WRITE_LIMIT = "30 per minute"    # 写操作（POST/PUT/DELETE）
READ_LIMIT  = "200 per minute"   # 只读接口
