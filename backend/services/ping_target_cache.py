"""Cache helpers for latency-target API payloads."""
import json
import time

from flask import current_app

import extensions


_DEFAULT_PING_TARGETS_CACHE_TTL = 15
_ping_targets_memory_cache = {}


def _ping_targets_cache_ttl() -> int:
    try:
        return max(0, int(current_app.config.get("PING_TARGETS_CACHE_TTL", _DEFAULT_PING_TARGETS_CACHE_TTL)))
    except (TypeError, ValueError):
        return _DEFAULT_PING_TARGETS_CACHE_TTL


def _cache_get_json(key):
    try:
        client = getattr(extensions, "redis_client", None)
        if client:
            raw = client.get(key)
            if raw:
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8")
                return json.loads(raw)
    except Exception:
        pass
    item = _ping_targets_memory_cache.get(key)
    if item and item.get("expires", 0) > time.time():
        return item.get("value")
    return None


def _cache_set_json(key, value, ttl=None):
    if ttl is None:
        ttl = _ping_targets_cache_ttl()
    try:
        client = getattr(extensions, "redis_client", None)
        if client:
            client.setex(key, int(ttl), json.dumps(value, ensure_ascii=False))
            return
    except Exception:
        pass
    _ping_targets_memory_cache[key] = {"expires": time.time() + ttl, "value": value}


def clear_ping_targets_cache(sid):
    prefix = f"vps:public:ping-targets:{sid}:"
    for key in list(_ping_targets_memory_cache):
        if str(key).startswith(prefix):
            _ping_targets_memory_cache.pop(key, None)
    try:
        client = getattr(extensions, "redis_client", None)
        if client:
            for key in client.scan_iter(f"{prefix}*"):
                client.delete(key)
    except Exception:
        pass
