import json
import subprocess
import sys
import re
import os
import importlib.util
import yaml
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS_SCRIPT = ROOT / "scripts" / "check-css-debt.py"
TASK_SCRIPT = ROOT / "scripts" / "check-agent-tasks-parity.py"
SILENT_SCRIPT = ROOT / "scripts" / "check-silent-exceptions.py"


def run_script(script, *args, env=None):
    child_env = os.environ.copy() if env is None else env
    return subprocess.run(
        [sys.executable, str(script), *map(str, args)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        env=child_env,
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


def test_css_measure_sorts_details_when_walk_is_unsorted(tmp_path, monkeypatch):
    src = write_css_tree(tmp_path, {"z.css": "a { color: red !important; }\n", "a.css": "b {}\n"})
    spec = importlib.util.spec_from_file_location("css_gate", CSS_SCRIPT)
    css_gate = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(css_gate)
    real_walk = css_gate.os.walk

    def reversed_walk(*args, **kwargs):
        for root, dirs, files in real_walk(*args, **kwargs):
            yield root, dirs, list(reversed(files))

    monkeypatch.setattr(css_gate.os, "walk", reversed_walk)
    measured = css_gate.measure(src)
    assert list(measured["details"]) == ["a.css", "z.css"]
    assert measured["important_total"] == 1
    assert measured["files"] == 2


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
    env = os.environ.copy(); env.pop("CI", None); env.pop("GITHUB_ACTIONS", None)
    r = run_script(CSS_SCRIPT, "--source", src, "--baseline", b, "--update-baseline", "--yes", env=env)
    assert r.returncode == 3

def test_update_baseline_forbidden_in_ci(tmp_path):
    src = write_css_tree(tmp_path, {"a.css": "x{color:red !important}"})
    b = tmp_path / "b.json"; b.write_text(json.dumps({"total": 1, "files": {"a.css": 1}}))
    env = os.environ.copy(); env["CI"] = "true"; env["GITHUB_ACTIONS"] = "true"
    assert run_script(CSS_SCRIPT, "--source", src, "--baseline", b, "--update-baseline", "--yes", env=env).returncode == 2

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
    data = yaml.safe_load((ROOT / '.github/workflows/ci.yml').read_text())
    steps = data['jobs']['frontend']['steps']
    wanted = {'Check CSS debt measurement ratchet': '^CSS_DEBT_GATE_OK$', 'Check agent task parity': '^AGENT_PARITY_GATE_OK$'}
    for name, marker in wanted.items():
        step = next(s for s in steps if s.get('name') == name)
        run = step['run']; assert 'set -o pipefail' in run and f"grep -q '{marker}'" in run
        assert not any(x in run for x in ('--no-strict','--update-baseline','--source','--baseline','--yes'))
        assert not step.get('continue-on-error') and '|| true' not in run
    step = next(s for s in steps if s.get('name') == 'Run repository quality gate tests')
    assert not step.get('continue-on-error') and '|| true' not in step['run']

def test_css_no_strict_allows_orphan(tmp_path):
    src = write_css_tree(tmp_path, {'a.css': 'x{}\n'})
    b = tmp_path / 'b.json'; b.write_text(json.dumps({'total': 0, 'files': {'gone.css': 0, 'a.css': 0}}))
    env = os.environ.copy(); env.pop('CI', None); env.pop('GITHUB_ACTIONS', None)
    r = run_script(CSS_SCRIPT, '--source', src, '--baseline', b, '--no-strict', env=env)
    assert r.returncode == 0

def test_css_no_strict_forbidden_in_ci(tmp_path):
    src = write_css_tree(tmp_path, {'a.css': 'x{}\n'})
    b = tmp_path / 'b.json'; b.write_text(json.dumps({'total': 0, 'files': {'gone.css': 0, 'a.css': 0}}))
    env = os.environ.copy(); env['CI'] = 'true'
    assert run_script(CSS_SCRIPT, '--source', src, '--baseline', b, '--no-strict', env=env).returncode == 2

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
    env = os.environ.copy(); env.pop('CI', None); env.pop('GITHUB_ACTIONS', None)
    r = run_script(CSS_SCRIPT, '--source', src, '--baseline', b, '--update-baseline', '--yes', env=env)
    assert r.returncode == 3 and b.exists()

def test_silent_gate_ruff_unavailable_is_operational_error(tmp_path):
    env = os.environ.copy(); env["PATH"] = str(tmp_path)
    env["SILENT_EXC_RUFF"] = str(tmp_path / "missing-ruff")
    r = subprocess.run(["/usr/bin/python3", str(SILENT_SCRIPT)], cwd=ROOT, text=True, capture_output=True, env=env)
    assert r.returncode == 2
    assert "ERROR:" in r.stderr and "Traceback" not in r.stderr

def test_silent_gate_invalid_ruff_json_is_operational_error(tmp_path):
    fake = tmp_path / "ruff"
    fake.write_text("#!/bin/sh\necho boom\n")
    fake.chmod(0o755)
    env = os.environ.copy(); env["PATH"] = str(tmp_path)
    env["SILENT_EXC_RUFF"] = str(fake)
    r = subprocess.run([sys.executable, str(SILENT_SCRIPT)], cwd=ROOT, text=True, capture_output=True, env=env)
    assert r.returncode == 2
    assert "SILENT_EXC_RUFF" in r.stderr and "not parseable" in r.stderr and "Traceback" not in r.stderr

def _fake_ruff(tmp_path, payload, version="ruff 0.16.5", rc=0):
    fake = tmp_path / "ruff"
    fake.write_text(f'#!/bin/sh\nif [ "$1" = "--version" ]; then echo {version}; else echo \'{payload}\'; exit {rc}; fi\n')
    fake.chmod(0o755)
    env = os.environ.copy(); env["SILENT_EXC_RUFF"] = str(fake); env["PATH"] = str(tmp_path)
    return fake, env

def test_silent_gate_non_json_after_valid_version(tmp_path):
    _, env = _fake_ruff(tmp_path, "boom")
    r = run_script(SILENT_SCRIPT, env=env)
    assert r.returncode == 2 and "invalid ruff JSON" in r.stderr

def test_silent_gate_invalid_and_unknown_codes(tmp_path):
    for code in ("invalid-syntax", "Z999", "null"):
        _, env = _fake_ruff(tmp_path, json.dumps([{"code": None if code == "null" else code, "filename": "backend/x.py"}]))
        r = run_script(SILENT_SCRIPT, env=env)
        assert r.returncode == 2

def test_silent_gate_ruff_nonzero_json(tmp_path):
    _, env = _fake_ruff(tmp_path, "[]", rc=2)
    assert run_script(SILENT_SCRIPT, env=env).returncode == 2

def test_silent_gate_version_rejected(tmp_path):
    for version in ("ruff 0.1.0", "ruff"):
        _, env = _fake_ruff(tmp_path, "[]", version=version)
        assert run_script(SILENT_SCRIPT, env=env).returncode == 2


def test_silent_gate_f821_is_zero_tolerance(tmp_path):
    fake = tmp_path / "ruff"
    fake.write_text("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'ruff 0.16.5'; else echo '[{\"code\":\"F821\",\"filename\":\"backend/api/broken.py\",\"location\":{\"row\":7,\"column\":1}},{\"code\":\"S110\",\"filename\":\"backend/api/existing.py\"}]'; fi\n")
    fake.chmod(0o755)
    env = os.environ.copy(); env["PATH"] = str(tmp_path); env["SILENT_EXC_RUFF"] = str(fake)
    r = subprocess.run([sys.executable, str(SILENT_SCRIPT)], cwd=ROOT, text=True, capture_output=True, env=env)
    assert r.returncode == 1
    assert "F821" in r.stderr and "backend/api/broken.py" in r.stderr
