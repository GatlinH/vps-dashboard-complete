"""Local validation for the readonly declarative agent task protocol."""
from __future__ import annotations

from datetime import datetime, timezone

ALLOWED_KINDS = {"collect_inventory", "reload_agent_config", "run_peer_probe"}


def validate_task(task: object, now: datetime | None = None):
    if not isinstance(task, dict) or task.get("schema_version") != 1:
        return None
    if not isinstance(task.get("id"), int) or task.get("kind") not in ALLOWED_KINDS:
        return None
    params = task.get("params")
    expires_at = task.get("expires_at")
    if not isinstance(params, dict) or not isinstance(expires_at, str):
        return None
    try:
        expiry = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        if expiry.tzinfo is None:
            return None
    except ValueError:
        return None
    if expiry <= (now or datetime.now(timezone.utc)):
        return None
    kind = task["kind"]
    if kind in {"collect_inventory", "reload_agent_config"}:
        return task if not params else None
    keys = params.get("target_keys")
    if set(params) != {"target_keys"} or not isinstance(keys, list) or not 1 <= len(keys) <= 10:
        return None
    if any(not isinstance(key, str) or not key or len(key) > 128 for key in keys):
        return None
    return task
