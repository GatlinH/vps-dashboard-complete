"""Single-source, public-safe release provenance metadata."""
import json
import os
from pathlib import Path

FIELDS = (
    "git_sha", "image_revision", "image_source", "release_version",
    "frontend_entry", "frontend_sha256", "compose_sha256",
)
ENV_NAMES = {
    "git_sha": "GIT_SHA", "image_revision": "IMAGE_REVISION",
    "image_source": "IMAGE_SOURCE", "release_version": "RELEASE_VERSION",
    "frontend_entry": "FRONTEND_ENTRY", "frontend_sha256": "FRONTEND_SHA256",
    "compose_sha256": "COMPOSE_SHA256",
}


def _value(value):
    value = str(value or "").strip()
    return value if value else "unknown"


def load_provenance(path=None):
    configured = path or os.getenv("RELEASE_PROVENANCE_FILE", "")
    data = {}
    if configured:
        provenance_path = Path(configured)
        if provenance_path.is_file():
            try:
                loaded = json.loads(provenance_path.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    data = loaded
            except (OSError, ValueError, TypeError):
                pass
    return {
        field: _value(data.get(field) or os.getenv(ENV_NAMES[field]))
        for field in FIELDS
    }
