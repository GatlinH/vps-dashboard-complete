# backend/middleware/retry_handler.py - 新文件

"""
重试机制和熔断器实现
"""
import logging
import time
from functools import wraps
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

class RetryConfig:
    """重试配置"""
    MAX_RETRIES = 3
    BACKOFF_FACTOR = 2  # 指数退避
    BASE_DELAY = 0.1  # 秒

def retry_on_exception(exceptions=(Exception,), max_retries=3, backoff=True):
    """重试装饰器"""
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            retries = 0
            delay = RetryConfig.BASE_DELAY
            
            while retries < max_retries:
                try:
                    return func(*args, **kwargs)
                except exceptions as e:
                    retries += 1
                    if retries >= max_retries:
                        logger.error(f"❌ {func.__name__} 失败，已达最大重试次数: {e}")
                        raise
                    
                    if backoff:
                        delay = delay * RetryConfig.BACKOFF_FACTOR
                    
                    logger.warning(
                        f"⚠️ {func.__name__} 失败 (尝试 {retries}/{max_retries}), "
                        f"{delay:.1f}s 后重试: {e}"
                    )
                    time.sleep(delay)
        
        return wrapper
    return decorator


class CircuitBreaker:
    """熔断器"""
    
    def __init__(self, failure_threshold=5, timeout=60):
        self.failure_threshold = failure_threshold
        self.timeout = timeout
        self.failures = 0
        self.last_failure_time = None
        self.state = 'closed'  # closed, open, half-open
    
    def call(self, func, *args, **kwargs):
        """执行函数调用"""
        if self.state == 'open':
            # 检查是否可以切换到 half-open
            if self._should_attempt_reset():
                self.state = 'half-open'
            else:
                raise Exception(f"熔断器打开，服务暂时不可用")
        
        try:
            result = func(*args, **kwargs)
            self._on_success()
            return result
        except Exception as e:
            self._on_failure()
            raise
    
    def _on_success(self):
        """成功处理"""
        self.failures = 0
        self.state = 'closed'
    
    def _on_failure(self):
        """失败处理"""
        self.failures += 1
        self.last_failure_time = datetime.utcnow()
        if self.failures >= self.failure_threshold:
            self.state = 'open'
            logger.critical(f"🔥 熔断器打开！")
    
    def _should_attempt_reset(self) -> bool:
        """检查是否应该尝试重置"""
        if self.last_failure_time is None:
            return False
        return (datetime.utcnow() - self.last_failure_time).seconds >= self.timeout


# 使用示例
@retry_on_exception(exceptions=(ConnectionError, TimeoutError), max_retries=3)
def fetch_from_external_api(url):
    """从外部 API 获取数据（带重试）"""
    import requests
    return requests.get(url, timeout=5)
