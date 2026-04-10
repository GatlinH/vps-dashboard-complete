# backend/utils/metrics.py - Prometheus 指标导出

from prometheus_client import Counter, Histogram, Gauge
import time

# 定义指标
api_request_count = Counter(
    'vps_api_requests_total',
    'API 请求总数',
    ['method', 'endpoint', 'status']
)

api_request_duration = Histogram(
    'vps_api_request_duration_seconds',
    'API 请求耗时',
    ['method', 'endpoint']
)

database_query_duration = Histogram(
    'vps_database_query_duration_seconds',
    '数据库查询耗时',
    ['query_type']
)

active_servers = Gauge(
    'vps_servers_active',
    '活跃服务器数',
    ['status']
)

cache_hit_rate = Gauge(
    'vps_cache_hit_rate',
    '缓存命中率',
    ['cache_type']
)

# ── 业务指标 ───────────────────────────────────────────────────────────────────

# 服务器在线率
vps_servers_total   = Gauge('vps_servers_total',   '服务器总数')
vps_servers_online  = Gauge('vps_servers_online',  '在线服务器数')
vps_servers_offline = Gauge('vps_servers_offline', '离线服务器数')

# 探针延迟分布
vps_probe_latency_ms = Histogram(
    'vps_probe_latency_ms', '探针 TCP 延迟(ms)',
    buckets=[10, 50, 100, 200, 500, 1000, 2000, 5000]
)

# API 错误计数
vps_api_errors_total = Counter(
    'vps_api_errors_total', 'API 错误数',
    ['endpoint', 'status_code']
)

# 流量超限服务器数
vps_traffic_overused_count = Gauge('vps_traffic_overused_count', '流量超限服务器数')
