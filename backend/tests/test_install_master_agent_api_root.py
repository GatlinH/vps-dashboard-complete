"""Regression tests for scripts/install-master-agent.sh AGENT_API_ROOT derivation.

Root cause (2026-09-10): the installer defaulted AGENT_API_ROOT to
http://127.0.0.1:5000 — the container-internal Gunicorn bind — while
docker-compose.yml publishes the API on the host as :4500->5000. Agents
installed on the panel host therefore failed every push (Connection
refused) and the dashboard flipped the server to offline although it was
healthy. The installer must derive the host-side published port from
compose instead of hardcoding the container port.
"""

from pathlib import Path
import re

REPO = Path(__file__).resolve().parents[2]
INSTALLER = REPO / "scripts" / "install-master-agent.sh"


def _installer_text() -> str:
    assert INSTALLER.exists(), f"missing {INSTALLER}"
    return INSTALLER.read_text(encoding="utf-8")


def test_no_container_port_default_in_installer():
    """AGENT_API_ROOT must not fall back to the container-internal :5000."""
    # Ignore the docstring (which documents the old bug) and bash comments;
    # only live assignment/default lines count.
    code = "\n".join(
        ln for ln in INSTALLER.read_text(encoding="utf-8").splitlines()
        if not ln.strip().startswith("#")
    )
    assert "127.0.0.1:5000" not in code, (
        "installer still hardcodes container-internal port 5000 as "
        "AGENT_API_ROOT default — agents on the panel host cannot reach it"
    )


def test_api_root_derived_from_compose_published_port():
    """The default must come from `docker compose port` (host-side mapping)."""
    text = _installer_text()
    assert "compose" in text and "port api 5000" in text, (
        "installer must derive the published API port via docker compose port"
    )
    # Fallback when compose is unavailable must be the documented host port.
    assert 'port="4500"' in text, (
        "fallback port must be 4500 (the host-side published API port)"
    )


def test_wildcard_publish_ip_maps_to_loopback():
    """0.0.0.0/[::] published binds must become 127.0.0.1 for a host-local agent."""
    text = _installer_text()
    assert '"0.0.0.0"' in text and '"[::]"' in text, (
        "installer must map wildcard publish IPs to 127.0.0.1"
    )


def test_explicit_agent_api_root_still_wins():
    """An operator-provided AGENT_API_ROOT must override derivation."""
    text = _installer_text()
    assert '[[ -z "${AGENT_API_ROOT:-}" ]]' in text, (
        "derivation must be guarded by an empty AGENT_API_ROOT check"
    )


def test_installer_syntax():
    """bash -n must pass (cheap syntax gate; CI has no shellcheck stage)."""
    import subprocess
    result = subprocess.run(
        ["bash", "-n", str(INSTALLER)], capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, f"bash -n failed: {result.stderr}"


def _extract_function(text: str) -> str:
    match = re.search(
        r"derive_agent_api_root\(\) \{\n(.*?)\n\}\n", text, re.S
    )
    assert match, "derive_agent_api_root function not found"
    return "derive_agent_api_root() {\n" + match.group(1) + "\n}"


def test_derivation_falls_back_when_docker_missing():
    """With docker unusable (fresh install / api not up), set -e must survive and the 4500 fallback must apply."""
    import subprocess
    fn = _extract_function(_installer_text())
    script = (
        "#!/usr/bin/env bash\n"
        "set -Eeuo pipefail\n"
        'compose_args=(--env-file /nonexistent/secrets.env -f docker-compose.yml)\n'
        + fn + "\n"
        "derive_agent_api_root\n"
        'echo "root=${AGENT_API_ROOT}"\n'
    )
    result = subprocess.run(
        ["bash", "-c", script],
        capture_output=True, text=True, timeout=60,
        env={"PATH": "/usr/bin:/bin"},
    )
    assert result.returncode == 0, f"derivation died under set -e: {result.stderr}"
    assert "root=http://127.0.0.1:4500" in result.stdout, result.stdout


def test_derivation_uses_compose_mapping_when_available():
    """A live 0.0.0.0:PORT mapping must be rewritten to 127.0.0.1:PORT."""
    import subprocess
    fn = _extract_function(_installer_text())
    stub_dir = None
    import tempfile, os
    with tempfile.TemporaryDirectory() as td:
        stub_dir = td
        (Path(td) / "docker").write_text("#!/usr/bin/env bash\necho '0.0.0.0:8443'\n")
        os.chmod(Path(td) / "docker", 0o755)
        script = (
            "#!/usr/bin/env bash\n"
            "set -Eeuo pipefail\n"
            'compose_args=(--env-file /dev/null)\n'
            + fn + "\n"
            "derive_agent_api_root\n"
            'echo "root=${AGENT_API_ROOT}"\n'
        )
        env = {"PATH": f"{td}:/usr/bin:/bin"}
        result = subprocess.run(
            ["bash", "-c", script], capture_output=True, text=True, timeout=60, env=env
        )
    assert result.returncode == 0, result.stderr
    assert "root=http://127.0.0.1:8443" in result.stdout, result.stdout
