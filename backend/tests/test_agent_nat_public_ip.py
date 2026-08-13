"""Regression: a NAT'd agent must not downgrade its stored public IP.

A node behind NAT can only observe its private address (for example
172.16.51.82). The inventory fallback chain used to accept that value and
overwrite the public IP recorded at enrolment, which made the node
unreachable for peer probes and silently removed it from the global probe
matrix.

These drive _apply_agent_inventory directly. Going through the HTTP push
endpoint puts a separate DB session between the fixture and the handler, so
the starting IP written by the test was not the row the handler read -- the
assertion then passed or failed for reasons unrelated to the guard.
"""

from unittest import mock

import pytest

import api.agent as agent_api


class _StubServer:
    """Minimal stand-in for Server: only the attributes the code touches."""

    def __init__(self, ip):
        self.ip = ip
        self.agent_config = {}
        self.location = None
        self.cpu_cores = None
        self.ram_gb = None
        self.disk_gb = None


@pytest.fixture
def apply_inventory():
    """Run the inventory path without SQLAlchemy instrumentation or network I/O."""

    def _run(server, payload):
        with mock.patch.object(agent_api, "flag_modified", lambda *a, **k: None), \
             mock.patch.object(agent_api, "_geo_lookup_by_ip", lambda ip: {}):
            agent_api._apply_agent_inventory(server, payload)
        return server.ip

    return _run


def test_private_network_report_keeps_public_ip(apply_inventory):
    """A NAT agent reporting only local_ipv4 must not clobber the public IP."""
    server = _StubServer("188.253.125.104")
    result = apply_inventory(
        server, {"hostname": "nat-node", "network": {"local_ipv4": "172.16.51.82"}}
    )
    assert result == "188.253.125.104"


def test_bare_private_ip_field_keeps_public_ip(apply_inventory):
    """The legacy top-level `ip` field is subject to the same guard."""
    server = _StubServer("188.253.125.104")
    result = apply_inventory(server, {"hostname": "nat-node", "ip": "10.0.0.5"})
    assert result == "188.253.125.104"


def test_public_report_still_updates_ip(apply_inventory):
    """A genuine public_ipv4 report must still win -- the guard is not a freeze."""
    server = _StubServer("203.0.113.10")
    result = apply_inventory(
        server,
        {
            "hostname": "direct-node",
            "network": {"public_ipv4": "198.51.100.7", "local_ipv4": "10.0.0.5"},
        },
    )
    assert result == "198.51.100.7"


def test_private_to_private_update_is_allowed(apply_inventory):
    """When no public IP is known yet, a private address may still be recorded."""
    server = _StubServer("10.0.0.9")
    result = apply_inventory(
        server, {"hostname": "lan-node", "network": {"local_ipv4": "10.0.0.5"}}
    )
    assert result == "10.0.0.5"


@pytest.mark.parametrize(
    "private_addr",
    ["172.16.51.82", "10.0.0.5", "192.168.1.4", "127.0.0.1", "169.254.1.1"],
)
def test_all_private_ranges_are_guarded(apply_inventory, private_addr):
    server = _StubServer("188.253.125.104")
    assert apply_inventory(
        server, {"hostname": "n", "network": {"local_ipv4": private_addr}}
    ) == "188.253.125.104"


def test_geo_lookup_skips_private_address():
    """Geo lookup must not be called with a private address."""
    server = _StubServer("188.253.125.104")
    seen = []

    def _spy(ip):
        seen.append(ip)
        return {}

    with mock.patch.object(agent_api, "flag_modified", lambda *a, **k: None), \
         mock.patch.object(agent_api, "_geo_lookup_by_ip", _spy):
        agent_api._apply_agent_inventory(
            server, {"hostname": "n", "network": {"local_ipv4": "172.16.51.82"}}
        )

    assert "172.16.51.82" not in seen
