import hashlib
import json

from services.release_provenance import load_provenance


def test_missing_release_metadata_is_unknown_and_public_shape_is_allowlisted(client):
    response = client.get("/api/v1/revision")

    assert response.status_code == 200
    assert response.get_json() == {
        "git_sha": "unknown",
        "image_revision": "unknown",
        "image_source": "unknown",
        "release_version": "unknown",
        "frontend_entry": "unknown",
        "frontend_sha256": "unknown",
        "compose_sha256": "unknown",
    }


def test_supplied_release_metadata_round_trips_without_environment_secrets(client, tmp_path, monkeypatch):
    entry = "assets/main-example.js"
    entry_bytes = b"console.log('release');\n"
    (tmp_path / "assets").mkdir()
    (tmp_path / entry).write_bytes(entry_bytes)
    metadata = {
        "git_sha": "a" * 40,
        "image_revision": "a" * 40,
        "image_source": "https://github.com/example/dashboard",
        "release_version": "1.2.3",
        "frontend_entry": entry,
        "frontend_sha256": hashlib.sha256(entry_bytes).hexdigest(),
        "compose_sha256": "b" * 64,
    }
    metadata_path = tmp_path / "release-provenance.json"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    monkeypatch.setenv("RELEASE_PROVENANCE_FILE", str(metadata_path))
    monkeypatch.setenv("JWT_SECRET_KEY", "must-not-leak")
    monkeypatch.setenv("MYSQL_PASSWORD", "must-not-leak-either")

    response = client.get("/api/v1/revision")

    assert response.status_code == 200
    assert response.get_json() == metadata
    serialized = response.get_data(as_text=True)
    assert "must-not-leak" not in serialized
    assert "MYSQL_PASSWORD" not in serialized


def test_environment_values_are_used_only_when_explicitly_supplied(monkeypatch):
    monkeypatch.delenv("RELEASE_PROVENANCE_FILE", raising=False)
    monkeypatch.setenv("GIT_SHA", "f" * 40)
    monkeypatch.setenv("IMAGE_REVISION", "e" * 40)
    monkeypatch.setenv("IMAGE_SOURCE", "https://example.test/source")

    metadata = load_provenance()

    assert metadata["git_sha"] == "f" * 40
    assert metadata["image_revision"] == "e" * 40
    assert metadata["image_source"] == "https://example.test/source"
    assert metadata["release_version"] == "unknown"
