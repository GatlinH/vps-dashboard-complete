"""
services/alert_cooldown.py — P3-8: 告警冷却从 DB 迁移到 Redis

## Key schema
    alert:cooldown:{rule_id}:{server_id}

- rule_id   : AlertRule.id  (integer)
- server_id : Server.id (integer) or "global" when AlertRule.server_id is NULL
- Value     : Unix timestamp (integer string) of the moment the alert was allowed to fire
- TTL       : AlertRule.cool_down_s seconds

## Atomic algorithm (hot path)
    SET alert:cooldown:{rule_id}:{server_id} <timestamp> NX EX <cool_down_s>

    - Returns truthy (new key set)  → allow the alert to fire
    - Returns falsy  (key existed)  → suppress (cooldown window still active)

This single command is atomic — no TOCTOU race possible, no "GET then SET" pattern.

## Per-server-per-rule granularity
The Redis key includes both rule_id *and* server_id, giving each (rule, server)
pair an independent cooldown window.  The legacy DB implementation used a single
AlertRule.last_fired field shared across all servers for a given rule.  The new
behaviour is strictly more correct: a CPU spike on server A no longer suppresses
the alert for server B.

## Operations helpers
- list_cooldown_keys(redis_client, rule_id=None)  — list active cooldown keys
- delete_cooldown_key(redis_client, rule_id, server_id) — manually clear a key
  (emergency use only; see runbook in PR description)
"""

import logging
import time
from typing import Optional

log = logging.getLogger(__name__)

_KEY_PREFIX = "alert:cooldown"


def make_cooldown_key(rule_id: int, server_id: Optional[int]) -> str:
    """Build the Redis cooldown key for a given (rule, server) pair.

    server_id == None is used for global rules (AlertRule.server_id IS NULL).
    The string "global" is used as the segment so the key is easy to read via
    ``redis-cli KEYS 'alert:cooldown:*'``.
    """
    sid = server_id if server_id is not None else "global"
    return f"{_KEY_PREFIX}:{rule_id}:{sid}"


def check_and_set_cooldown(
    redis_client,
    rule_id: int,
    server_id: Optional[int],
    cool_down_s: int,
    fail_open: bool = True,
) -> tuple:
    """Atomically check and set the Redis cooldown key.

    Uses ``SET key value NX EX ttl`` — a single atomic Redis command that:
    - Sets the key with the given TTL **only if it does not already exist** (NX).
    - Returns True  when the key was successfully set  → allow the alert to fire.
    - Returns False when the key already existed       → suppress (in cooldown).

    On Redis error the behaviour is controlled by *fail_open*:
    - fail_open=True  (default): allow the alert to fire (availability-first).
    - fail_open=False          : suppress the alert (noise-reduction-first).

    Returns
    -------
    (allowed: bool, reason: str)
        - allowed  True  if the caller should fire the alert
        - reason   short string for logging / metrics labels
    """
    key = make_cooldown_key(rule_id, server_id)
    now_ts = str(int(time.time()))
    ttl = max(int(cool_down_s), 1)

    try:
        result = redis_client.set(key, now_ts, nx=True, ex=ttl)
        if result:
            return True, "allow"
        return False, "suppress"
    except Exception as exc:
        log.warning(
            "alert_cooldown Redis error rule_id=%s server_id=%s err=%s",
            rule_id, server_id, exc,
        )
        if fail_open:
            return True, "error_fail_open"
        return False, "error_fail_closed"


def delete_cooldown_key(
    redis_client,
    rule_id: int,
    server_id: Optional[int],
) -> int:
    """Delete a single cooldown key (ops / emergency use).

    Returns the number of keys deleted (0 or 1).
    """
    key = make_cooldown_key(rule_id, server_id)
    try:
        return redis_client.delete(key)
    except Exception as exc:
        log.error("alert_cooldown delete_key error key=%s err=%s", key, exc)
        return 0


def list_cooldown_keys(redis_client, rule_id: Optional[int] = None) -> list:
    """Return a list of currently-active cooldown keys (for ops / runbook).

    If *rule_id* is supplied, restrict to keys for that rule.
    Note: uses SCAN internally (safe for production Redis); avoid on very large
    keyspaces unless scoped with a specific rule_id.
    """
    pattern = (
        f"{_KEY_PREFIX}:{rule_id}:*"
        if rule_id is not None
        else f"{_KEY_PREFIX}:*"
    )
    try:
        return list(redis_client.scan_iter(pattern))
    except Exception as exc:
        log.error("alert_cooldown list_keys error pattern=%s err=%s", pattern, exc)
        return []
