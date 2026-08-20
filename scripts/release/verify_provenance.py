#!/usr/bin/env python3
import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


PUBLIC_FIELDS = frozenset({
    "git_sha",
    "image_revision",
    "image_source",
    "release_version",
    "frontend_entry",
    "frontend_sha256",
    "compose_sha256",
})
MAX_RUNTIME_BYTES = 64 * 1024


def validate_public_metadata(metadata, label):
    if not isinstance(metadata, dict):
        raise ValueError(f"{label} provenance must be a JSON object")
    fields = set(metadata)
    if fields != PUBLIC_FIELDS:
        missing = sorted(PUBLIC_FIELDS - fields)
        extra = sorted(fields - PUBLIC_FIELDS)
        details = []
        if missing:
            details.append(f"missing fields: {', '.join(missing)}")
        if extra:
            details.append(f"unexpected fields: {', '.join(extra)}")
        raise ValueError(f"{label} provenance has invalid public fields ({'; '.join(details)})")
    if any(not isinstance(metadata[field], str) for field in PUBLIC_FIELDS):
        raise ValueError(f"{label} provenance fields must all be strings")
    return metadata


def fetch_runtime(runtime_url, timeout=5.0, max_bytes=MAX_RUNTIME_BYTES):
    parsed = urlparse(runtime_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("runtime URL must be an absolute HTTP(S) URL")
    endpoint = runtime_url.rstrip("/") + "/api/v1/revision"
    request = Request(endpoint, headers={"Accept": "application/json"})
    try:
        with urlopen(request, timeout=timeout) as response:
            content_length = response.headers.get("Content-Length")
            if content_length and int(content_length) > max_bytes:
                raise ValueError("runtime provenance response exceeds size limit")
            payload = response.read(max_bytes + 1)
    except (HTTPError, URLError, TimeoutError, OSError, ValueError) as exc:
        raise ValueError(f"runtime provenance request failed: {exc}") from exc
    if len(payload) > max_bytes:
        raise ValueError("runtime provenance response exceeds size limit")
    try:
        metadata = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("runtime provenance response is not valid JSON") from exc
    return validate_public_metadata(metadata, "runtime")


def verify_artifact(source_sha, image_revision, artifact, frontend_root, compose_path):
    if not source_sha or source_sha == "unknown" or image_revision != source_sha:
        raise ValueError("revision mismatch or unknown revision")
    validate_public_metadata(artifact, "artifact")
    if artifact.get("git_sha") != source_sha or artifact.get("image_revision") != image_revision:
        raise ValueError("artifact revision mismatch")
    if artifact.get("frontend_entry") == "unknown":
        raise ValueError("frontend entry unknown")
    entry = frontend_root / artifact["frontend_entry"]
    if hashlib.sha256(entry.read_bytes()).hexdigest() != artifact["frontend_sha256"]:
        raise ValueError("frontend hash mismatch")
    if hashlib.sha256(compose_path.read_bytes()).hexdigest() != artifact["compose_sha256"]:
        raise ValueError("compose hash mismatch")


def verify(source_sha, image_revision, artifact, runtime, frontend_root, compose_path):
    verify_artifact(source_sha, image_revision, artifact, frontend_root, compose_path)
    validate_public_metadata(runtime, "runtime")
    if artifact != runtime:
        raise ValueError("runtime provenance mismatch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifact", default="release-provenance.json")
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--image-revision", default=None)
    parser.add_argument("--frontend-root", default="frontend-dist")
    parser.add_argument("--compose", default="docker-compose.yml")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--runtime-url", help="live deployment base URL")
    mode.add_argument(
        "--offline",
        action="store_true",
        help="verify source/artifact/frontend/Compose only; does not verify a runtime",
    )
    args = parser.parse_args()
    try:
        artifact = validate_public_metadata(
            json.loads(Path(args.artifact).read_text(encoding="utf-8")),
            "artifact",
        )
        kwargs = {
            "source_sha": args.source_sha,
            "image_revision": args.image_revision or args.source_sha,
            "artifact": artifact,
            "frontend_root": Path(args.frontend_root),
            "compose_path": Path(args.compose),
        }
        if args.offline:
            verify_artifact(**kwargs)
        else:
            verify(runtime=fetch_runtime(args.runtime_url), **kwargs)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"provenance verification failed: {exc}", file=sys.stderr)
        raise SystemExit(1) from None
