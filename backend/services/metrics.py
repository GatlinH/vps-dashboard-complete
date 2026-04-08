# backend/services/metrics.py - 完整版本

"""
Prometheus 兼容的性能指标收集
"""
from prometheus_client import Counter, Histogram, Gauge, generate_latest
from flask import Blueprint
import time

metrics_bp = Blueprint('metrics', __name__)

# 定义指标
request_count = Counter(
    'vps_requests_total',
    'Total HTTP requests',
    ['method', 'endpoint', 'status']
)

request_duration = Histogram(
    'vps_request_duration_seconds',
    'HTTP request duration',
    ['method', 'endpoint'],
    buckets=(0.01, 0.05, 0.1, 0.5, 1.0, 2.5, 5.0)
)

active_connections = Gauge(
    'vps_active_connections',
    'Number of active connections'
)

database_queries = Counter(
    'vps_database_queries_total',
    'Total database queries',
    ['operation', 'table']
)

cache_hits = Counter(
    'vps_cache_hits_total',
    'Cache hits',
    ['cache_type']
)

cache_misses = Counter(
    'vps_cache_misses_total',
    'Cache misses',
    ['cache_type']
)

alert_count = Counter(
    'vps_alerts_total',
    'Total alerts triggered',
    ['alert_type', 'status']
)

# Middleware 集成
def init_metrics(app):
    """初始化指标收集"""
    
    @app.before_request
    def before_request():
        request.start_time = time.time()
        active_connections.inc()
    
    @app.after_request
    def after_request(response):
        if hasattr(request, 'start_time'):
            duration = time.time() - request.start_time
            request_duration.labels(
                method=request.method,
                endpoint=request.path
            ).observe(duration)
        
        request_count.labels(
            method=request.method,
            endpoint=request.path,
            status=response.status_code
        ).inc()
        
        active_connections.dec()
        return response

# 端点
@metrics_bp.route('/metrics')
def get_metrics():
    """获取 Prometheus 格式的指标"""
    return generate_latest(), 200, {'Content-Type': 'text/plain; charset=utf-8'}
