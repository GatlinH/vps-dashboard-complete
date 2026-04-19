"""
backend/services/observability
可观测性模块：Sentry 错误聚合 + Prometheus 指标 + 结构化日志

在 Flask app factory 中调用：
    from services.observability import init_observability
    init_observability(app)
"""

from .sentry import init_sentry, capture_business_event, capture_exception


def init_observability(app) -> None:
    """
    一站式初始化所有可观测性组件：
      1. Sentry（错误聚合 + 性能追踪）
      2. 结构化日志（logging_config，含 request_id 注入）
      3. Prometheus metrics 中间件（metrics_middleware）
    """
    # 1. 结构化日志
    from utils.logging_config import setup_logging
    setup_logging(app)

    # 2. Sentry
    init_sentry(app)

    # 3. Prometheus metrics
    from middleware.metrics_middleware import init_metrics
    init_metrics(app)


__all__ = [
    "init_observability",
    "init_sentry",
    "capture_business_event",
    "capture_exception",
]
