"""
/api/geo  —  地图瓦片代理 + 矢量数据缓存
前端 3D 星图通过此端点获取地图数据，后端统一缓存减少外部请求。

路由:
  GET /api/geo/tile/<z>/<x>/<y>.png   →  CARTO 暗色瓦片（Redis 缓存）
  GET /api/geo/countries              →  world-atlas TopoJSON（Redis 缓存）
  GET /api/geo/ip/<ip>                →  IP 地理位置（同 probe / ip-info）
  GET /api/geo/servers/coords         →  服务器坐标（支持分页/聚合）
"""
import json
import requests
from flask import Blueprint, Response, jsonify, request, current_app

import extensions
from middleware.rbac import viewer_or_admin_required

geo_bp = Blueprint("geo", __name__)

CARTO_SERVERS = ["a", "b", "c"]
CARTO_TEMPLATE = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"


def _remote_identity() -> str:
    # ProxyFix middleware has already resolved the real client IP into
    # request.remote_addr; reading X-Forwarded-For directly here would
    # bypass that processing and risk trusting an untrusted header.
    return request.remote_addr or "unknown"


def _short_window_allow_or_reject(rate_key: str, limit: int, window_sec: int) -> bool:
    """简单短窗限流（依赖 Redis；Redis 异常时 fail-open）。"""
    try:
        current = extensions.redis_client.incr(rate_key)
        if current == 1:
            extensions.redis_client.expire(rate_key, window_sec)
        return current <= limit
    except Exception:
        return True


def _provider_degraded_payload(provider: str, detail: str, fallback_hint: str) -> dict:
    return {
        "error_code": "MAP_PROVIDER_UNAVAILABLE",
        "provider": provider,
        "message": "地图服务暂时不可用，已进入降级模式",
        "detail": detail,
        "fallback_hint": fallback_hint,
    }


@geo_bp.get("/tile/<int:z>/<int:x>/<int:y>.png")
def tile_proxy(z, x, y):
    if not (0 <= z <= 10 and 0 <= x < 2**z and 0 <= y < 2**z):
        return Response("bad tile coords", status=400)

    burst_limit = int(current_app.config.get("TILE_BURST_LIMIT", 120))
    burst_window = int(current_app.config.get("TILE_BURST_WINDOW_S", 10))
    rate_key = f"vps:geo:tile:burst:{_remote_identity()}"
    if not _short_window_allow_or_reject(rate_key, burst_limit, burst_window):
        return jsonify(
            error_code="TILE_RATE_LIMITED",
            message="瓦片请求过于频繁，请稍后重试",
            retry_after=burst_window,
        ), 429

    cache_key = f"vps:tile:{z}:{x}:{y}"
    ttl = current_app.config.get("TILE_CACHE_TTL", 86400)

    try:
        cached = extensions.redis_client.get(cache_key)
        if cached:
            return Response(
                cached,
                status=200,
                mimetype="image/png",
                headers={"X-Cache": "HIT", "Cache-Control": f"public, max-age={ttl}"},
            )
    except Exception:
        pass

    s_char = CARTO_SERVERS[(x + y) % 3]
    url = CARTO_TEMPLATE.format(s=s_char, z=z, x=x, y=y)
    headers = {"User-Agent": "VPS-Dashboard/1.0 (tile-proxy)"}

    try:
        resp = requests.get(url, headers=headers, timeout=8)
        resp.raise_for_status()
        img_bytes = resp.content

        try:
            extensions.redis_client.setex(cache_key, ttl, img_bytes)
        except Exception:
            pass

        return Response(
            img_bytes,
            status=200,
            mimetype="image/png",
            headers={"X-Cache": "MISS", "Cache-Control": f"public, max-age={ttl}"},
        )
    except requests.RequestException as e:
        payload = _provider_degraded_payload(
            provider="carto",
            detail=str(e),
            fallback_hint="前端可切换到纯矢量模式（关闭 tileMode）或展示简化底图。",
        )
        return jsonify(payload), 502


