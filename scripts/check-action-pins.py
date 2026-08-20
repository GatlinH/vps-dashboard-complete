#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


USES_RE = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)(?:\s+#\s*(\S+))?", re.MULTILINE)
SHA_RE = re.compile(r"^[0-9a-f]{40}$")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    args = parser.parse_args()
    root = Path(args.root)
    problems = []
    pins = []
    for path in sorted((root / ".github/workflows").glob("*.yml")):
        for match in USES_RE.finditer(path.read_text()):
            reference, comment = match.groups()
            if reference.startswith("./"):
                continue
            action, separator, revision = reference.rpartition("@")
            if not separator or not SHA_RE.fullmatch(revision) or not comment or not comment.startswith("v"):
                problems.append(f"{path.relative_to(root)}: UNPINNED {reference}")
            else:
                pins.append(f"{action}@{revision} # {comment}")
    for problem in problems:
        print(problem)
    print(f"ACTION_PINS {len(pins)} PROBLEMS {len(problems)}")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main())
