#!/usr/bin/env python3
"""Ruff-based ratchet gate for silently swallowed exceptions."""
import argparse, json, os, re, shutil, subprocess, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
BACKEND = REPO_ROOT / "backend"
DEFAULT_BASELINE = REPO_ROOT / ".github/quality/silent-exception-baseline.json"
KNOWN = {"E722", "F821", "S110", "S112", "BLE001"}
BUCKETS = ("S110", "S112", "BLE001")
RUFF_VERSION = "0.16.5"

def validate_baseline(data):
    if not isinstance(data, dict) or data.get("version") != 2 or not isinstance(data.get("scanned_files"), int):
        raise ValueError("baseline must use version 2 with buckets and scanned_files; run --update-baseline --yes to migrate")
    buckets = data.get("buckets")
    if not isinstance(buckets, dict) or set(buckets) != set(BUCKETS):
        raise ValueError("baseline buckets must be exactly S110, S112, BLE001")
    out = {"version": 2, "scanned_files": data["scanned_files"], "buckets": {}}
    if data["scanned_files"] < 0: raise ValueError("scanned_files must be nonnegative")
    for name in BUCKETS:
        b = buckets[name]
        if not isinstance(b, dict) or not isinstance(b.get("total"), int) or b["total"] < 0 or not isinstance(b.get("files"), dict):
            raise ValueError(f"invalid baseline bucket {name}")
        if any(not isinstance(k,str) or not isinstance(v,int) or isinstance(v,bool) or v < 0 for k,v in b["files"].items()) or b["total"] != sum(b["files"].values()):
            raise ValueError(f"baseline bucket {name} total must equal sum(files.values())")
        out["buckets"][name] = {"total": b["total"], "files": b["files"]}
    return out

