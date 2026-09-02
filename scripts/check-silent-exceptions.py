#!/usr/bin/env python3
"""Ruff-based ratchet gate for silently swallowed exceptions."""
import argparse, json, os, shutil, subprocess, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"
DEFAULT_BASELINE = REPO_ROOT / ".github/quality/silent-exception-baseline.json"

def validate_baseline(data):
    if not isinstance(data, dict): raise ValueError("baseline must be an object")
    files = data.get("files"); total = data.get("total")
    if not isinstance(files, dict) or any(not isinstance(k, str) or isinstance(v, bool) or not isinstance(v, int) or v < 0 for k,v in files.items()):
        raise ValueError("baseline files must be a string-to-nonnegative-int object")
    if isinstance(total, bool) or not isinstance(total, int) or total < 0 or total != sum(files.values()):
        raise ValueError("baseline total must equal sum of files")
    return {"total": total, "files": files}

def _ruff_command():
    override = os.environ.get("SILENT_EXC_RUFF")
    candidates = [Path(override)] if override else [BACKEND / ".venv/bin/ruff"]
    path_ruff = shutil.which("ruff")
    if path_ruff: candidates.append(Path(path_ruff))
    for exe in candidates:
        try:
            probe = subprocess.run([str(exe), "--version"], cwd=BACKEND, text=True, capture_output=True)
        except OSError:
            continue
        if probe.returncode == 0:
            return [str(exe)]
    try:
        probe = subprocess.run([sys.executable, "-m", "ruff", "--version"], cwd=BACKEND, text=True, capture_output=True)
    except OSError:
        probe = None
    if probe is not None and probe.returncode == 0:
        return [sys.executable, "-m", "ruff"]
    raise ValueError("ruff unavailable; install ruff==0.16.5 from requirements-dev.txt")

def scan():
    cmd = _ruff_command() + ["check", "--output-format", "json", "."]
    try: p = subprocess.run(cmd, cwd=BACKEND, text=True, capture_output=True)
    except OSError as exc: raise ValueError(f"ruff unavailable: {exc}")
    if any(x in p.stderr.lower() for x in ("no module named", "not found", "error:")):
        raise ValueError(f"ruff failed to start: {p.stderr.strip()}")
    try: items = json.loads(p.stdout)
    except (json.JSONDecodeError, TypeError) as exc: raise ValueError(f"invalid ruff JSON: {exc}")
    if not isinstance(items, list): raise ValueError("invalid ruff JSON: expected array")
    counts = {}; e722 = 0
    for item in items:
        code = item.get("code"); path = item.get("filename", "")
        if code == "E722": e722 += 1
        elif code in {"S110", "S112"}:
            rel = Path(path).resolve().relative_to(REPO_ROOT).as_posix()
            counts[rel] = counts.get(rel, 0) + 1
    return {"total": sum(counts.values()), "files": counts, "e722": e722}

def main(argv=None):
    ap = argparse.ArgumentParser(allow_abbrev=False)
    ap.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE)
    ap.add_argument("--update-baseline", action="store_true"); ap.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)
    args = ap.parse_args(argv)
    try:
        measured = scan()
        if not args.baseline.exists() and not args.update_baseline: raise ValueError(f"baseline file not found: {args.baseline.resolve()}")
        baseline = validate_baseline(json.loads(args.baseline.read_text())) if args.baseline.exists() else {"total":0,"files":{}}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr); return 2
    print(json.dumps(measured, indent=2, sort_keys=True))
    if measured["e722"]: print(f"ERROR: E722 count must remain zero (found {measured['e722']})", file=sys.stderr); return 1
    if args.update_baseline:
        if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"): print("ERROR: baseline updates are forbidden in CI", file=sys.stderr); return 2
        if not (args.yes or os.environ.get("SILENT_EXC_BASELINE_WRITE") == "1"): print("ERROR: baseline update requires --yes or SILENT_EXC_BASELINE_WRITE=1", file=sys.stderr); return 2
        if not measured["files"]: print("ERROR: refusing to write an empty silent-exception baseline", file=sys.stderr); return 2
        args.baseline.parent.mkdir(parents=True, exist_ok=True); args.baseline.write_text(json.dumps({"total":measured["total"],"files":measured["files"]}, indent=2)+"\n")
        print(f"Updated baseline: {args.baseline}"); return 3
    errors=[]; bf=baseline["files"]
    if not measured["files"]: errors.append("silent-exception scan found no findings; refusing fail-open")
    if measured["total"] > baseline["total"]: errors.append(f"total: {measured['total']} exceeds baseline {baseline['total']}")
    for n,c in measured["files"].items():
        if c > bf.get(n, 0): errors.append(f"{n}: {c} exceeds baseline {bf.get(n,0)}")
    new=set(measured["files"])-set(bf)
    if new: errors.append("new files require explicit baseline update: " + ", ".join(sorted(new)))
    if errors: print("\n".join("ERROR: "+e for e in errors), file=sys.stderr); return 1
    print("SILENT_EXC_GATE_OK"); return 0
if __name__ == "__main__": raise SystemExit(main())
