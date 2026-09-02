#!/usr/bin/env python3
"""Measure CSS physical lines and literal !important occurrences."""
import argparse
import json
import sys
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def measure(source: Path):
    if not source.is_dir():
        raise ValueError(f"CSS source directory does not exist: {source}")
    details = {}
    for path in sorted(source.rglob("*.css")):
        if any(part in {"node_modules", "dist"} for part in path.relative_to(source).parts):
            continue
        text = path.read_text(encoding="utf-8")
        details[path.relative_to(source).as_posix()] = {
            "lines": len(text.splitlines()),
            "important": len(re.findall(r"!\s*important", text, re.IGNORECASE)),
        }
    return {
        "files": len(details),
        "physical_lines": sum(item["lines"] for item in details.values()),
        "important_total": sum(item["important"] for item in details.values()),
        "details": details,
    }


def check(measured, baseline, strict=False):
    errors = []
    baseline_files = baseline.get("files", {})
    if baseline.get("total", 0) != sum(baseline_files.values()):
        errors.append("baseline total does not equal sum of baseline files")
    expected_files = len(set(baseline_files) & set(measured.get("details", {})))
    if not measured.get("details") or measured.get("files", 0) < expected_files:
        errors.append("CSS scan found fewer files than baseline; refusing fail-open")
    if measured["important_total"] > baseline.get("total", 0):
        errors.append(f"total: {measured['important_total']} exceeds baseline {baseline['total']}")
    for name, item in measured["details"].items():
        current = item["important"]
        if current > baseline_files.get(name, 0):
            errors.append(f"{name}: {current} exceeds baseline {baseline_files.get(name, 0)}")
    orphans = sorted(set(baseline_files) - set(measured["details"]))
    if strict and orphans:
        errors.append("baseline orphan files: " + ", ".join(orphans))
    elif orphans:
        print("WARNING: baseline orphan files: " + ", ".join(orphans), file=sys.stderr)
    new_files = sorted(set(measured["details"]) - set(baseline_files))
    if new_files:
        errors.append("new CSS files require explicit baseline update: " + ", ".join(new_files))
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=REPO_ROOT / "frontend-vite/src")
    parser.add_argument("--baseline", type=Path, default=REPO_ROOT / ".github/quality/css-important-baseline.json")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--update-baseline", "--write", action="store_true")
    args = parser.parse_args(argv)
    try:
        measured = measure(args.source)
        baseline = json.loads(args.baseline.read_text(encoding="utf-8")) if args.baseline.exists() else {"total": 0, "files": {}}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(measured, sort_keys=False, indent=2))
    if args.update_baseline:
        args.baseline.parent.mkdir(parents=True, exist_ok=True)
        args.baseline.write_text(json.dumps({"total": measured["important_total"], "files": {k:v["important"] for k,v in measured["details"].items()}}, indent=2) + "\n", encoding="utf-8")
        print(f"Updated baseline: {args.baseline}")
        return 0
    errors = check(measured, baseline, args.strict)
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
