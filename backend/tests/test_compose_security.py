from pathlib import Path

import pytest


def test_compose_runtime_security_and_writable_paths():
    yaml = pytest.importorskip("yaml")
    compose = yaml.safe_load((Path(__file__).parents[2] / "docker-compose.yml").read_text())
    for name in ("schema_init", "api", "agent_consumer"):
        service = compose["services"][name]
        assert service["user"] == "1000:1000"
        assert "no-new-privileges:true" in service["security_opt"]
        assert any(str(item).startswith("/tmp:size=") and "mode=1777" in str(item) for item in service["tmpfs"])
        assert service.get("read_only") is True
