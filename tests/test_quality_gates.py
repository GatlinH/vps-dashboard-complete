import json
import subprocess
import sys
import re
import os
import importlib.util
import yaml
import pytest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CSS_SCRIPT = ROOT / "scripts" / "check-css-debt.py"
TASK_SCRIPT = ROOT / "scripts" / "check-agent-tasks-parity.py"
SILENT_SCRIPT = ROOT / "scripts" / "check-silent-exceptions.py"

import importlib.util
_spec = importlib.util.spec_from_file_location("silent_gate", SILENT_SCRIPT)
silent_gate = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(silent_gate)


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

def _silent_scan(files=None, totals=None, e722=None, f821=None):
    files = files or {}; totals = totals or {}
    return {"buckets": {b: {"total": totals.get(b, sum(files.values()) if b == "S110" else 0), "files": files if b == "S110" else {}} for b in silent_gate.BUCKETS}, "e722": e722 or [], "f821": f821 or []}

def _silent_baseline(files, total=None, **extra):
    total = sum(files.values()) if total is None else total
    return {"version": 4, "ruff_config_sha256": silent_gate._config_digest(), "ruff_version": "0.16.5", "buckets": {b: {"total": total if b == "S110" else 0, "files": files if b == "S110" else {}} for b in silent_gate.BUCKETS}, **extra}

def _run_silent(tmp_path, monkeypatch, scan, baseline, *args):
    for key in ('CI','GITHUB_ACTIONS','GITLAB_CI','JENKINS_URL','BUILDKITE','TF_BUILD'):
        monkeypatch.delenv(key, raising=False)
    path = tmp_path / "b.json"; path.write_text(json.dumps(baseline)); monkeypatch.setattr(silent_gate, "scan", lambda: scan)
    return silent_gate.main(["--baseline", str(path), *args])

def test_silent_real_baseline_passes(tmp_path, monkeypatch, capsys):
    baseline = tmp_path / "b.json"; baseline.write_text((ROOT / ".github/quality/silent-exception-baseline.json").read_text())
    r = subprocess.run([sys.executable, str(SILENT_SCRIPT), "--baseline", str(baseline)], cwd=ROOT, text=True, capture_output=True)
    assert r.returncode == 0 and "SILENT_EXC_GATE_OK" in r.stdout and "resolved ruff:" in r.stdout

def test_silent_count_increased(tmp_path, monkeypatch, capsys):
    r = _run_silent(tmp_path, monkeypatch, _silent_scan({"a.py": 2}), _silent_baseline({"a.py": 1})); assert r == 1 and "count increased" in capsys.readouterr().err
def test_silent_new_file(tmp_path, monkeypatch, capsys):
    r = _run_silent(tmp_path, monkeypatch, _silent_scan({"b.py": 1}), _silent_baseline({"a.py": 1})); assert r == 1 and "new file requires explicit baseline update" in capsys.readouterr().err
def test_silent_count_decreased(tmp_path, monkeypatch, capsys):
    r = _run_silent(tmp_path, monkeypatch, _silent_scan({"a.py": 1}), _silent_baseline({"a.py": 2})); assert r == 0 and "progress:" in capsys.readouterr().out
def test_silent_file_disappeared(tmp_path, monkeypatch, capsys):
    r = _run_silent(tmp_path, monkeypatch, _silent_scan(), _silent_baseline({"a.py": 1})); assert r == 0 and "progress:" in capsys.readouterr().out
def test_silent_stale_threshold(tmp_path, monkeypatch, capsys):
    r = _run_silent(tmp_path, monkeypatch, _silent_scan(), _silent_baseline({"a.py": 11})); assert r == 1 and "stale" in capsys.readouterr().err
