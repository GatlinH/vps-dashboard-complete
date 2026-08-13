"""The installer must consume only a pinned, signed, versioned agent release."""
import base64
import hashlib
import json
import subprocess
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


ROOT = Path(__file__).parents[2]


def _sign_manifest(version, asset_name, body):
    private = Ed25519PrivateKey.generate()
    public = private.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    manifest = {
        "version": version,
        "assets": [{
            "name": asset_name,
            "platform": "linux",
            "arch": "amd64",
            "sha256": hashlib.sha256(body).hexdigest(),
        }],
    }
    canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
    return manifest, base64.b64encode(private.sign(canonical)).decode(), base64.b64encode(public).decode()


def _release(tmp_path, version="agent-v9", body=b"#!/bin/sh\necho agent\n"):
    asset = "vps-dashboard-agent-linux-amd64"
    manifest, sig, public = _sign_manifest(version, asset, body)
    directory = tmp_path / version
    directory.mkdir(parents=True)
    (directory / asset).write_bytes(body)
    (directory / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")) + "\n")
    (directory / "manifest.sig").write_text(sig + "\n")
    return asset, public


def test_signed_release_endpoint_only_serves_configured_version(client, app, tmp_path):
    asset, _ = _release(tmp_path)
    with app.app_context():
        app.config.update(AGENT_RELEASE_DIR=str(tmp_path), AGENT_RELEASE_VERSION="agent-v9")
        got = client.get(f"/api/v1/agent/releases/agent-v9/{asset}")
        assert got.status_code == 200
        assert got.data.startswith(b"#!/bin/sh")
        assert got.headers["Cache-Control"] == "public, max-age=31536000, immutable"
        assert client.get("/api/v1/agent/releases/agent-v8/manifest.json").status_code == 404
        assert client.get("/api/v1/agent/releases/agent-v9/../../config.py").status_code == 404


def test_install_script_pins_public_key_and_verifies_before_replacement(client, app, tmp_path):
    asset, _ = _release(tmp_path)
    with app.app_context():
        app.config.update(
            AGENT_RELEASE_DIR=str(tmp_path), AGENT_RELEASE_VERSION="agent-v9",
        )
        response = client.get("/api/v1/agent/install.sh")
    assert response.status_code == 200
    script = response.get_data(as_text=True)
    assert 'RELEASE_VERSION="agent-v9"' in script
    repository_pin = (ROOT / "scripts/release/agent-release-ed25519-public.b64").read_text().strip()
    assert f'PINNED_PUBLIC_KEY="{repository_pin}"' in script
    assert 'BASE_URL="$API_ROOT/api/v1/agent/releases/$RELEASE_VERSION"' in script
    assert '"$BASE_URL/manifest.json"' in script
    assert "openssl pkeyutl -verify -pubin -inkey" in script
    assert "sha256sum --check" in script
    assert "install -m 0700 \"$tmp_asset\" \"$INSTALL_DIR/vps-dashboard-agent\"" in script
    # The binary must be atomically installed only after all verification gates.
    assert script.index("openssl pkeyutl -verify") < script.index("install -m 0700 \"$tmp_asset\"")
    assert script.index("sha256sum --check") < script.index("install -m 0700 \"$tmp_asset\"")
    assert "ExecStart=$INSTALL_DIR/vps-dashboard-agent" in script


def test_install_script_fails_closed_without_configured_release(client, app):
    with app.app_context():
        app.config.update(AGENT_RELEASE_DIR="", AGENT_RELEASE_VERSION="")
        script = client.get("/api/v1/agent/install.sh").get_data(as_text=True)
    assert 'RELEASE_VERSION=""' in script
    assert 'missing configured signed Agent release' in script
    assert "fetch_runtime vps-agent.py" not in script


def test_served_installer_has_valid_bash_syntax(client, tmp_path):
    with client.application.app_context():
        client.application.config.update(AGENT_RELEASE_DIR=str(tmp_path), AGENT_RELEASE_VERSION="agent-v9")
        script = client.get("/api/v1/agent/install.sh").get_data(as_text=True)
    path = tmp_path / "install.sh"
    path.write_text(script)
    result = subprocess.run(["bash", "-n", str(path)], text=True, capture_output=True)
    assert result.returncode == 0, result.stderr


def test_manifest_asset_integrity_is_installer_side_contract(client, app, tmp_path):
    """The served manifest has exactly the asset hash installer checks."""
    asset, _ = _release(tmp_path, body=b"real-binary")
    with app.app_context():
        app.config.update(AGENT_RELEASE_DIR=str(tmp_path), AGENT_RELEASE_VERSION="agent-v9")
        manifest = client.get("/api/v1/agent/releases/agent-v9/manifest.json").get_json()
        body = client.get(f"/api/v1/agent/releases/agent-v9/{asset}").data
    entry = manifest["assets"][0]
    assert entry["name"] == asset
    assert entry["sha256"] == hashlib.sha256(body).hexdigest()


def test_repository_pin_is_not_operator_supplied_at_install_time(client, app):
    """Trust anchor is compiled into the served script, not a curl response."""
    with app.app_context():
        script = client.get("/api/v1/agent/install.sh").get_data(as_text=True)
    expected = (ROOT / "scripts/release/agent-release-ed25519-public.b64").read_text().strip()
    assert f'PINNED_PUBLIC_KEY="{expected}"' in script
    assert '"$BASE_URL/manifest.pub"' not in script
    assert "--public-key" not in script
    assert "curl" in script
