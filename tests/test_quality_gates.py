import json
import subprocess
import sys
import re
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
    baseline.write_text(json.dumps({"total": 1, "files": {"z.css": 1, "a.css": 0}}))
    result = run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline)
    assert result.returncode == 0
    payload = json.JSONDecoder().raw_decode(result.stdout)[0]
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

def test_real_css_gate_passes():
    assert run_script(CSS_SCRIPT).returncode == 0

def test_css_empty_scan_fails(tmp_path):
    src = tmp_path / "src"; src.mkdir()
    baseline = tmp_path / "b.json"; baseline.write_text(json.dumps({"total": 0, "files": {}}))
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline).returncode != 0

def test_css_scan_below_baseline_floor_fails_with_counts(tmp_path):
    src = write_css_tree(tmp_path, {"only.css": "x{}\n"})
    baseline = tmp_path / "b.json"
    baseline.write_text(json.dumps({"total": 0, "files": {f"f{i}.css": 0 for i in range(14)}}))
    result = run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline)
    assert result.returncode != 0
    assert "scanned=1" in result.stderr and "expected=14" in result.stderr

def test_css_empty_baseline_allows_nonempty_source(tmp_path):
    src = write_css_tree(tmp_path, {"new.css": "x{}\n"})
    baseline = tmp_path / "b.json"
    baseline.write_text(json.dumps({"total": 0, "files": {}}))
    result = run_script(CSS_SCRIPT, "--source", src, "--baseline", baseline)
    assert "fewer files than baseline" not in result.stderr

def test_baseline_sum_mismatch_fails(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "x{}\n"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 2, "files": {"a.css": 1}}))
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b).returncode != 0

def test_new_zero_important_file_fails(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "x{}\n"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 0, "files": {}}))
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b).returncode != 0

def test_important_variant_counted(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "x{a: b ! IMPORTANT}\n"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 1, "files": {"a.css": 1}}))
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b).returncode == 0

def test_real_parity_passes():
    assert run_script(TASK_SCRIPT).returncode == 0

def test_parity_same_file_does_not_pass(tmp_path):
    p = tmp_path / "a.py"; p.write_text("x")
    assert run_script(TASK_SCRIPT, "--files", p).returncode != 0

def test_parity_duplicate_paths_rejected(tmp_path):
    p = tmp_path / "a.py"; p.write_text("x")
    result = run_script(TASK_SCRIPT, "--files", p, p)
    assert result.returncode != 0
    assert "duplicate paths" in result.stderr.lower()

def test_parity_resolved_duplicate_paths_rejected():
    result = run_script(TASK_SCRIPT, "--files", "scripts/agent_tasks.py", "scripts/../scripts/agent_tasks.py")
    assert result.returncode != 0
    assert "duplicate paths" in result.stderr.lower()

def test_parity_crlf_normalized(tmp_path):
    a = tmp_path / "a.py"; b = tmp_path / "b.py"
    a.write_text("x\ny\n"); b.write_bytes(b"x\r\ny\r\n")
    assert run_script(TASK_SCRIPT, "--files", a, b).returncode == 0

def test_orphan_warning_and_strict_failure(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "x{}\n"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 0, "files": {"gone.css": 0, "a.css": 0}}))
    r = run_script(CSS_SCRIPT, "--source", src, "--baseline", b)
    assert r.returncode != 0 and "baseline orphan" in r.stderr
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b).returncode != 0

def test_update_requires_confirmation_and_returns_three(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "x{color:red !important}"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 1, "files": {"old.css": 1}}))
    r = run_script(CSS_SCRIPT, "--source", src, "--baseline", b, "--update-baseline")
    assert r.returncode == 2
    assert json.loads(b.read_text())["files"] == {"old.css": 1}
    r = run_script(CSS_SCRIPT, "--source", src, "--baseline", b, "--update-baseline", "--yes")
    assert r.returncode == 3

def test_css_uppercase_extension_and_case_collision(tmp_path):
    src = write_css_tree(tmp_path, {"Sneaky.CSS": "x{} !important"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 0, "files": {}}))
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b).returncode != 0
    write_css_tree(tmp_path, {"a.css": "x{}", "A.CSS": "x{}"})
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b).returncode != 0

def test_parity_hardlink_rejected(tmp_path):
    a=tmp_path/"a.py"; b=tmp_path/"b.py"; a.write_text("x"); b.hardlink_to(a)
    assert run_script(TASK_SCRIPT, "--files", a, b).returncode != 0

def test_parity_defaults_are_repo_anchored(tmp_path):
    fake=tmp_path/"scripts"; fake.mkdir(); (fake/"agent_tasks.py").write_text("FAKE"); (fake/"windows").mkdir(); (fake/"windows/agent_tasks.py").write_text("FAKE")
    r=subprocess.run([sys.executable,str(TASK_SCRIPT)],cwd=tmp_path,text=True,capture_output=True)
    assert r.returncode == 0 and str((ROOT/"scripts/agent_tasks.py").resolve()) in r.stdout


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

def test_ci_gate_steps_use_pipefail_and_no_continue_on_error():
    text = (ROOT / '.github/workflows/ci.yml').read_text()
    for block in re.findall(r'- name: (?:Check CSS debt measurement ratchet|Check agent task parity).*?(?=\n      - name:|\Z)', text, re.S):
        if '| tee' in block:
            assert 'set -o pipefail' in block
    assert 'continue-on-error' not in text

def test_css_no_strict_allows_orphan(tmp_path):
    src = write_css_tree(tmp_path, {'a.css': 'x{}\n'})
    b = tmp_path / 'b.json'; b.write_text(json.dumps({'total': 0, 'files': {'gone.css': 0, 'a.css': 0}}))
    r = run_script(CSS_SCRIPT, '--source', src, '--baseline', b, '--no-strict')
    assert r.returncode == 0

def test_parity_non_utf8_is_operational_error(tmp_path):
    a = tmp_path / 'a.py'; b = tmp_path / 'b.py'
    a.write_text('x'); b.write_bytes(b'\xff\xfe')
    r = run_script(TASK_SCRIPT, '--files', a, b)
    assert r.returncode == 2
    assert 'ERROR:' in r.stderr and 'Traceback' not in r.stderr

def test_css_missing_baseline_is_explicit_error(tmp_path):
    src = write_css_tree(tmp_path, {'a.css': 'x{}\n'})
    b = tmp_path / 'missing.json'
    r = run_script(CSS_SCRIPT, '--source', src, '--baseline', b)
    assert r.returncode == 2 and 'baseline file not found' in r.stderr
    r = run_script(CSS_SCRIPT, '--source', src, '--baseline', b, '--update-baseline', '--yes')
    assert r.returncode == 3 and b.exists()
