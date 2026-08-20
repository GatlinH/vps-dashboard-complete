#!/usr/bin/env python3
"""Emit public release metadata after the frontend has been built."""
import hashlib
import json
import os
from pathlib import Path

root = Path(os.environ.get("FRONTEND_DIST_DIR", "frontend-dist"))
entry = os.environ.get("FRONTEND_ENTRY", "")
if not entry:
    candidates = sorted((root / "assets").glob("main-*.js"))
    entry = str(candidates[0].relative_to(root)) if candidates else "unknown"
entry_path = root / entry if entry != "unknown" else None
metadata = {
    "git_sha": os.environ.get("GIT_SHA") or "unknown",
    "image_revision": os.environ.get("IMAGE_REVISION") or os.environ.get("GIT_SHA") or "unknown",
    "image_source": os.environ.get("IMAGE_SOURCE") or "unknown",
    "release_version": os.environ.get("RELEASE_VERSION") or "unknown",
    "frontend_entry": entry,
    "frontend_sha256": hashlib.sha256(entry_path.read_bytes()).hexdigest() if entry_path and entry_path.is_file() else "unknown",
    "compose_sha256": os.environ.get("COMPOSE_SHA256") or "unknown",
}
out = Path(os.environ.get("PROVENANCE_OUTPUT", "release-provenance.json"))
out.write_text(json.dumps(metadata, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
