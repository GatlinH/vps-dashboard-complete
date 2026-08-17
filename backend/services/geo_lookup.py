"""Geo-IP lookup helpers used by the public probe API."""
import ipaddress

import requests
from flask import request


def _is_public_ipv4(value):
    try:
        ip_obj = ipaddress.ip_address(str(value or "").strip())
        return ip_obj.version == 4 and not (
            ip_obj.is_private
            or ip_obj.is_loopback
            or ip_obj.is_link_local
            or ip_obj.is_reserved
            or ip_obj.is_multicast
        )
    except Exception:
        return False


def _client_public_ip():
    candidate = (request.remote_addr or "").strip()
    return candidate if _is_public_ipv4(candidate) else ""


def _fetch_json_url(url, timeout=5):
    try:
        resp = requests.get(
            url,
            timeout=timeout,
            headers={"Accept": "application/json", "User-Agent": "vps-dashboard-ipgeo/1.0"},
        )
        if resp.status_code >= 400:
            return None
        return resp.json()
    except Exception:
        return None


def _normalize_ipwho(raw):
    if not isinstance(raw, dict) or raw.get("success") is False:
        return None
    conn = raw.get("connection") if isinstance(raw.get("connection"), dict) else {}
    tz = raw.get("timezone")
    return {
        "status": "success",
        "country": raw.get("country") or "",
        "countryCode": raw.get("country_code") or "",
        "regionName": raw.get("region") or "",
        "city": raw.get("city") or "",
        "lat": raw.get("latitude"),
        "lon": raw.get("longitude"),
        "isp": conn.get("isp") or "",
        "org": conn.get("org") or "",
        "as": str(conn.get("asn") or ""),
        "query": raw.get("ip") or "",
        "timezone": tz.get("id") if isinstance(tz, dict) else tz,
        "source": "ipwho.is",
    }


def _valid_geo(data):
    try:
        if not isinstance(data, dict) or data.get("status") not in (None, "success"):
            return False
        lat = float(data.get("lat"))
        lon = float(data.get("lon"))
        return -90 <= lat <= 90 and -180 <= lon <= 180
    except Exception:
        return False


def lookup_ip_geo(ip=""):
    target = (ip or _client_public_ip()).strip()
    if target and not _is_public_ipv4(target):
        raise ValueError("仅支持合法公网 IPv4 地址")

    suffix = target or ""
    ip_api = _fetch_json_url(
        f"http://ip-api.com/json/{suffix}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,org,as,query,timezone&lang=zh-CN",
        timeout=5,
    )
    who = _normalize_ipwho(_fetch_json_url(f"https://ipwho.is/{suffix}?lang=zh-CN", timeout=5))

    candidates = [data for data in (ip_api, who) if _valid_geo(data)]
    if candidates:
        chosen = candidates[0]
        if len(candidates) > 1:
            a, b = candidates[0], candidates[1]
            ac = str(a.get("countryCode") or "").upper()
            bc = str(b.get("countryCode") or "").upper()
            if ac != bc and ac == "US" and bc and bc != "US":
                chosen = b
            elif ac != bc and bc == "US" and ac and ac != "US":
                chosen = a
        sources = []
        for name, data in (("ip-api", ip_api), ("ipwho.is", who)):
            if _valid_geo(data):
                sources.append({
                    "source": name,
                    "countryCode": data.get("countryCode"),
                    "country": data.get("country"),
                    "city": data.get("city"),
                    "lat": data.get("lat"),
                    "lon": data.get("lon"),
                })
        out = dict(chosen)
        out["source"] = chosen.get("source") or ("ip-api" if chosen is ip_api else "ipwho.is")
        out["geo_sources"] = sources
        if len(sources) > 1 and str(sources[0].get("countryCode") or "").upper() != str(sources[1].get("countryCode") or "").upper():
            out["geo_conflict"] = True
        return out

    return {
        "status": "success", "valid": False, "query": target, "country": "—",
        "countryCode": "ZZ", "regionName": "—", "city": "—", "lat": 0,
        "lon": 0, "timezone": None, "isp": None, "org": None, "as": None,
        "source": "fallback:anonymous", "degraded": True,
    }
