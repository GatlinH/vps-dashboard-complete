"""Probe dead-code regression guards."""

from pathlib import Path


PROBE_SOURCE = Path(__file__).resolve().parents[1] / "api" / "probe.py"


def test_probe_module_has_no_backend_peer_fallback_implementation():
    """Peer probes must use the agent-reported path, not an orphaned controller TCP fallback."""
    source = PROBE_SOURCE.read_text(encoding="utf-8")

    assert "def _backend_fallback_probe_peer_targets" not in source
    assert '"source"] = "backend-fallback"' not in source
    assert "socket.socket(socket.AF_INET, socket.SOCK_STREAM)" not in source
