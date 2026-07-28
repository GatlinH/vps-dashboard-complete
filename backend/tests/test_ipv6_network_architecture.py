"""IPv4/IPv6 agent inventory and deployment-neutral bind regressions."""
import importlib.util
import os
from pathlib import Path

os.environ.setdefault("API_ROOT", "http://127.0.0.1:5000")
os.environ.setdefault("AGENT_UUID", "test-agent-ipv6")
os.environ.setdefault("AGENT_KEY", "test-key")

_SPEC = importlib.util.spec_from_file_location(
    "vps_agent_ipv6", Path(__file__).parents[2] / "scripts" / "vps-agent.py"
)
assert _SPEC and _SPEC.loader
agent = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(agent)


def test_agent_network_inventory_reports_separate_families(monkeypatch):
    monkeypatch.setattr(agent, "_route_ip", lambda family, _target: {
        agent.socket.AF_INET: "198.51.100.9",
        agent.socket.AF_INET6: "2001:db8::9",
    }.get(family, ""))
    network = agent.network_inventory()
    assert network == {"local_ipv4": "198.51.100.9", "local_ipv6": ["2001:db8::9"]}
    assert "public_ipv4" not in network
    assert "public_ipv6" not in network


def test_agent_inventory_preserves_ipv4_and_ipv6_separately(app, test_server):
    from extensions import db
    from models.models import Server
    from api.agent import _apply_agent_inventory

    with app.app_context():
        server = db.session.get(Server, test_server)
        _apply_agent_inventory(server, {
            "network": {
                "local_ipv4": "10.0.0.8",
                "local_ipv6": ["2001:db8::8"],
                "public_ipv6": "2001:db8::8",
            },
        })
        db.session.commit()
        network = server.agent_config["network"]
        assert network["local_ipv4"] == "10.0.0.8"
        assert network["local_ipv6"] == ["2001:db8::8"]
        assert network["public_ipv6"] == "2001:db8::8"
        # A direct IPv6 identity wins over a private local IPv4 placeholder.
        assert server.ip == "2001:db8::8"


def test_direct_bind_is_operator_configurable_without_proxy_default():
    root = Path(__file__).parents[2]
    compose = (root / "docker-compose.yml").read_text()
    dockerfile = (root / "backend" / "Dockerfile").read_text()
    assert "PUBLIC_BIND_ADDRESS:-0.0.0.0" in compose
    assert "GUNICORN_BIND:-0.0.0.0:5000" in compose
    assert "GUNICORN_BIND=0.0.0.0:5000" in dockerfile
    assert "--bind ${GUNICORN_BIND}" in dockerfile
    assert "nginx" not in compose.lower()
    assert "caddy" not in compose.lower()


def test_embedded_linux_installer_reports_separate_ipv4_ipv6():
    source = (Path(__file__).parents[1] / "api" / "agent.py").read_text()
    assert "def network_inventory():" in source
    assert '"local_ipv6": [local_ipv6] if local_ipv6 else []' in source
    assert '"network": network' in source
    assert 'public_ipv4' not in source[source.index('def network_inventory():'):source.index('def get_ip():')]
