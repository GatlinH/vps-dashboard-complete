#!/usr/bin/env python3
import argparse
import hashlib
import os
import sys
from pathlib import Path


def digest(path):
    text = path.read_text(encoding="utf-8").replace("\r\n", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument("positional", nargs="*", type=Path)
    parser.add_argument("--files", nargs="+", type=Path)
    args = parser.parse_args(argv)
    if args.files and args.positional:
        print("ERROR: positional paths and --files cannot be combined", file=sys.stderr); return 2
    args.files = args.files or args.positional or [Path(__file__).resolve().parent / "agent_tasks.py", Path(__file__).resolve().parent / "windows/agent_tasks.py"]
    resolved = [path.resolve() for path in args.files]
    if len(set(resolved)) < len(resolved):
        print("ERROR: duplicate paths do not constitute a valid comparison (重复路径不构成有效比对)", file=sys.stderr)
        return 1
    try:
        hashes = []
        for path in resolved:
            hashes.append((str(path), digest(path)))
        stats=[os.stat(p) for p in resolved]
        if len({(s.st_dev,s.st_ino) for s in stats}) < len(stats):
            print("ERROR: files share inode and cannot be compared", file=sys.stderr); return 1
    except (OSError, ValueError) as exc:
        bad_path = path if 'path' in locals() else (resolved[0] if resolved else Path(""))
        print(f"ERROR: cannot read {Path(bad_path).resolve()}: {exc}", file=sys.stderr)
        return 2
    for path, value in hashes:
        print(f"{path} sha256={value}")
    if len(hashes) < 2 or any(value != hashes[0][1] for _, value in hashes[1:]):
        print("ERROR: agent_tasks.py files differ", file=sys.stderr)
        return 1
    print("AGENT_PARITY_GATE_OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
