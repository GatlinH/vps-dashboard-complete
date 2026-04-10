"""
/api/geo  —  地图瓦片代理 + 矢量数据缓存
前端 3D 星图通过此端点获取地图数据，后端统一缓存减少外部请求。

路由:
  GET /api/geo/tile/<z>/<x>/<y>.png   →  CARTO 暗色瓦片（Redis 缓存 24h）
  GET /api/geo/countries              →  world-atlas TopoJSON（Redis 缓存 7d）
  GET /api/geo/ip/<ip>                →  IP 地理位置（同 probe / ip-info）
"""
import json
import hashlib
import requests
from flask import Blueprint, Response, jsonify, request, current_app
import extensions

geo_bp = Blueprint("geo", __name__)

CARTO_SERVERS  = ["a", "b", "c"]
CARTO_TEMPLATE = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
WORLD_ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json"


# ── 瓦片代理 ──────────────────────────────────────────────────────────────────

@geo_bp.get("/tile/<int:z>/<int:x>/<int:y>.png")
def tile_proxy(z, x, y):
    """
    代理并缓存地图瓦片。
    前端 fetch(`/api/geo/tile/${z}/${x}/${y}.png`) 即可，无需暴露第三方 URL。
    """
    if not (0 <= z <= 10 and 0 <= x < 2**z and 0 <= y < 2**z):
        return Response("bad tile coords", status=400)

    cache_key = f"vps:tile:{z}:{x}:{y}"
    ttl       = current_app.config.get("TILE_CACHE_TTL", 86400)

    # 尝试 Redis 缓存
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

    # 回源 CARTO
    s_char  = CARTO_SERVERS[(x + y) % 3]
    url     = CARTO_TEMPLATE.format(s=s_char, z=z, x=x, y=y)
    headers = {"User-Agent": "VPS-Dashboard/1.0 (tile-proxy)"}

    try:
        resp = requests.get(url, headers=headers, timeout=8)
        resp.raise_for_status()
        img_bytes = resp.content

        # 写 Redis（二进制）
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
        return Response(f"tile fetch error: {e}", status=502)


# ── 矢量地图数据 ───────────────────────────────────────────────────────────────

@geo_bp.get("/countries")
def countries():
    """
    返回 world-atlas countries-110m.json（TopoJSON）。
    Redis 缓存 7 天，减少 CDN 请求。
    """
    cache_key = "vps:geo:countries-110m"
    ttl       = 7 * 86400

    try:
        cached = extensions.redis_client.get(cache_key)
        if cached:
            return Response(
                cached,
                status=200,
                mimetype="application/json",
                headers={"X-Cache": "HIT"},
            )
    except Exception:
        pass

    try:
        resp = requests.get(WORLD_ATLAS_URL, timeout=15)
        resp.raise_for_status()
        raw = resp.content
        try:
            extensions.redis_client.setex(cache_key, ttl, raw)
        except Exception:
            pass
        return Response(raw, status=200, mimetype="application/json",
                        headers={"X-Cache": "MISS"})
    except requests.RequestException as e:
        return jsonify(error=str(e)), 502


# ── IP 信息 ───────────────────────────────────────────────────────────────────

@geo_bp.get("/ip")
@geo_bp.get("/ip/<ip>")
def ip_geo(ip=None):
    """
    查询 IP 地理位置（ip-api.com），供 3D 星图定位使用。
    Redis 缓存 1h。
    """
    ip        = (ip or request.args.get("ip", "")).strip()
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


# ── 服务器坐标批量查询 ────────────────────────────────────────────────────────

@geo_bp.get("/servers/coords")
def servers_coords():
    """
    返回所有服务器的经纬度（用于 3D 星图标注节点位置）。
    优先从 DB 读取已知坐标，未知的通过 IP 查询并缓存到 Redis。
    """
    from models.models import Server
    servers = Server.query.all()
    result  = []

    for s in servers:
        lat, lon = _get_server_coords(s)
        result.append({
            "id":       s.id,
            "name":     s.name,
            "flag":     s.flag,
            "location": s.location,
            "ip":       s.ip,
            "status":   s.status,
            "lat":      lat,
            "lon":      lon,
        })

    return jsonify(nodes=result)


def _get_server_coords(server) -> tuple[float, float]:
    """尝试从 IP 查询经纬度，缓存结果"""
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
        url  = f"http://ip-api.com/json/{server.ip}?fields=lat,lon,status"
        resp = requests.get(url, timeout=5)
        d    = resp.json()
        if d.get("status") == "success":
            coords = {"lat": d["lat"], "lon": d["lon"]}
            try:
                extensions.redis_client.setex(cache_key, 86400, json.dumps(coords))
            except Exception:
                pass
            return d["lat"], d["lon"]
    except Exception:
        pass

    return (35.0, 105.0)  # 默认中国
