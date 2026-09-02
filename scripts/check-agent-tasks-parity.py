#!/usr/bin/env python3
import argparse
import hashlib
import sys
from pathlib import Path


def digest(path):
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("positional", nargs="*", type=Path)
    parser.add_argument("--files", nargs="+", type=Path)
    args = parser.parse_args(argv)
    args.files = args.files or args.positional or [Path("scripts/agent_tasks.py"), Path("scripts/windows/agent_tasks.py")]
    resolved = [path.resolve() for path in args.files]
    if len(set(resolved)) < len(resolved):
        print("ERROR: duplicate paths do not constitute a valid comparison (重复路径不构成有效比对)", file=sys.stderr)
        return 1
    try:
        hashes = [(str(path), digest(path)) for path in args.files]
    except OSError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    for path, value in hashes:
        print(f"{path} sha256={value}")
    if len(hashes) < 2 or any(value != hashes[0][1] for _, value in hashes[1:]):
        print("ERROR: agent_tasks.py files differ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
