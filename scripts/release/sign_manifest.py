#!/usr/bin/env python3
"""Canonical Ed25519 signatures for agent release manifests."""
from __future__ import annotations

import base64
import hashlib
import json
import re
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey

_SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _canonical(data: dict[str, Any]) -> bytes:
    assets = data.get("assets")
    if not isinstance(data.get("version"), str) or not data["version"]:
        raise ValueError("version is required")
    if not isinstance(assets, list) or not assets:
        raise ValueError("assets are required")
    for asset in assets:
        if not isinstance(asset, dict) or not all(isinstance(asset.get(k), str) and asset[k] for k in ("name", "platform", "arch", "sha256")):
            raise ValueError("asset fields are required")
        if not _SHA256.fullmatch(asset["sha256"]):
            raise ValueError("asset sha256 must be lowercase hex")
    return json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def sign_manifest(data: dict[str, Any], private_key_b64: str) -> tuple[str, str, str]:
    key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(private_key_b64, validate=True))
    canonical = _canonical(data)
    signature = key.sign(canonical)
    public = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return canonical.decode("utf-8"), base64.b64encode(signature).decode("ascii"), base64.b64encode(public).decode("ascii")


def verify_manifest(manifest: str, signature_b64: str, public_key_b64: str) -> bool:
    try:
        data = json.loads(manifest)
        canonical = _canonical(data)
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64, validate=True)).verify(base64.b64decode(signature_b64, validate=True), canonical)
        return True
    except Exception:
        return False


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
