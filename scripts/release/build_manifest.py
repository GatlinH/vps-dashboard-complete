#!/usr/bin/env python3
"""Write signed release manifest and SHA256SUMS from built agent assets."""
from __future__ import annotations
import argparse
import os
from pathlib import Path
from sign_manifest import sha256_file, sign_manifest

parser = argparse.ArgumentParser()
parser.add_argument("--version", required=True)
parser.add_argument("--assets-dir", required=True)
parser.add_argument("--private-key-env", default="AGENT_RELEASE_ED25519_PRIVATE_KEY")
args = parser.parse_args()
key = os.environ.get(args.private_key_env, "")
if not key:
    raise SystemExit("missing signing key environment variable")
assets = []
for path in sorted(Path(args.assets_dir).iterdir()):
    if not path.is_file() or path.name in {"manifest.json", "manifest.sig", "manifest.pub", "SHA256SUMS"}:
        continue
    parts = path.name.split("-")
    if len(parts) < 5 or parts[:3] != ["vps", "dashboard", "agent"]:
        raise SystemExit(f"unexpected asset name: {path.name}")
    platform, arch = parts[3], parts[4].removesuffix(".exe")
    if platform not in {"linux", "windows"} or arch not in {"amd64", "arm64"}:
        raise SystemExit(f"unexpected target: {path.name}")
    assets.append({"name": path.name, "platform": platform, "arch": arch, "sha256": sha256_file(str(path))})
manifest, signature, public_key = sign_manifest({"version": args.version, "assets": assets}, key)
out = Path(args.assets_dir)
(out / "manifest.json").write_text(manifest + "\n")
(out / "manifest.sig").write_text(signature + "\n")
(out / "manifest.pub").write_text(public_key + "\n")
(out / "SHA256SUMS").write_text("".join(f"{item['sha256']}  {item['name']}\n" for item in assets))
