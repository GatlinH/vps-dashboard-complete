from pathlib import Path


ROOT = Path(__file__).parents[2]


def test_dockerfile_builds_one_provenance_artifact_and_sets_oci_labels():
    dockerfile = (ROOT / "Dockerfile").read_text(encoding="utf-8")

    for arg in ("GIT_SHA", "IMAGE_REVISION", "IMAGE_SOURCE", "RELEASE_VERSION", "COMPOSE_SHA256"):
        assert f"ARG {arg}" in dockerfile
    assert "scripts/release/build_provenance.py" in dockerfile
    assert "org.opencontainers.image.revision=$IMAGE_REVISION" in dockerfile
    assert "org.opencontainers.image.source=$IMAGE_SOURCE" in dockerfile
    assert "org.opencontainers.image.version=$RELEASE_VERSION" in dockerfile
    assert "RELEASE_PROVENANCE_FILE=/app/release-provenance.json" in dockerfile


def test_publish_workflow_passes_revision_source_version_and_verifies_artifact():
    workflow = (ROOT / ".github/workflows/deploy.yml").read_text(encoding="utf-8")

    assert "GIT_SHA=${{ github.sha }}" in workflow
    assert "IMAGE_SOURCE=${{ github.server_url }}/${{ github.repository }}" in workflow
    assert "RELEASE_VERSION=" in workflow
    assert "COMPOSE_SHA256=" in workflow
    assert "verify_provenance.py" in workflow