def _ruff_command():
    override = os.environ.get("SILENT_EXC_RUFF")
    explicit = bool(override) and not (os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"))
    if not explicit:
        override = None
    candidates = [Path(override)] if explicit else [BACKEND / ".venv/bin/ruff"]
    if shutil.which("ruff"): candidates.append(Path(shutil.which("ruff")))
    candidates.append(Path(sys.executable))
    for exe in candidates:
        is_py = exe.name.startswith("python")
        cmd = [str(exe), "-m", "ruff", "--version"] if is_py else [str(exe), "--version"]
        try: p = subprocess.run(cmd, cwd=BACKEND, text=True, capture_output=True)
        except OSError as exc:
            if explicit: raise ValueError(f"SILENT_EXC_RUFF={exe} is unusable: {exc}")
            continue
        m = re.search(r"ruff\s+(\d+\.\d+\.\d+)", p.stdout)
        if p.returncode != 0:
            if explicit: raise ValueError(f"SILENT_EXC_RUFF={exe} is unusable: --version exited {p.returncode}")
            continue
        if not m:
            if explicit: raise ValueError(f"SILENT_EXC_RUFF={exe} is unusable: version output not parseable: {p.stdout.strip()!r}")
            continue
        if m.group(1) != RUFF_VERSION:
            if explicit: raise ValueError(f"SILENT_EXC_RUFF={exe} is unusable: ruff version {m.group(1)} does not match required {RUFF_VERSION}")
            continue
        resolved = " ".join(cmd[:-1]) if is_py else str(exe.resolve())
        print(f"resolved ruff: {resolved} {m.group(1)}")
        return [str(exe), "-m", "ruff"] if is_py else [str(exe)]
    raise ValueError(f"ruff unavailable; install ruff=={RUFF_VERSION}")

def scan():
    cmd = _ruff_command() + ["check", "--output-format", "json", "--ignore-noqa", "--no-respect-gitignore", "--no-cache", "--config", str((BACKEND / "ruff.toml").resolve()), "."]
    try: p = subprocess.run(cmd, cwd=BACKEND, text=True, capture_output=True)
    except OSError as exc: raise ValueError(f"ruff unavailable: {exc}")
    try: items = json.loads(p.stdout)
    except Exception as exc: raise ValueError(f"invalid ruff JSON: {exc}")
    if p.returncode not in (0,1): raise ValueError(f"ruff failed with exit code {p.returncode}")
    if not isinstance(items, list): raise ValueError("invalid ruff JSON: expected array")
    counts = {b:{} for b in BUCKETS}; e722=0; f821=[]; files=set()
    for item in items:
        code=item.get("code"); path=item.get("filename", "")
        if code not in KNOWN: raise ValueError(f"unknown diagnostic {code} in {path}: {item.get('message','')}; scan incomplete, refusing determination")
        if path: files.add(path)
        if code == "E722": e722 += 1
        elif code == "F821": f821.append((path,item.get("location",{}).get("row")))
        elif code in BUCKETS:
            rel=Path(path).resolve().relative_to(REPO_ROOT).as_posix(); counts[code][rel]=counts[code].get(rel,0)+1
    return {"buckets": {b:{"total":sum(v.values()),"files":v} for b,v in counts.items()}, "e722":e722,"f821":f821,"scanned_files":len(files)}

def main(argv=None):
    ap=argparse.ArgumentParser(allow_abbrev=False); ap.add_argument("--baseline",type=Path,default=DEFAULT_BASELINE); ap.add_argument("--update-baseline",action="store_true"); ap.add_argument("--yes",action="store_true",help=argparse.SUPPRESS); a=ap.parse_args(argv)
    try:
        measured=scan(); baseline=None
        if a.baseline.exists() and not a.update_baseline: baseline=validate_baseline(json.loads(a.baseline.read_text()))
        if baseline is None and not a.update_baseline: raise ValueError(f"baseline file not found: {a.baseline.resolve()}")
    except (OSError,ValueError,json.JSONDecodeError) as e: print(f"ERROR: {e}",file=sys.stderr); return 2
    print(json.dumps(measured,indent=2,sort_keys=True))
    if measured["e722"]: print(f"ERROR: E722 count must remain zero (found {measured['e722']})",file=sys.stderr); return 1
    if measured["f821"]: print("ERROR: F821 count must remain zero: "+", ".join(p for p,_ in measured["f821"]),file=sys.stderr); return 1
    if a.update_baseline:
        if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS") or not (a.yes or os.environ.get("SILENT_EXC_BASELINE_WRITE")=="1"): print("ERROR: baseline update requires --yes and is forbidden in CI",file=sys.stderr); return 2
        data={"version":2,"scanned_files":measured["scanned_files"],"buckets":measured["buckets"]}; a.baseline.parent.mkdir(parents=True,exist_ok=True); a.baseline.write_text(json.dumps(data,indent=2)+"\n"); print(f"Updated baseline: {a.baseline}"); return 3
    errors=[]
    if measured["scanned_files"] < baseline["scanned_files"]: errors.append(f"scanned={measured['scanned_files']} baseline={baseline['scanned_files']}")
    for b in BUCKETS:
        bf=baseline["buckets"][b]["files"]; mf=measured["buckets"][b]["files"]
        for f in set(bf)-set(mf):
            if (REPO_ROOT/f).exists(): errors.append(f"{f}: exists in tree but produced no findings (excluded/ignored/unscanned?)")
            else: print(f"cleared: {f}")
        expected=sum(min(v,mf.get(f,0)) for f,v in bf.items())
        if sum(mf.values()) > expected: errors.append(f"{b} total exceeds reconciled baseline")
        for f,c in mf.items():
            if c > bf.get(f,0): errors.append(f"{b} {f}: {c} exceeds baseline {bf.get(f,0)}")
        if set(mf)-set(bf): errors.append(f"new files require explicit baseline update in {b}")
    if errors: print("\n".join("ERROR: "+e for e in errors),file=sys.stderr); return 1
    print("SILENT_EXC_GATE_OK"); return 0
if __name__ == "__main__": raise SystemExit(main())
