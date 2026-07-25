"""Regression coverage for peer probe endpoint resolution and agent install roots."""

from api.probe import _peer_probe_endpoint
from api.servers import _build_install_payload
from models.models import Server


def _server(ip="10.0.0.9", config=None):
    return Server(name="peer", ip=ip, agent_config=config or {})


def test_peer_probe_prefers_explicit_public_nat_endpoint():
    peer = _server(config={
        "nat": {"public_ipv4": "8.8.8.8", "mapped_port": "8443"},
        "inventory_meta": {"hostname": "ignored.example"},
    })
    assert _peer_probe_endpoint(peer) == ("8.8.8.8", 8443, "tcp", "public_ipv4")


def test_peer_probe_uses_inventory_hostname_before_private_agent_ip():
    peer = _server(config={
        "inventory_meta": {"hostname": "natsg4.bytevirt.net", "probe_port": "443"},
    })
    assert _peer_probe_endpoint(peer) == ("natsg4.bytevirt.net", 443, "tcp", "hostname")


def test_peer_probe_rejects_private_only_peer():
    peer = _server(ip="10.20.30.40", config={"network": {"public_ipv4": "10.0.0.5"}})
    assert _peer_probe_endpoint(peer) is None


def test_install_payload_prefers_explicit_public_api_root(app):
    server = _server(ip="8.8.8.8")
    with app.app_context():
        app.config["PUBLIC_API_ROOT"] = "http://198.51.100.5:4500/"
        app.config["FRONTEND_URL"] = "https://ignored.example"
        payload = _build_install_payload(server, "test-agent-key")

    assert payload["api_root"] == "http://198.51.100.5:4500"
    assert payload["install_url"] == "http://198.51.100.5:4500/api/v1/agent/install.sh"
    assert "http://198.51.100.5:4500/api/v1/agent/install.sh" in payload["install_command"]


def test_install_payload_falls_back_to_frontend_url(app):
    server = _server(ip="8.8.8.8")
    with app.app_context():
        app.config["PUBLIC_API_ROOT"] = ""
        app.config["FRONTEND_URL"] = "https://dashboard.example/"
        payload = _build_install_payload(server, "test-agent-key")

    assert payload["api_root"] == "https://dashboard.example"
    assert payload["install_url"] == "https://dashboard.example/api/v1/agent/install.sh"
