#!/usr/bin/env python3
"""Measure CSS physical lines and literal !important occurrences."""
import argparse
import json
import sys
import re
import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def measure(source: Path):
    if not source.is_dir():
        raise ValueError(f"CSS source directory does not exist: {source}")
    details = {}
    errors=[]; seen_case={}
    def onerror(exc): errors.append(f"cannot access directory: {exc}")
    for root, dirs, files in os.walk(source, followlinks=False, onerror=onerror):
        rootp=Path(root)
        kept=[]
        for d in dirs:
            p=rootp/d
            if d in {"node_modules", "dist"}:
                print(f"INFO: excluding {p}", file=sys.stderr); continue
            if p.is_symlink(): errors.append(f"symlink directory not scanned: {p}"); continue
            kept.append(d)
        dirs[:] = kept
        for name in files:
            path=rootp/name
            if path.suffix.lower() != ".css": continue
            try: text=path.read_text(encoding="utf-8")
            except (OSError, UnicodeError) as exc: errors.append(f"cannot read {path}: {exc}"); continue
            rel=path.relative_to(source).as_posix()
            key=rel.casefold()
            if key in seen_case and seen_case[key] != rel: errors.append(f"CSS paths differ only by case: {seen_case[key]} and {rel}")
            seen_case[key]=rel
            details[rel] = {
                "lines": len(text.splitlines()),
                "important": len(re.findall(r"!\s*important", text, re.IGNORECASE)),
            }
    if errors: raise ValueError("; ".join(errors))
    return {
        "files": len(details),
        "physical_lines": sum(item["lines"] for item in details.values()),
        "important_total": sum(item["important"] for item in details.values()),
        "details": details,
    }


def validate_baseline(baseline):
    if not isinstance(baseline, dict): raise ValueError("baseline must be an object")
    files=baseline.get("files")
    total=baseline.get("total")
    if not isinstance(files, dict) or any(not isinstance(k,str) or isinstance(v,bool) or not isinstance(v,int) or v<0 for k,v in files.items()): raise ValueError("baseline files must be a string-to-nonnegative-int object")
    if isinstance(total,bool) or not isinstance(total,int) or total<0 or total != sum(files.values()): raise ValueError("baseline total must equal sum of files")
    return {"total":total,"files":files}

def check(measured, baseline, strict=True):
    errors = []
    baseline_files = baseline.get("files", {})
    orphans = sorted(set(baseline_files) - set(measured.get("details", {})))
    expected_files = len(baseline_files) if strict else len(baseline_files) - len(orphans)
    scanned_files = measured.get("files", 0)
    if not measured.get("details"):
        errors.append("CSS scan found no files; refusing fail-open")
    elif expected_files and scanned_files < expected_files:
        errors.append(f"CSS scan found fewer files than baseline: scanned={scanned_files} expected={expected_files}")
    if measured["important_total"] > baseline["total"]:
        errors.append(f"total: {measured['important_total']} exceeds baseline {baseline['total']}")
    for name, item in measured["details"].items():
        current = item["important"]
        if current > baseline_files.get(name, 0):
            errors.append(f"{name}: {current} exceeds baseline {baseline_files.get(name, 0)}")
    if strict and orphans:
        errors.append("baseline orphan files: " + ", ".join(orphans))
    elif orphans:
        print("WARNING: baseline orphan files: " + ", ".join(orphans), file=sys.stderr)
    new_files = sorted(set(measured["details"]) - set(baseline_files))
    if new_files:
        errors.append("new CSS files require explicit baseline update: " + ", ".join(new_files))
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("--source", type=Path, default=REPO_ROOT / "frontend-vite/src")
    parser.add_argument("--baseline", type=Path, default=REPO_ROOT / ".github/quality/css-important-baseline.json")
    parser.add_argument("--no-strict", action="store_true")
    parser.add_argument("--update-baseline", action="store_true")
    parser.add_argument("--yes", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        measured = measure(args.source)
        if not args.baseline.exists() and not args.update_baseline:
            print(f"ERROR: baseline file not found: {args.baseline.resolve()}", file=sys.stderr)
            return 2
        baseline = validate_baseline(json.loads(args.baseline.read_text(encoding="utf-8"))) if args.baseline.exists() else {"total": 0, "files": {}}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(measured, sort_keys=False, indent=2))
    if args.no_strict and (os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS")):
        print("ERROR: --no-strict is forbidden in CI", file=sys.stderr)
        return 2
    if args.update_baseline:
        if os.environ.get("CI") or os.environ.get("GITHUB_ACTIONS"):
            print("ERROR: baseline updates are forbidden in CI", file=sys.stderr); return 2
        if not (args.yes or os.environ.get("CSS_BASELINE_WRITE") == "1"):
            print("ERROR: baseline update requires --yes or CSS_BASELINE_WRITE=1", file=sys.stderr); return 2
        if not measured["details"]:
            print("ERROR: refusing to write an empty CSS baseline", file=sys.stderr); return 2
        try:
            args.baseline.parent.mkdir(parents=True, exist_ok=True)
            args.baseline.write_text(json.dumps({"total": measured["important_total"], "files": {k:v["important"] for k,v in measured["details"].items()}}, indent=2) + "\n", encoding="utf-8")
        except OSError as exc:
            print(f"ERROR: cannot write baseline: {args.baseline.resolve()}: {exc}", file=sys.stderr)
            return 2
        print(f"Updated baseline: {args.baseline}")
        print("WARNING: baseline updated; this run is intentionally non-green (rc=3)", file=sys.stderr)
        return 3
    errors = check(measured, baseline, not args.no_strict)
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1
    print("CSS_DEBT_GATE_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
