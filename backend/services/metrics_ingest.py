"""
services/metrics_ingest.py — Shared metrics ingestion logic.

Single entry point for both the admin-push path
(POST /api/v1/servers/<sid>/metrics) and the agent-push path
(POST /api/v1/agent/push → Redis queue → agent_consumer).

Callers own the DB session; this module does NOT call db.session.commit().
"""
from __future__ import annotations

import logging

from extensions import db
from models.models import ProbeResult, Server
from utils.errors import ValidationError

logger = logging.getLogger(__name__)


def ingest_metrics(
    server: Server,
    data: dict,
    *,
    strict: bool = False,
    source: str = "unknown",
) -> dict:
    """Apply a metrics payload to *server* and append a ProbeResult row.

    Parameters
    ----------
    server:
        Server ORM instance attached to the current session.
    data:
        Raw payload dict (as received from the caller).
    strict:
        ``True``  → raise :class:`~utils.errors.ValidationError` on invalid
                    percentage-field values; net/status/uptime fields are
                    applied as-is (admin path).
        ``False`` → silently skip fields whose values fail validation
                    (agent path — the daemon must not crash on bad data).
    source:
        Caller identity string included in structured-log context
        (``"admin"`` or ``"agent"``).

    Returns
    -------
    dict
        Mapping of every metric field successfully written to the server
        object (empty fields omitted).  Useful for building the admin-push
        response body.

    Notes
    -----
    Does **not** call ``db.session.commit()``.  The caller is responsible
    for committing (and rolling back on error).
    """
    applied: dict = {}

    # ── 1. Percentage fields (0–100) ─────────────────────────────────────────
    for field in ("cpu_use", "ram_use", "disk_use"):
        val = data.get(field)
        if val is None:
            continue
        try:
            fval = float(val)
        except (TypeError, ValueError):
            if strict:
                raise ValidationError(f"{field} 必须是数字", field=field)
            logger.debug(
                "ingest_metrics: skipping non-numeric %s=%r",
                field, val,
                extra={"server_id": server.id, "source": source},
            )
            continue
        if not (0.0 <= fval <= 100.0):
            if strict:
                raise ValidationError(f"{field} 必须在 0-100 之间", field=field)
            logger.debug(
                "ingest_metrics: skipping out-of-range %s=%r",
                field, val,
                extra={"server_id": server.id, "source": source},
            )
            continue
        setattr(server, field, fval)
        applied[field] = fval

    # ── 2. Network throughput fields ─────────────────────────────────────────
    for field in ("net_up", "net_down"):
        val = data.get(field)
        if val is None:
            continue
        if strict:
            # Admin path: accept the value as supplied (no range constraint).
            setattr(server, field, val)
            applied[field] = val
        else:
            # Agent path: must be a non-negative float; skip silently on error.
            try:
                fval = float(val)
            except (TypeError, ValueError):
                continue
            if fval < 0:
                continue
            setattr(server, field, fval)
            applied[field] = fval

    # ── 3. String / status fields ─────────────────────────────────────────────
    for field in ("status", "uptime"):
        val = data.get(field)
        if val is None:
            continue
        if strict:
            # Admin path: accept the value as supplied.
            setattr(server, field, val)
            applied[field] = val
        else:
            # Agent path: must be a string no longer than 64 chars.
            if isinstance(val, str) and len(val) <= 64:
                setattr(server, field, val)
                applied[field] = val

    # ── 4. Traffic delta (bytes_out_total / bytes_in_total) ──────────────────
    bytes_out = data.get("bytes_out_total")
    bytes_in = data.get("bytes_in_total")
    if bytes_out is not None and bytes_in is not None:
        try:
            bytes_out = int(bytes_out)
            bytes_in = int(bytes_in)
            prev_out = server.bytes_out_snapshot or 0
            prev_in = server.bytes_in_snapshot or 0
            if prev_out > 0 and bytes_out >= prev_out:
                delta_up_gb = (bytes_out - prev_out) / 1024 / 1024 / 1024
                server.traffic_up_gb = round(
                    (server.traffic_up_gb or 0) + delta_up_gb, 6
                )
            if prev_in > 0 and bytes_in >= prev_in:
                delta_dn_gb = (bytes_in - prev_in) / 1024 / 1024 / 1024
                server.traffic_down_gb = round(
                    (server.traffic_down_gb or 0) + delta_dn_gb, 6
                )
            server.traffic_used_gb = (server.traffic_up_gb or 0) + (
                server.traffic_down_gb or 0
            )
            server.bytes_out_snapshot = bytes_out
            server.bytes_in_snapshot = bytes_in
        except (TypeError, ValueError):
            pass

    # ── 5. ProbeResult snapshot ───────────────────────────────────────────────
    db.session.add(
        ProbeResult(
            server_id=server.id,
            cpu_use=data.get("cpu_use", server.cpu_use),
            ram_use=data.get("ram_use", server.ram_use),
            disk_use=data.get("disk_use", server.disk_use),
            net_up=data.get("net_up", server.net_up),
            net_down=data.get("net_down", server.net_down),
            status=data.get("status", server.status),
            latency_ms=data.get("latency_ms"),
        )
    )

    logger.info(
        "ingest_metrics: applied fields=%s",
        list(applied.keys()),
        extra={"server_id": server.id, "source": source},
    )
    return applied
