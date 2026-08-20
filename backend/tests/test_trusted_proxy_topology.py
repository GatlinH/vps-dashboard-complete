import os
import shutil
import subprocess
from pathlib import Path

from flask import request

from app import create_app


ROOT = Path(__file__).resolve().parents[2]


def _render_compose(*files):
    if not shutil.which("docker"):
        return None
    env = os.environ.copy()
    env["COMPOSE_FILE"] = ":".join(str(ROOT / name) for name in files)
    result = subprocess.run(
        ["docker", "compose", "config", "--format", "json"],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
    )
    if result.returncode:
        return None
    import json
    return json.loads(result.stdout)


def test_direct_publish_does_not_trust_forwarded_headers_by_default():
    rendered = _render_compose("docker-compose.yml")
    if rendered is not None:
        api = rendered["services"]["api"]
        assert str(api["environment"]["TRUST_PROXY"]) == "0"
        assert api["ports"][0]["published"] == "4500"
        return

    text = (ROOT / "docker-compose.yml").read_text()
    assert "TRUST_PROXY: ${TRUST_PROXY:-0}" in text
    assert '"${PUBLIC_BIND_ADDRESS:-0.0.0.0}:4500:5000"' in text


def test_split_frontend_is_only_public_edge_and_trusts_one_hop():
    rendered = _render_compose("docker-compose.yml", "docker-compose.frontend.yml")
    if rendered is not None:
        api = rendered["services"]["api"]
        frontend = rendered["services"]["frontend"]
        assert not api.get("ports")
        assert str(api["environment"]["TRUST_PROXY"]) == "1"
        assert str(api["environment"]["PROXY_FIX_X_FOR"]) == "1"
        assert frontend["ports"][0]["published"] == "4500"
        return

    text = (ROOT / "docker-compose.frontend.yml").read_text()
    assert "ports: !override []" in text
    assert "TRUST_PROXY: ${TRUST_PROXY:-1}" in text
    assert "PROXY_FIX_X_FOR: ${PROXY_FIX_X_FOR:-1}" in text


def test_trust_off_ignores_all_forwarded_request_metadata():
    app = create_app(TESTING=True, SQLALCHEMY_DATABASE_URI="sqlite:///:memory:", TRUST_PROXY=False)

    @app.get("/_proxy-contract")
    def proxy_contract():
        return {
            "remote_addr": request.remote_addr,
            "is_secure": request.is_secure,
            "host": request.host,
        }

    response = app.test_client().get(
        "/_proxy-contract",
        base_url="http://direct.example:4500",
        environ_overrides={"REMOTE_ADDR": "198.51.100.20"},
        headers={
            "X-Forwarded-For": "10.0.0.1",
            "X-Forwarded-Proto": "https",
            "X-Forwarded-Host": "forged.example",
        },
    )
    assert response.get_json() == {
        "remote_addr": "198.51.100.20",
        "is_secure": False,
        "host": "direct.example:4500",
    }
