#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import subprocess
import sys
from pathlib import Path


SEVERITY = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}


def advisory_id(item: dict) -> str:
    url = item.get("url", "")
    if "/advisories/" in url:
        return url.rstrip("/").rsplit("/", 1)[-1]
    return str(item.get("source", ""))


def findings(audit: dict, minimum: str) -> set[tuple[str, str]]:
    result = set()
    for package, vulnerability in audit.get("vulnerabilities", {}).items():
        for via in vulnerability.get("via", []):
            if isinstance(via, dict) and SEVERITY.get(via.get("severity", "info"), 0) >= SEVERITY[minimum]:
                result.add((package, advisory_id(via)))
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--allowlist", required=True)
    parser.add_argument("--audit-json")
    parser.add_argument("--root", default="frontend-vite")
    parser.add_argument("--audit-level", default="high", choices=SEVERITY)
    parser.add_argument("--today", default=dt.date.today().isoformat())
    args = parser.parse_args()

    if args.audit_json:
        audit = json.loads(Path(args.audit_json).read_text())
    else:
        completed = subprocess.run(
            ["npm", "audit", "--omit=dev", f"--audit-level={args.audit_level}", "--json"],
            cwd=args.root, text=True, capture_output=True,
        )
        if not completed.stdout.strip():
            print(completed.stderr, file=sys.stderr)
            return 2
        audit = json.loads(completed.stdout)

    current = findings(audit, args.audit_level)
    today = dt.date.fromisoformat(args.today)
    entries = json.loads(Path(args.allowlist).read_text()).get("entries", [])
    allowed = set()
    errors = []
    for entry in entries:
        key = (entry["package"], entry["advisory"])
        if dt.date.fromisoformat(entry["expires"]) < today:
            errors.append(f"EXPIRED {key[0]}@{key[1]} {entry['expires']}")
        elif key not in current:
            errors.append(f"STALE {key[0]}@{key[1]}")
        else:
            allowed.add(key)
    for package, advisory in sorted(current - allowed):
        errors.append(f"UNALLOWLISTED {package}@{advisory}")
    for error in errors:
        print(error)
    print(f"AUDIT_FINDINGS {len(current)} ALLOWED {len(allowed)} ERRORS {len(errors)}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
