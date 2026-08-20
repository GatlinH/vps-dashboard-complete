from pathlib import Path


def test_publish_workflow_hashes_compose_file_bytes_with_sha256sum():
    workflow = (Path(__file__).parents[1] / ".github/workflows/deploy.yml").read_text()
    assert "COMPOSE_SHA256: ${{ hashFiles('docker-compose.yml') }}" not in workflow
    assert "COMPOSE_SHA256=$(sha256sum docker-compose.yml | cut -d' ' -f1)" in workflow
    assert "echo \"COMPOSE_SHA256=$COMPOSE_SHA256\" >> \"$GITHUB_ENV\"" in workflow
    assert "COMPOSE_SHA256=${{ env.COMPOSE_SHA256 }}" in workflow