def test_silent_canary_rule_coverage(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(silent_gate, "scan", lambda: (_ for _ in ()).throw(ValueError("rule coverage lost"))); r = silent_gate.main(["--baseline", str(tmp_path/"x")]); assert r == 2 and "rule coverage lost" in capsys.readouterr().err
def test_silent_hash_mismatch(tmp_path, monkeypatch, capsys):
    b = _silent_baseline({}); b["ruff_config_sha256"] = "bad"; r = _run_silent(tmp_path, monkeypatch, _silent_scan(), b); assert r == 1 and "ruff.toml changed" in capsys.readouterr().err
def test_silent_ruff_version_mismatch(tmp_path, monkeypatch, capsys):
    b = _silent_baseline({}); b["ruff_version"] = "0.1.0"; r = _run_silent(tmp_path, monkeypatch, _silent_scan(), b); assert r == 2 and "ruff_version" in capsys.readouterr().err
def test_silent_unknown_top_level_key(tmp_path, monkeypatch, capsys):
    b = _silent_baseline({}); b["wat"] = 1; r = _run_silent(tmp_path, monkeypatch, _silent_scan(), b); assert r == 2 and "unknown top-level baseline key" in capsys.readouterr().err
def test_silent_zero_file_value(tmp_path, monkeypatch, capsys):
    b = _silent_baseline({"a.py": 0}); r = _run_silent(tmp_path, monkeypatch, _silent_scan(), b); assert r == 2 and "files >= 1" in capsys.readouterr().err
def test_silent_v3_rejected(tmp_path, monkeypatch, capsys):
    b = _silent_baseline({}); b["version"] = 3; r = _run_silent(tmp_path, monkeypatch, _silent_scan(), b); assert r == 2 and "version 4" in capsys.readouterr().err
def test_silent_update_ci_forbidden(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("CI", "true"); r = _run_silent(tmp_path, monkeypatch, _silent_scan(), _silent_baseline({}), "--update-baseline", "--yes"); assert r == 2 and "forbidden in CI" in capsys.readouterr().err
def test_silent_update_requires_yes_and_token(tmp_path, monkeypatch, capsys):
    r = _run_silent(tmp_path, monkeypatch, _silent_scan(), _silent_baseline({}), "--update-baseline"); assert r == 2 and "requires --yes" in capsys.readouterr().err
def test_silent_update_writes_baseline(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SILENT_EXC_BASELINE_WRITE", "1"); r = _run_silent(tmp_path, monkeypatch, _silent_scan({"a.py": 1}), _silent_baseline({"a.py": 1}), "--update-baseline", "--yes"); assert r == 3 and "->" in capsys.readouterr().out
def test_silent_increase_requires_allow(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SILENT_EXC_BASELINE_WRITE", "1"); r = _run_silent(tmp_path, monkeypatch, _silent_scan({"a.py": 2}), _silent_baseline({"a.py": 1}), "--update-baseline", "--yes"); assert r == 2 and "increase detected" in capsys.readouterr().err
def test_silent_increase_allow_records_justification(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SILENT_EXC_BASELINE_WRITE", "1"); p=tmp_path/"b.json"; p.write_text(json.dumps(_silent_baseline({"a.py":1}))); monkeypatch.setattr(silent_gate,"scan",lambda:_silent_scan({"a.py":2})); r=silent_gate.main(["--baseline",str(p),"--update-baseline","--yes","--allow-increase","reason"]); d=json.loads(p.read_text()); assert r==3 and "increase_justification" in d and "previous_totals" in d
def test_silent_ruff_override_interpreter(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SILENT_EXC_RUFF", sys.executable); monkeypatch.delenv("CI", raising=False); r=silent_gate.main([]); assert r==2 and "must point to ruff executable" in capsys.readouterr().err
def test_silent_v3_update_full_chain(tmp_path, monkeypatch):
    monkeypatch.setenv("SILENT_EXC_BASELINE_WRITE","1"); p=tmp_path/"b.json"; p.write_text(json.dumps({"version":3})); monkeypatch.setattr(silent_gate,"scan",lambda:_silent_scan()); assert silent_gate.main(["--baseline",str(p),"--update-baseline","--yes"])==3; assert silent_gate.main(["--baseline",str(p)])==0
def test_silent_extend_config_rejected(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(silent_gate, "scan", lambda: (_ for _ in ()).throw(ValueError("ruff.toml must not contain extend"))); r=silent_gate.main(["--baseline", str(tmp_path/"x")]); assert r==2 and "extend" in capsys.readouterr().err
def test_silent_f821_location(tmp_path, monkeypatch, capsys):
    r=_run_silent(tmp_path, monkeypatch, _silent_scan(f821=[("backend/api/broken.py",7)]), _silent_baseline({})); assert r==1 and re.search(r"backend/api/broken.py:7", capsys.readouterr().err)

def test_silent_gate_invalid_ruff_json_is_operational_error(tmp_path):
    fake = tmp_path / "ruff"
    fake.write_text("#!/bin/sh\necho boom\n")
    fake.chmod(0o755)
    env = os.environ.copy(); env["PATH"] = str(tmp_path)
    env["SILENT_EXC_RUFF"] = str(fake)
    r = subprocess.run([sys.executable, str(SILENT_SCRIPT)], cwd=ROOT, text=True, capture_output=True, env=env)
    assert r.returncode == 2
    assert "SILENT_EXC_RUFF" in r.stderr and "invalid output" in r.stderr and "Traceback" not in r.stderr

def _fake_ruff(tmp_path, payload, version="ruff 0.16.5", rc=0):
    fake = tmp_path / "ruff"
    canary='[{"code":"E722","filename":"canary.py","location":{"row":1}},{"code":"F821","filename":"canary.py","location":{"row":2}},{"code":"S110","filename":"canary.py","location":{"row":3}},{"code":"S112","filename":"canary.py","location":{"row":4}},{"code":"BLE001","filename":"canary.py","location":{"row":5}}]'
    fake.write_text(f'''#!/bin/sh
if [ "$1" = "--version" ]; then echo {version}; elif printf '%s\\n' "$@" | /usr/bin/grep -q -- '--stdin-filename'; then echo '{canary}'; else echo '{payload}'; exit {rc}; fi
''')
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
    fake.write_text("#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'ruff 0.16.5'; elif printf '%s\\n' \"$@\" | /usr/bin/grep -q -- '--stdin-filename'; then echo '[{\"code\":\"E722\"},{\"code\":\"F821\"},{\"code\":\"S110\"},{\"code\":\"S112\"},{\"code\":\"BLE001\"}]'; else echo '[{\"code\":\"F821\",\"filename\":\"backend/api/broken.py\",\"location\":{\"row\":7,\"column\":1}},{\"code\":\"S110\",\"filename\":\"backend/api/existing.py\"}]'; fi\n")
    fake.chmod(0o755)
    env = os.environ.copy(); env["PATH"] = str(tmp_path); env["SILENT_EXC_RUFF"] = str(fake)
    r = subprocess.run([sys.executable, str(SILENT_SCRIPT)], cwd=ROOT, text=True, capture_output=True, env=env)
    assert r.returncode == 1
    assert "F821" in r.stderr and "backend/api/broken.py" in r.stderr
