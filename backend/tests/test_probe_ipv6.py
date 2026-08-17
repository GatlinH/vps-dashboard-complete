"""IPv6 regression coverage for latency monitor probes."""
from unittest.mock import MagicMock, patch

from api.probe import _http_probe_url, icmp_ping


def test_http_probe_url_brackets_bare_ipv6_literal():
    assert _http_probe_url("2001:db8::1") == "http://[2001:db8::1]"
    assert _http_probe_url("[2001:db8::1]", 8080) == "http://[2001:db8::1]:8080"
    assert _http_probe_url("https://[2001:db8::1]/health") == "https://[2001:db8::1]/health"


def test_icmp_ping_uses_explicit_ipv6_flag_for_ipv6_literal():
    completed = MagicMock(returncode=0, stdout="64 bytes time=12.5 ms", stderr="")
    with patch("services.probe_protocols.subprocess.run", return_value=completed) as run:
        result = icmp_ping("2001:db8::1", timeout=2)
    assert result["success"] is True
    assert result["latency_ms"] == 12.5
    assert run.call_args.args[0][:2] == ["ping", "-6"]


def test_icmp_ping_keeps_ipv4_command_unchanged():
    completed = MagicMock(returncode=0, stdout="64 bytes time=7.0 ms", stderr="")
    with patch("services.probe_protocols.subprocess.run", return_value=completed) as run:
        result = icmp_ping("1.1.1.1", timeout=2)
    assert result["success"] is True
    assert run.call_args.args[0][0] == "ping"
    assert "-6" not in run.call_args.args[0]


def test_release_build_source_contains_dual_stack_and_real_http_probe():
    """The signed binary release is built from this canonical source.

    Unsigned source-runtime HTTP delivery was deliberately removed; the
    installer now accepts only a signed binary release.
    """
    from pathlib import Path

    source = (Path(__file__).parents[2] / "scripts" / "vps-agent.py").read_text(encoding="utf-8")
    assert "socket.AF_UNSPEC" in source
    assert "def http_probe(" in source
    assert "cmd = ['ping'] + (['-6']" in source
    assert "if proto == 'http'" in source
