"""SSRF DNS pinning must be request-local, not a global resolver swap.

Production gunicorn runs ``--worker-class gthread --threads 4``, so several
probe fetches share one process. The previous implementation pinned DNS by
temporarily reassigning ``socket.getaddrinfo``:

* thread A's ``finally`` could restore the resolver while thread B still relied
  on its own pin, so B connected through an unvalidated resolution path;
* while the patch was installed, every unrelated component in the process
  (MySQL, Redis, Telegram) resolved through the probe-specific function.

These tests lock in the replacement contract:

1. ``socket.getaddrinfo`` is never rebound, not even mid-fetch;
2. each concurrent fetch connects to the address *its own* validation returned;
3. a host that resolves to a private address is refused;
4. HTTPS keeps SNI / certificate verification bound to the original hostname
   even though the socket is pinned to an IP.
"""
import socket
import threading
from unittest.mock import MagicMock, patch

import pytest

import services.probe_fetcher as pf

_SNAP = {
    "id": 1,
    "name": "pin-test",
    "cpu_use": 0.0,
    "ram_use": 0.0,
    "disk_use": 0.0,
    "net_up": 0.0,
    "net_down": 0.0,
    "status": "offline",
    "uptime": "",
}


def _addrinfo(ip: str, port: int = 80):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port))]


def _body_mock(payload: bytes):
    resp = MagicMock()
    resp.read.return_value = payload
    resp.__enter__ = lambda s: s
    resp.__exit__ = MagicMock(return_value=False)
    return resp


def test_module_has_no_global_resolver_patch():
    """The global-monkeypatch helper must be gone, not merely unused."""
    assert not hasattr(pf, "_pinned_dns"), (
        "_pinned_dns swapped socket.getaddrinfo process-wide and is not "
        "thread-safe under gthread workers"
    )
    source = (pf.__file__ or "").replace(".pyc", ".py")
    text = open(source, encoding="utf-8").read()
    assert "socket.getaddrinfo =" not in text, (
        "probe_fetcher must never assign to socket.getaddrinfo"
    )


def test_fetch_does_not_rebind_global_getaddrinfo_during_request():
    """Capture the resolver identity from inside the in-flight fetch."""
    observed = {}
    before = socket.getaddrinfo

    def _fake_open(req, timeout=8.0):
        observed["during"] = socket.getaddrinfo
        return _body_mock(b'{"cpu_use": 1.0}')

    with patch.object(pf, "is_safe_outbound_url", return_value=True), \
         patch.object(pf, "_open_pinned", side_effect=_fake_open):
        metrics, err = pf.fetch_and_parse_probe("http://probe.example.com/api", _SNAP)

    assert err is None and metrics["cpu_use"] == 1.0
    assert observed["during"] is before, "resolver was swapped during the fetch"
    assert socket.getaddrinfo is before, "resolver was not restored"


def test_concurrent_fetches_each_pin_their_own_validated_address():
    """Two threads resolving different hosts must not steal each other's pin."""
    resolutions = {
        "a.example.com": "203.0.113.10",
        "b.example.com": "198.51.100.20",
    }
    connected = {}
    gate = threading.Barrier(2, timeout=10)

    def _fake_resolve(host, port=None):
        return _addrinfo(resolutions[host], port or 80)

    def _fake_conn_classes(connect_ip):
        # Record the IP each thread pinned, and hold both threads inside the
        # pinned region simultaneously so a shared-state implementation would
        # cross-contaminate.
        gate.wait()
        connected[threading.current_thread().name] = connect_ip
        return MagicMock(), MagicMock()

    results = {}

    def _worker(host):
        with patch.object(pf, "is_safe_outbound_url", return_value=True), \
             patch.object(pf, "resolve_public_host_addresses", side_effect=_fake_resolve), \
             patch.object(pf, "_pinned_connection_classes", side_effect=_fake_conn_classes), \
             patch("urllib.request.build_opener") as mock_builder:
            mock_builder.return_value.open.return_value = _body_mock(b'{"cpu_use": 2.0}')
            results[threading.current_thread().name] = pf.fetch_and_parse_probe(
                f"http://{host}/api", _SNAP
            )

    t1 = threading.Thread(target=_worker, args=("a.example.com",), name="t1")
    t2 = threading.Thread(target=_worker, args=("b.example.com",), name="t2")
    t1.start()
    t2.start()
    t1.join(15)
    t2.join(15)

    assert connected == {"t1": "203.0.113.10", "t2": "198.51.100.20"}, (
        f"pinned addresses leaked between threads: {connected}"
    )
    for name, (metrics, err) in results.items():
        assert err is None, f"{name} failed: {err}"


@pytest.mark.parametrize(
    "url",
    [
        "http://169.254.169.254/latest/meta-data/",
        "http://127.0.0.1:5000/health",
        "http://10.0.0.5/probe",
        "http://[::1]/probe",
        "file:///etc/passwd",
        "gopher://example.com/",
        "http://user:pass@example.com/probe",
    ],
)
def test_unsafe_targets_never_reach_the_network(url):
    with patch.object(pf, "_open_pinned") as mock_open:
        metrics, err = pf.fetch_and_parse_probe(url, _SNAP)
    mock_open.assert_not_called()
    assert metrics is None
    assert err == "probe_url 非法或存在安全风险"


def test_open_pinned_refuses_host_that_resolves_private():
    """Second-stage validation runs at connect time, closing the rebind window."""
    import urllib.request

    req = urllib.request.Request("http://rebind.example.com/probe")
    with patch.object(pf, "resolve_public_host_addresses", return_value=[]):
        with pytest.raises(ValueError):
            pf._open_pinned(req)


def test_https_pinning_keeps_sni_on_original_hostname():
    """Connecting by IP must not weaken TLS hostname verification."""
    _, https_cls = pf._pinned_connection_classes("203.0.113.10")
    conn = https_cls("secure.example.com", port=443)
    captured = {}

    class _FakeCtx:
        def wrap_socket(self, sock, server_hostname=None):
            captured["server_hostname"] = server_hostname
            return sock

    conn._context = _FakeCtx()
    conn._tunnel_host = None
    with patch("socket.create_connection", return_value=MagicMock()) as mock_conn:
        conn.connect()

    assert mock_conn.call_args[0][0] == ("203.0.113.10", 443), "socket not pinned to validated IP"
    assert captured["server_hostname"] == "secure.example.com", (
        "SNI/cert verification must stay bound to the configured hostname"
    )


def test_http_pinning_targets_validated_ip_but_keeps_host_header():
    http_cls, _ = pf._pinned_connection_classes("203.0.113.11")
    conn = http_cls("plain.example.com", port=8080)
    conn._tunnel_host = None
    with patch("socket.create_connection", return_value=MagicMock()) as mock_conn:
        conn.connect()
    assert mock_conn.call_args[0][0] == ("203.0.113.11", 8080)
    assert conn.host == "plain.example.com", "Host header must keep the configured name"


def test_redirects_are_not_followed():
    """A 30x to an internal address must not be chased after validation."""
    handler = pf._NoRedirectHandler()
    assert handler.redirect_request(None, None, 302, "Found", {}, "http://127.0.0.1/") is None
