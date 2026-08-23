"""Audit records must never take their source IP from a forwarded header.

``ProxyFix`` is the only component allowed to interpret ``X-Forwarded-For``,
and it is installed only when the operator sets ``TRUST_PROXY``. Any code that
reads the header directly can be fed an arbitrary value by the requester,
which forges the ``ip`` field of ops/audit events.

This module locks the behaviour in two independent ways:

1. behavioural: with ``TRUST_PROXY`` disabled (the deployment-neutral default
   for direct ``IP:4500`` installs), a spoofed header must not reach a stored
   ops event;
2. structural: no non-test backend module may read ``X-Forwarded-For``.
"""
import re
from pathlib import Path

import pytest
from flask import Flask

from utils.request_context import audit_client_ip

BACKEND_ROOT = Path(__file__).resolve().parents[1]

# Only ProxyFix may interpret forwarded headers. api/probe.py documents the
# trusted-proxy gate in prose, so match real attribute access, not comments.
_FORWARDED_READ = re.compile(
    r"""(?:headers\.get|headers\[|environ\.get|environ\[)\s*\(?\s*['"](?:X-Forwarded-For|HTTP_X_FORWARDED_FOR)['"]""",
    re.IGNORECASE,
)

_SKIP_DIRS = {"tests", "__pycache__", ".venv", "venv", "migrations"}


def _backend_sources():
    for path in sorted(BACKEND_ROOT.rglob("*.py")):
        if _SKIP_DIRS.intersection(path.relative_to(BACKEND_ROOT).parts):
            continue
        yield path


def test_no_backend_module_reads_forwarded_header_directly():
    offenders = []
    for path in _backend_sources():
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if _FORWARDED_READ.search(line):
                offenders.append(f"{path.relative_to(BACKEND_ROOT)}:{lineno}")
    assert not offenders, (
        "These modules read a forwarded header directly instead of using "
        "utils.request_context.audit_client_ip(), so their audit IP can be "
        f"spoofed: {offenders}"
    )


def test_audit_client_ip_ignores_spoofed_header_without_proxy_gate():
    app = Flask(__name__)
    with app.test_request_context(
        "/",
        environ_overrides={"REMOTE_ADDR": "203.0.113.9"},
        headers={"X-Forwarded-For": "1.2.3.4"},
    ):
        assert audit_client_ip() == "203.0.113.9"


def test_audit_client_ip_returns_default_when_remote_addr_missing():
    app = Flask(__name__)
    with app.test_request_context("/", environ_overrides={"REMOTE_ADDR": None}):
        assert audit_client_ip() == ""
        assert audit_client_ip("unknown") == "unknown"


def test_audit_client_ip_uses_proxyfix_result_when_operator_enables_it():
    """With a reverse proxy configured, ProxyFix rewrites remote_addr itself."""
    from werkzeug.middleware.proxy_fix import ProxyFix

    app = Flask(__name__)
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1)
    seen = {}

    @app.get("/probe-ip")
    def probe_ip():
        seen["ip"] = audit_client_ip()
        return "", 204

    app.test_client().get(
        "/probe-ip",
        environ_overrides={"REMOTE_ADDR": "10.0.0.5"},
        headers={"X-Forwarded-For": "203.0.113.7"},
    )
    assert seen["ip"] == "203.0.113.7"


@pytest.mark.parametrize(
    "module_path, symbol",
    [
        ("api.ops", "_audit_ops_high_risk"),
        ("api.servers", "_audit_high_risk"),
    ],
)
def test_high_risk_audit_helpers_exist(module_path, symbol):
    """Guard against a rename silently dropping the audited call sites."""
    module = __import__(module_path, fromlist=[symbol])
    assert callable(getattr(module, symbol))


def test_agent_auth_failure_audit_records_untrusted_peer_only(client, app):
    """A spoofed header must not become the stored ops-event source IP."""
    from models.models import OpsEvent

    response = client.post(
        "/api/v1/agent/push",
        json={"cpu_use": 1},
        headers={"X-Forwarded-For": "198.51.100.66"},
        environ_overrides={"REMOTE_ADDR": "203.0.113.11"},
    )
    assert response.status_code in (400, 401, 403)

    with app.app_context():
        event = (
            OpsEvent.query.filter(OpsEvent.event_type == "agent_auth_failed")
            .order_by(OpsEvent.id.desc())
            .first()
        )
        assert event is not None, "agent auth failure should be audited"
        assert event.classification == "diagnostic_agent_auth"
        assert (event.payload or {}).get("reason") == "missing_uuid"
        recorded = str((event.payload or {}).get("remote_addr") or "")
        assert recorded == "203.0.113.11"
        assert "198.51.100.66" not in recorded, (
            f"spoofed forwarded header leaked into audit payload: {recorded!r}"
        )