@geo_bp.get("/countries")
def countries():
    cache_key = "vps:geo:countries-110m"
    stale_key = "vps:geo:countries-110m:stale"
    ttl = int(current_app.config.get("COUNTRIES_CACHE_TTL", 7 * 86400))

    try:
        cached = extensions.redis_client.get(cache_key)
        if cached:
            return Response(cached, status=200, mimetype="application/json", headers={"X-Cache": "HIT"})
    except Exception:
        pass

    try:
        resp = requests.get(WORLD_ATLAS_URL, timeout=15)
        resp.raise_for_status()
        raw = resp.content
        try:
            extensions.redis_client.setex(cache_key, ttl, raw)
            extensions.redis_client.setex(stale_key, ttl * 2, raw)
        except Exception:
            pass
        return Response(raw, status=200, mimetype="application/json", headers={"X-Cache": "MISS"})
    except requests.RequestException as e:
        try:
            stale = extensions.redis_client.get(stale_key)
            if stale:
                return Response(
                    stale,
                    status=200,
                    mimetype="application/json",
                    headers={"X-Cache": "STALE", "X-Geo-Degraded": "1"},
                )
        except Exception:
            pass

        payload = _provider_degraded_payload(
            provider="world-atlas-cdn",
            detail=str(e),
            fallback_hint="前端可使用内置简化边界数据，或仅渲染服务器节点。",
        )
        return jsonify(payload), 502


@geo_bp.get("/ip")
@geo_bp.get("/ip/<ip>")
def ip_geo(ip=None):
    ip = (ip or request.args.get("ip", "")).strip()
    cache_key = f"vps:ipgeo:{ip or 'self'}"

    try:
        cached = extensions.redis_client.get(cache_key)
        if cached:
            return jsonify(json.loads(cached))
    except Exception:
        pass

    url = f"http://ip-api.com/json/{ip}?fields=status,country,regionName,city,lat,lon,isp,org,query&lang=zh-CN"
    try:
        resp = requests.get(url, timeout=6)
        data = resp.json()
        try:
            extensions.redis_client.setex(cache_key, 3600, json.dumps(data, ensure_ascii=False))
        except Exception:
            pass
        return jsonify(data)
    except Exception as e:
        return jsonify(error=str(e)), 502


@geo_bp.get("/servers/coords")
@viewer_or_admin_required
def servers_coords():
    """返回服务器经纬度，支持分页与聚合视图。"""
    from models.models import Server

    mode = (request.args.get("mode") or "list").strip().lower()
    page = max(int(request.args.get("page", 1)), 1)
    per_page = min(max(int(request.args.get("per_page", 200)), 1), 1000)

    query = Server.query.order_by(Server.id.asc())

    if mode == "aggregate":
        servers = query.all()
        by_location = {}
        by_status = {}
        coords_ready = 0
        for s in servers:
            location = s.location or "未知"
            status = s.status or "unknown"
            by_location[location] = by_location.get(location, 0) + 1
            by_status[status] = by_status.get(status, 0) + 1
            if s.ip:
                coords_ready += 1

        top_locations = sorted(by_location.items(), key=lambda kv: kv[1], reverse=True)[:20]
        return jsonify(
            mode="aggregate",
            total=len(servers),
            coords_ready=coords_ready,
            by_status=by_status,
            top_locations=[{"location": name, "count": count} for name, count in top_locations],
            schema_version=current_app.config.get("API_SCHEMA_VERSION"),
        )

    pagination = query.paginate(page=page, per_page=per_page, error_out=False)
    nodes = []
    for s in pagination.items:
        lat, lon = _get_server_coords(s)
        nodes.append({
            "id": s.id,
            "name": s.name,
            "flag": s.flag,
            "location": s.location,
            "ip": s.ip,
            "status": s.status,
            "lat": lat,
            "lon": lon,
        })

    return jsonify(
        mode="list",
        nodes=nodes,
        pagination={
            "page": page,
            "per_page": per_page,
            "pages": pagination.pages,
            "total": pagination.total,
            "has_next": pagination.has_next,
        },
        schema_version=current_app.config.get("API_SCHEMA_VERSION"),
    )


def _get_server_coords(server) -> tuple[float, float]:
    if not server.ip:
        return (35.0, 105.0)

    cache_key = f"vps:coords:{server.ip}"
    try:
        cached = extensions.redis_client.get(cache_key)
        if cached:
            d = json.loads(cached)
            return d["lat"], d["lon"]
    except Exception:
        pass

    try:
        url = f"http://ip-api.com/json/{server.ip}?fields=lat,lon,status"
        resp = requests.get(url, timeout=5)
        d = resp.json()
        if d.get("status") == "success":
            coords = {"lat": d["lat"], "lon": d["lon"]}
            try:
                extensions.redis_client.setex(cache_key, 86400, json.dumps(coords))
            except Exception:
                pass
            return d["lat"], d["lon"]
    except Exception:
        pass

    return (35.0, 105.0)
