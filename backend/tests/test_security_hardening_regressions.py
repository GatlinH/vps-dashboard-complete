"""Security regression contracts for enrollment and public probe boundaries."""
from unittest.mock import patch

from extensions import db
from models.models import Server


def _server_count():
    return Server.query.count()


def test_agent_register_is_disabled_without_enrollment_key(client, app):
    """Anonymous registration is fail-closed unless an operator configured enrollment."""
    with app.app_context():
        app.config["AGENT_ENROLLMENT_KEY"] = ""
        before = _server_count()
    response = client.post("/api/v1/agent/register", json={"hostname": "untrusted"})
    assert response.status_code == 403
    with app.app_context():
        assert _server_count() == before


def test_agent_register_requires_matching_bearer_enrollment_key(client, app):
    """Only a configured enrollment bearer key may mint a first agent credential."""
    with app.app_context():
        app.config["AGENT_ENROLLMENT_KEY"] = "test-enrollment-key-at-least-32-chars"
        before = _server_count()

    missing = client.post("/api/v1/agent/register", json={"hostname": "candidate"})
    wrong = client.post(
        "/api/v1/agent/register",
        json={"hostname": "candidate"},
        headers={"Authorization": "Bearer wrong-key"},
    )
    assert missing.status_code == 403
    assert wrong.status_code == 403
    with app.app_context():
        assert _server_count() == before

    good = client.post(
        "/api/v1/agent/register",
        json={"hostname": "candidate", "ip": "203.0.113.10"},
        headers={"Authorization": "Bearer test-enrollment-key-at-least-32-chars", "X-Forwarded-For": "203.0.113.10"},
    )
    assert good.status_code == 201
    body = good.get_json()
    assert body["uuid"] and body["agent_key"] and body["server_id"]


def test_anonymous_public_probe_is_rejected_before_network_probe(client):
    """A visitor may read existing probe results but cannot make this host scan a target."""
    with patch("api.probe._probe_stats") as probe:
        response = client.post(
            "/api/v1/probe/public/ping",
            json={"host": "8.8.8.8", "port": 443, "protocol": "tcp"},
        )
    assert response.status_code in {401, 403}
    probe.assert_not_called()


def test_probe_malformed_count_is_a_controlled_bad_request(client, auth_headers):
    """Malformed input must not cause a 500 before authorization/validation finishes."""
    response = client.post(
        "/api/v1/probe/ping",
        json={"host": "8.8.8.8", "port": 443, "protocol": "tcp", "count": "not-a-number"},
        headers=auth_headers,
    )
    assert response.status_code == 400


def test_overview_uses_escaping_for_all_public_server_fields():
    """Source guard: every dynamic card and summary field is escaped before innerHTML."""
    import os

    repo_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    overview_path = os.path.join(
        repo_root, "frontend-vite", "src", "pages", "overviewPage.js"
    )
    if not os.path.exists(overview_path):
        import pytest

        pytest.skip("frontend source not present in this checkout")
    source = open(overview_path, encoding="utf-8").read()
    forbidden = [
        'aria-label="${displayName}"',
        "${s.flag || '🌐'}",
        "<strong>${displayName}</strong>",
        "${s.provider_guess || s.provider || t('unknownProvider')}",
        "${s.location || s.city || s.region || s.country || t('unknownRegion')}",
        '<li><b>${s.name}</b>',
        '<li><b>${server.name}</b>',
        '<li><b>${k}</b>',
    ]
    assert all(token not in source for token in forbidden)
    assert 'aria-label="${safeDisplayName}"' in source
    assert "const safeDisplayName = escText(displayName);" in source
    assert "const safeFlag = escText(s.flag || '🌐');" in source
    assert '<strong>${safeDisplayName}</strong>' in source
