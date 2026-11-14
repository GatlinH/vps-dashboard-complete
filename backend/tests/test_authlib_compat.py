"""Dependency security boundaries and the application's disabled OAuth contract."""

import base64
import hashlib
import hmac
from importlib.metadata import version
import json
from pathlib import Path

from authlib.integrations.flask_client import OAuth
from authlib.jose import JsonWebToken
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519
from flask import Flask
import pytest

from api.auth import OAuth as ApplicationOAuth


CLAIMS = {"sub": "synthetic-authlib-compat", "purpose": "security-regression"}
NONEMPTY_SECRET = b"synthetic-authlib-compat-hmac-secret-not-for-production-use".ljust(64, b"!")


@pytest.fixture(params=("HS256", "HS384", "HS512"))
def algorithm(request):
    return request.param


@pytest.fixture
def openssh_tab_public_key():
    public_key = ed25519.Ed25519PrivateKey.generate().public_key()
    openssh_key = public_key.public_bytes(
        serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH
    )
    tab_key = openssh_key.replace(b" ", b"\t", 1)
    parsed_key = serialization.load_ssh_public_key(tab_key)
    assert isinstance(parsed_key, ed25519.Ed25519PublicKey)
    return tab_key


def _signed_hmac_token(algorithm, secret):
    header = json.dumps({"alg": algorithm}, separators=(",", ":")).encode()
    payload = json.dumps(CLAIMS, separators=(",", ":")).encode()
    segments = [base64.urlsafe_b64encode(part).rstrip(b"=") for part in (header, payload)]
    signing_input = b".".join(segments)
    digest = getattr(hashlib, "sha" + algorithm[2:])
    signature = hmac.new(secret, signing_input, digest).digest()
    return signing_input + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")


def test_authlib_security_dependency_pins():
    requirements = Path(__file__).resolve().parents[1] / "requirements.txt"
    pins = requirements.read_text(encoding="utf-8").splitlines()
    assert "authlib==1.9.5" in pins
    assert "joserfc==1.8.0" in pins


def test_authlib_security_dependency_versions():
    assert version("Authlib") == "1.9.5"
    assert version("joserfc") == "1.8.0"


def test_nonempty_hmac_round_trip(algorithm):
    jwt = JsonWebToken([algorithm])
    token = jwt.encode({"alg": algorithm}, CLAIMS, NONEMPTY_SECRET)
    claims = jwt.decode(token, NONEMPTY_SECRET)
    claims.validate()
    assert dict(claims) == CLAIMS
    manual_claims = jwt.decode(_signed_hmac_token(algorithm, NONEMPTY_SECRET), NONEMPTY_SECRET)
    manual_claims.validate()
    assert dict(manual_claims) == CLAIMS


@pytest.mark.parametrize("operation", ("encode", "decode"))
def test_empty_hmac_rejected(algorithm, operation):
    jwt = JsonWebToken([algorithm])
    with pytest.raises(ValueError, match="oct key material must not be empty"):
        if operation == "encode":
            jwt.encode({"alg": algorithm}, CLAIMS, b"")
        else:
            jwt.decode(_signed_hmac_token(algorithm, b""), b"")


@pytest.mark.parametrize("operation", ("encode", "decode"))
def test_openssh_tab_public_key_rejected_as_hmac(algorithm, operation, openssh_tab_public_key):
    jwt = JsonWebToken([algorithm])
    with pytest.raises(ValueError, match="This key may not be safe to import"):
        if operation == "encode":
            jwt.encode({"alg": algorithm}, CLAIMS, openssh_tab_public_key)
        else:
            jwt.decode(
                _signed_hmac_token(algorithm, openssh_tab_public_key), openssh_tab_public_key
            )


def test_production_oauth_class_remains_flask_compatible():
    assert ApplicationOAuth is OAuth
    flask_app = Flask(__name__)
    oauth = OAuth()
    oauth.init_app(flask_app)
    assert flask_app.extensions["authlib.integrations.flask_client"] is oauth


def test_production_oauth_providers_remain_disabled(client):
    response = client.get("/api/v1/auth/oauth/providers")
    assert response.status_code == 200
    assert response.get_json() == {"google": False, "github": False}
