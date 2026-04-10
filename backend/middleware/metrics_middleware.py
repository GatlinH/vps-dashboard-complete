# backend/middleware/metrics_middleware.py
"""
Prometheus 指标中间件 — 注册请求钩子并挂载 /metrics 端点
"""
import time
from flask import Flask, request
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST
from utils.metrics import api_request_count, api_request_duration


def init_metrics(app: Flask):
    """初始化 Prometheus 指标中间件，注册请求钩子并挂载 /metrics 端点"""

    @app.before_request
    def _metrics_before():
        request._metrics_start = time.time()

    @app.after_request
    def _metrics_after(response):
        start = getattr(request, '_metrics_start', None)
        if start is not None:
            duration = time.time() - start
            method = request.method
            endpoint = request.endpoint or 'unknown'
            status = response.status_code
            try:
                api_request_count.labels(
                    method=method, endpoint=endpoint, status=status
                ).inc()
                api_request_duration.labels(
                    method=method, endpoint=endpoint
                ).observe(duration)
            except Exception:
                pass
        return response

    @app.route('/metrics')
    def metrics():
        """Prometheus 指标端点（供 Prometheus Server 抓取）"""
        return generate_latest(), 200, {'Content-Type': CONTENT_TYPE_LATEST}
