"""Trusted request-origin helpers for audit records.

Why this module exists
----------------------
``ProxyFix`` (wired in :func:`app.create_app` only when ``TRUST_PROXY`` is
enabled) is the single place that decides whether forwarded headers may be
trusted, and how many proxy hops to honour. Once it has run, the resolved
client address is available as ``request.remote_addr``.

Reading ``X-Forwarded-For`` directly anywhere else defeats that decision: the
header is attacker-controlled on a direct-to-port deployment, so an audit
record built from it can be forged. Audit rows are exactly the data an
operator relies on after an incident, so they must never contain a value the
requester could choose.

All audit/telemetry call sites must therefore use :func:`audit_client_ip`
instead of touching forwarded headers.
"""
from flask import request

__all__ = ["audit_client_ip"]


def audit_client_ip(default: str = "") -> str:
    """Return the trusted client IP for audit payloads.

    The value is whatever ``request.remote_addr`` resolves to *after* optional
    ``ProxyFix`` processing:

    - ``TRUST_PROXY=1`` (operator put a reverse proxy in front): ProxyFix has
      already replaced ``remote_addr`` with the real client address taken from
      the trusted number of ``X-Forwarded-For`` hops.
    - ``TRUST_PROXY=0`` (direct ``IP:4500`` deployment, the default): the peer
      address of the TCP connection is used, and forwarded headers are ignored.

    :param default: value returned when ``remote_addr`` is absent (unusual;
        happens in some synthetic WSGI environments).
    """
    return request.remote_addr or default
