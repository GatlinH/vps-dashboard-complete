from flask import Flask, request
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from flask_limiter.errors import RateLimitExceeded
from flask_jwt_extended import get_jwt_identity, verify_jwt_in_request
import logging
from urllib.parse import urlparse

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
    def _is_valid_storage_uri(storage_uri: str) -> bool:
        """验证 limiter storage URI，避免空串/非法 URI 导致连接异常。"""
        if not storage_uri or not isinstance(storage_uri, str):
            return False
        raw = storage_uri.strip()
        if not raw:
            return False

        parsed = urlparse(raw)
        if parsed.scheme == "memory":
            return True
        if parsed.scheme in {"redis", "rediss"}:
            # redis URI 至少要有 hostname。port 可缺省（redis-py 会用默认端口）
            return bool(parsed.hostname)
        return False

    @staticmethod
    def _resolve_storage_uri(app: Flask) -> str:
        """
        解析 limiter 存储地址：
        1) 显式 RATELIMIT_STORAGE_URI / RATELIMIT_STORAGE_URL
        2) 测试环境默认 memory://（避免 CI 对外部 Redis 的硬依赖）
        3) 回退 REDIS_URL
        4) 最终回退 memory://
        """
        explicit_uri = (
            app.config.get("RATELIMIT_STORAGE_URI")
            or app.config.get("RATELIMIT_STORAGE_URL")
        )
        if RateLimitConfig._is_valid_storage_uri(explicit_uri):
            return explicit_uri.strip()

        if app.config.get("TESTING"):
            return "memory://"

        redis_uri = app.config.get("REDIS_URL")
        if RateLimitConfig._is_valid_storage_uri(redis_uri):
            return redis_uri.strip()

        if explicit_uri or redis_uri:
            log.warning(
                "Invalid rate limit storage uri detected. "
                "RATELIMIT_STORAGE_URI=%r REDIS_URL=%r. Fallback to memory://",
                explicit_uri,
                redis_uri,
            )
        return "memory://"

    @staticmethod
    def init_app(app: Flask):
        """初始化速率限制"""

        # 测试环境默认关闭限流，避免共享测试客户端时被 /auth/login 限流“误伤”其它用例。
        # 如需在测试中开启限流，可显式设置 RATELIMIT_ENABLED=True。
        if app.config.get("TESTING") and "RATELIMIT_ENABLED" not in app.config:
            app.config["RATELIMIT_ENABLED"] = False

        storage_uri = RateLimitConfig._resolve_storage_uri(app)

        # 将 limiter 与 app 绑定（兼容不同 flask-limiter 版本）
        app.config["RATELIMIT_STORAGE_URI"] = storage_uri
        configured_enabled = bool(app.config.get("RATELIMIT_ENABLED", True))

        # flask-limiter 在 init_app 时若检测到禁用，可能不会完整注册 request hook。
        # 这里先以 enabled=True 完成初始化，再回写实际开关，允许测试在运行时切换。 
        if not configured_enabled:
            app.config["RATELIMIT_ENABLED"] = True
        try:
            try:
                limiter.init_app(app, storage_uri=storage_uri)
            except TypeError:
                limiter.init_app(app)
        finally:
            app.config["RATELIMIT_ENABLED"] = configured_enabled

        def _sync_limiter_enabled_state():
            """同步运行时配置变更到 limiter.enabled。"""
            limiter.enabled = bool(app.config.get("RATELIMIT_ENABLED", True))

        _sync_limiter_enabled_state()

        @app.before_request
        def _apply_runtime_rate_limit_toggle():
            _sync_limiter_enabled_state()

        # 确保该同步钩子先于 flask-limiter 的 before_request 执行。
        # 否则当测试/运行时动态切换 RATELIMIT_ENABLED 时，当前请求可能仍沿用旧状态。
        before_request_funcs = app.before_request_funcs.setdefault(None, [])
        if before_request_funcs and before_request_funcs[-1] is _apply_runtime_rate_limit_toggle:
            before_request_funcs.insert(0, before_request_funcs.pop())

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
LOGIN_LIMIT = "10 per minute"    # ���录接口：严格防暴力破解
PING_LIMIT  = "5 per minute"     # Probe ping：防 TCP 探测滥用
WRITE_LIMIT = "30 per minute"    # 写操作（POST/PUT/DELETE）
READ_LIMIT  = "200 per minute"   # 只读接口
