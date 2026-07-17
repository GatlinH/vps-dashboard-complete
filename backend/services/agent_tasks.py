"""Versioned, allow-listed tasks for readonly monitoring agents."""
from __future__ import annotations

import re
from typing import Any

from utils.errors import ValidationError

TASK_SCHEMA_VERSION = 1
TASK_MIN_TTL_SECONDS = 30
TASK_MAX_TTL_SECONDS = 3600
_TARGET_KEY_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def normalize_task_request(data: dict[str, Any]) -> tuple[str, dict[str, Any], int]:
    """Validate a declarative agent task; never accept executable commands."""
    kind = str(data.get("kind") or "").strip()
    params = data.get("params", {})
    ttl = data.get("ttl_seconds")
    if kind not in {"collect_inventory", "reload_agent_config", "run_peer_probe"}:
        raise ValidationError("kind 必须是允许的声明式任务", field="kind")
    if not isinstance(params, dict):
        raise ValidationError("params 必须是 JSON 对象", field="params")
    try:
        ttl = int(ttl)
    except (TypeError, ValueError):
        raise ValidationError("ttl_seconds 必须是整数", field="ttl_seconds")
    if not TASK_MIN_TTL_SECONDS <= ttl <= TASK_MAX_TTL_SECONDS:
        raise ValidationError(f"ttl_seconds 取值范围为 {TASK_MIN_TTL_SECONDS}-{TASK_MAX_TTL_SECONDS}", field="ttl_seconds")
    if kind in {"collect_inventory", "reload_agent_config"}:
        if params:
            raise ValidationError(f"{kind} 不接受 params", field="params")
        return kind, {}, ttl
    keys = params.get("target_keys")
    if not isinstance(keys, list) or not 1 <= len(keys) <= 10:
        raise ValidationError("run_peer_probe.params.target_keys 必须是 1-10 个目标 key", field="params")
    if set(params) != {"target_keys"} or any(not isinstance(x, str) or not _TARGET_KEY_RE.fullmatch(x) for x in keys):
        raise ValidationError("run_peer_probe.params 仅允许安全 target_keys", field="params")
    return kind, {"target_keys": list(dict.fromkeys(keys))}, ttl
