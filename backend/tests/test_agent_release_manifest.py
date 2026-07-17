import base64
import importlib.util
import json
from pathlib import Path
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives import serialization

SPEC = importlib.util.spec_from_file_location("sign_manifest", Path(__file__).parents[2] / "scripts" / "release" / "sign_manifest.py")
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def test_manifest_signature_verifies_and_binds_asset_hash():
    private = Ed25519PrivateKey.generate()
    private_b64 = base64.b64encode(private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()
    manifest, signature, public_key = mod.sign_manifest({"version": "v9", "assets": [{"name": "agent-linux-amd64", "platform": "linux", "arch": "amd64", "sha256": "a" * 64}]}, private_b64)
    assert mod.verify_manifest(manifest, signature, public_key)
    tampered = json.loads(manifest)
    tampered["assets"][0]["sha256"] = "b" * 64
    assert not mod.verify_manifest(json.dumps(tampered), signature, public_key)


def test_manifest_rejects_missing_or_invalid_asset_hash():
    private = Ed25519PrivateKey.generate()
    private_b64 = base64.b64encode(private.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw, serialization.NoEncryption())).decode()
    try:
        mod.sign_manifest({"version": "v9", "assets": [{"name": "x", "platform": "linux", "arch": "amd64", "sha256": "bad"}]}, private_b64)
    except ValueError as error:
        assert "sha256" in str(error)
    else:
        raise AssertionError("invalid hash accepted")
