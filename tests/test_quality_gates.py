import json
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS_SCRIPT = ROOT / "scripts" / "check-css-debt.py"
TASK_SCRIPT = ROOT / "scripts" / "check-agent-tasks-parity.py"


def run_script(script, *args):
    return subprocess.run(
        [sys.executable, str(script), *map(str, args)],
        cwd=ROOT,
        text=True,
        capture_output=True,
    )


def write_css_tree(tmp_path, files):
    src = tmp_path / "src"
    for name, contents in files.items():
        path = src / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(contents)
    return src


def test_css_debt_unchanged_passes_and_emits_stable_json(tmp_path):
    src = write_css_tree(tmp_path, {"z.css": "a { color: red !important; }\n", "a.css": "b {}\n"})
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps({"total": 1, "files": {"z.css": 1}}))
    result = run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline)
    assert result.returncode == 0
    payload = json.loads(result.stdout)
    assert payload["files"] == 2
    assert payload["important_total"] == 1
    assert list(payload["details"]) == ["a.css", "z.css"]


def test_css_debt_increase_fails_and_decrease_passes(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "a { x: y !important; z: q !important; }\n"})
    baseline = tmp_path / "baseline.json"
    baseline.write_text(json.dumps({"total": 1, "files": {"a.css": 1}}))
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline).returncode != 0
    src.joinpath("a.css").write_text("a { x: y !important; }\n")
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline).returncode == 0


def test_css_debt_invalid_directory_fails(tmp_path):
    result = run_script(CSS_SCRIPT, "--source", tmp_path / "missing")
    assert result.returncode != 0
    assert "CSS source directory" in result.stderr


def test_agent_tasks_parity_passes_and_detects_drift(tmp_path):
    first = tmp_path / "agent_tasks.py"
    second = tmp_path / "windows-agent_tasks.py"
    first.write_text("same\n")
    second.write_text("same\n")
    result = run_script(TASK_SCRIPT, first, second)
    assert result.returncode == 0
    assert "sha256" in result.stdout
    second.write_text("drift\n")
    assert run_script(TASK_SCRIPT, first, second).returncode != 0
