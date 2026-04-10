# backend/middleware/rate_limit.py - 新建文件

from flask import Flask, request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_limiter.errors import RateLimitExceeded
import json

class RateLimitConfig:
    """速率限制配置"""
    
    @staticmethod
    def init_app(app: Flask):
        """初始化速率限制"""
        
        limiter = Limiter(
            app=app,
            key_func=get_remote_address,
            default_limits=[
                "200 per minute"
            ],
            storage_uri=app.config.get('REDIS_URL'),
            strategy="fixed-window",
            swallow_errors=True,  # 在 Redis 故障时不中断
        )
        
        # 自定义错误处理
        @app.errorhandler(RateLimitExceeded)
        def handle_rate_limit_exceeded(error):
            return {
                'success': False,
                'error_code': 'RATE_LIMIT_EXCEEDED',
                'message': '请求过于频繁，请稍后再试',
                'retry_after': error.get_retry_after() if hasattr(error, 'get_retry_after') else 60,
            }, 429
        
        return limiter


# 在各个 API 端点应用限制
from flask_limiter import Limiter

def get_limiter():
    """获取全局 limiter 实例"""
    from flask import current_app
    return current_app.limiter

# 预定义限速级别常量（供各蓝图通过 app.limiter.limit() 装饰器使用）
LOGIN_LIMIT = "10 per minute"    # 登录接口：严格防暴力破解
PING_LIMIT  = "5 per minute"     # Probe ping：防 TCP 探测滥用
WRITE_LIMIT = "30 per minute"    # 写操作（POST/PUT/DELETE）
READ_LIMIT  = "200 per minute"   # 只读接口
