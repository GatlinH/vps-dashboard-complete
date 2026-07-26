"""IPv6 regression coverage for latency monitor probes."""
from unittest.mock import MagicMock, patch

from api.probe import _http_probe_url, icmp_ping


def test_http_probe_url_brackets_bare_ipv6_literal():
    assert _http_probe_url("2001:db8::1") == "http://[2001:db8::1]"
    assert _http_probe_url("[2001:db8::1]", 8080) == "http://[2001:db8::1]:8080"
    assert _http_probe_url("https://[2001:db8::1]/health") == "https://[2001:db8::1]/health"


def test_icmp_ping_uses_explicit_ipv6_flag_for_ipv6_literal():
    completed = MagicMock(returncode=0, stdout="64 bytes time=12.5 ms", stderr="")
    with patch("api.probe.subprocess.run", return_value=completed) as run:
        result = icmp_ping("2001:db8::1", timeout=2)
    assert result["success"] is True
    assert result["latency_ms"] == 12.5
    assert run.call_args.args[0][:2] == ["ping", "-6"]


def test_icmp_ping_keeps_ipv4_command_unchanged():
    completed = MagicMock(returncode=0, stdout="64 bytes time=7.0 ms", stderr="")
    with patch("api.probe.subprocess.run", return_value=completed) as run:
        result = icmp_ping("1.1.1.1", timeout=2)
    assert result["success"] is True
    assert run.call_args.args[0][0] == "ping"
    assert "-6" not in run.call_args.args[0]


def test_install_script_contains_dual_stack_and_real_http_probe(client):
    response = client.get("/api/v1/agent/install.sh")
    assert response.status_code == 200
    embedded_agent = response.get_data(as_text=True).split("<<'PY2'\n", 1)[1].split("\nPY2", 1)[0]
    assert "socket.AF_UNSPEC" in embedded_agent
    assert "def http_probe(" in embedded_agent
    assert 'cmd.append("-6")' in embedded_agent
    assert 'if proto == "http"' in embedded_agent
