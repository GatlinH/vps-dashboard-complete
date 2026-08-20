import hashlib
import http.server
import importlib.util
import json
import subprocess
import sys
import threading
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "release" / "verify_provenance.py"


def _load_script():
    spec = importlib.util.spec_from_file_location("verify_provenance", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _provenance_fixture(tmp_path):
    entry = tmp_path / "assets" / "main.js"
    entry.parent.mkdir(exist_ok=True)
    entry.write_bytes(b"release asset")
    compose = tmp_path / "compose.yml"
    compose.write_text("services: {}\n", encoding="utf-8")
    sha = "c" * 40
    metadata = {
        "git_sha": sha,
        "image_revision": sha,
        "image_source": "https://github.com/example/dashboard",
        "release_version": "1.2.3",
        "frontend_entry": "assets/main.js",
        "frontend_sha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
        "compose_sha256": hashlib.sha256(compose.read_bytes()).hexdigest(),
    }
    artifact = tmp_path / "release-provenance.json"
    artifact.write_text(json.dumps(metadata), encoding="utf-8")
    return sha, metadata, artifact, compose


def _run_cli(tmp_path, response_body, status=200):
    sha, metadata, artifact, compose = _provenance_fixture(tmp_path)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/api/v1/revision":
                self.send_error(404)
                return
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(response_body)

        def log_message(self, _format, *_args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--artifact",
                str(artifact),
                "--source-sha",
                sha,
                "--image-revision",
                sha,
                "--frontend-root",
                str(tmp_path),
                "--compose",
                str(compose),
                "--runtime-url",
                f"http://127.0.0.1:{server.server_port}",
            ],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return result, metadata


def test_cli_fetches_matching_runtime_revision(tmp_path):
    _, metadata, _, _ = _provenance_fixture(tmp_path)
    result, _ = _run_cli(tmp_path, json.dumps(metadata).encode())
    assert result.returncode == 0, result.stderr


def test_cli_rejects_mismatching_runtime_revision(tmp_path):
    _, metadata, _, _ = _provenance_fixture(tmp_path)
    metadata["release_version"] = "different"
    result, _ = _run_cli(tmp_path, json.dumps(metadata).encode())
    assert result.returncode != 0
    assert "runtime provenance mismatch" in result.stderr.lower()


def test_cli_reports_unavailable_or_non_json_runtime_as_controlled_failure(tmp_path):
    result, _ = _run_cli(tmp_path, b"not json", status=503)
    assert result.returncode != 0
    assert "traceback" not in result.stderr.lower()
    assert "runtime" in result.stderr.lower()


def test_verifier_accepts_matching_source_label_runtime_frontend_and_compose(tmp_path):
    mod = _load_script()
    entry = tmp_path / "assets" / "main.js"
    entry.parent.mkdir()
    entry.write_bytes(b"release asset")
    compose = tmp_path / "compose.yml"
    compose.write_text("services: {}\n", encoding="utf-8")
    sha = "c" * 40
    metadata = {
        "git_sha": sha,
        "image_revision": sha,
        "image_source": "https://github.com/example/dashboard",
        "release_version": "1.2.3",
        "frontend_entry": "assets/main.js",
        "frontend_sha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
        "compose_sha256": hashlib.sha256(compose.read_bytes()).hexdigest(),
    }

    mod.verify(
        source_sha=sha,
        image_revision=sha,
        artifact=metadata,
        runtime=dict(metadata),
        frontend_root=tmp_path,
        compose_path=compose,
    )


def test_verifier_rejects_unknown_or_mismatched_revision(tmp_path):
    mod = _load_script()
    metadata = json.loads('{"git_sha":"unknown","image_revision":"unknown"}')

    try:
        mod.verify(
            source_sha="d" * 40,
            image_revision="e" * 40,
            artifact=metadata,
            runtime=metadata,
            frontend_root=tmp_path,
            compose_path=tmp_path / "missing.yml",
        )
    except ValueError as exc:
        assert "revision" in str(exc).lower()
    else:
        raise AssertionError("unknown/mismatched release revisions must fail verification")
