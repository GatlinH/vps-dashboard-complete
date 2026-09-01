#!/usr/bin/env python3
"""Measure CSS physical lines and literal !important occurrences."""
import argparse
import json
import sys
from pathlib import Path


def measure(source: Path):
    if not source.is_dir():
        raise ValueError(f"CSS source directory does not exist: {source}")
    details = {}
    for path in sorted(source.rglob("*.css")):
        if any(part in {"node_modules", "dist"} for part in path.parts):
            continue
        text = path.read_text(encoding="utf-8")
        details[path.relative_to(source).as_posix()] = {
            "lines": len(text.splitlines()),
            "important": text.count("!important"),
        }
    return {
        "files": len(details),
        "physical_lines": sum(item["lines"] for item in details.values()),
        "important_total": sum(item["important"] for item in details.values()),
        "details": details,
    }


def check(measured, baseline):
    errors = []
    if measured["important_total"] > baseline.get("total", 0):
        errors.append(f"total: {measured['important_total']} exceeds baseline {baseline['total']}")
    baseline_files = baseline.get("files", {})
    for name, item in measured["details"].items():
        current = item["important"]
        if current > baseline_files.get(name, 0):
            errors.append(f"{name}: {current} exceeds baseline {baseline_files.get(name, 0)}")
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("frontend-vite/src"))
    parser.add_argument("--baseline", type=Path, default=Path(".github/quality/css-important-baseline.json"))
    args = parser.parse_args(argv)
    try:
        measured = measure(args.source)
        baseline = json.loads(args.baseline.read_text(encoding="utf-8")) if args.baseline.exists() else {"total": 0, "files": {}}
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2
    print(json.dumps(measured, sort_keys=False, indent=2))
    errors = check(measured, baseline)
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
