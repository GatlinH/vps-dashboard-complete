"""Regression tests for scripts/install-master-agent.sh AGENT_API_ROOT derivation.

Root cause (2026-09-10): the installer defaulted AGENT_API_ROOT to
http://127.0.0.1:5000 — the container-internal Gunicorn bind — while
docker-compose.yml publishes the API on the host as :4500->5000. Agents
installed on the panel host therefore failed every push (Connection
refused) and the dashboard flipped the server to offline although it was
healthy. The installer must derive the host-side published port from
compose instead of hardcoding the container port.
"""

from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "scripts" / "install-master-agent.sh"


def _installer_text() -> str:
    assert INSTALLER.exists(), f"missing {INSTALLER}"
    return INSTALLER.read_text(encoding="utf-8")


def test_no_container_port_default_in_installer():
    """AGENT_API_ROOT must not fall back to the container-internal :5000."""
    # Ignore the docstring (which documents the old bug) and bash comments;
    # only live assignment/default lines count.
    code = "\n".join(
        ln for ln in INSTALLER.read_text(encoding="utf-8").splitlines()
        if not ln.strip().startswith("#")
    )
    assert "127.0.0.1:5000" not in code, (
        "installer still hardcodes container-internal port 5000 as "
        "AGENT_API_ROOT default — agents on the panel host cannot reach it"
    )


def test_api_root_derived_from_compose_published_port():
    """The default must come from `docker compose port` (host-side mapping)."""
    text = _installer_text()
    assert "compose" in text and "port api 5000" in text, (
        "installer must derive the published API port via docker compose port"
    )
    # Fallback when compose is unavailable must be the documented host port.
    assert "_api_port=\"4500\"" in text, (
        "fallback port must be 4500 (the host-side published API port)"
    )


def test_wildcard_publish_ip_maps_to_loopback():
    """0.0.0.0/[::] published binds must become 127.0.0.1 for a host-local agent."""
    text = _installer_text()
    assert '"0.0.0.0"' in text and '"[::]"' in text, (
        "installer must map wildcard publish IPs to 127.0.0.1"
    )


def test_explicit_agent_api_root_still_wins():
    """An operator-provided AGENT_API_ROOT must override derivation."""
    text = _installer_text()
    assert '[[ -z "${AGENT_API_ROOT:-}" ]]' in text, (
        "derivation must be guarded by an empty AGENT_API_ROOT check"
    )


def test_installer_syntax():
    """bash -n must pass (cheap syntax gate; CI has no shellcheck stage)."""
    import subprocess
    result = subprocess.run(
        ["bash", "-n", str(INSTALLER)], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, f"bash -n failed: {result.stderr}"
