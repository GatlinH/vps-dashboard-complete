#!/usr/bin/env python3
import argparse
import hashlib
import sys
from pathlib import Path


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("first", nargs="?", type=Path, default=Path("scripts/agent_tasks.py"))
    parser.add_argument("second", nargs="?", type=Path, default=Path("scripts/windows/agent_tasks.py"))
    args = parser.parse_args(argv)
    try:
        hashes = {str(args.first): digest(args.first), str(args.second): digest(args.second)}
    except OSError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    for path, value in hashes.items():
        print(f"{path} sha256={value}")
    if len(set(hashes.values())) != 1:
        print("ERROR: agent_tasks.py files differ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
