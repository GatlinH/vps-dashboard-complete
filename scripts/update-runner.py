#!/usr/bin/env python3
"""Local host update runner for VPS Dashboard.

Runs as a root-owned systemd service on the host and exposes a small HTTP API
on a Unix socket. The backend container talks to this socket to check GitHub
source updates and trigger the existing host-side update.sh workflow.
"""
from __future__ import annotations

import json
import os
import shlex
import signal
import socket
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import UnixStreamServer
from pathlib import Path

REPO_DIR = Path(os.environ.get("VPS_DASHBOARD_REPO_DIR", "/opt/vps-dashboard-complete"))
UPDATE_SCRIPT = Path(os.environ.get("VPS_DASHBOARD_UPDATE_SCRIPT", str(REPO_DIR / "update.sh")))
SOCKET_PATH = Path(os.environ.get("VPS_DASHBOARD_UPDATE_SOCKET", "/run/vps-dashboard-updater/updater.sock"))
LOG_PATH = Path(os.environ.get("VPS_DASHBOARD_UPDATE_LOG", "/var/log/vps-dashboard/update-runner.log"))
BRANCH = os.environ.get("VPS_DASHBOARD_BRANCH", "main")

_state_lock = threading.Lock()
_state = {
    "running": False,
    "started_at": None,
    "finished_at": None,
    "exit_code": None,
    "message": "尚未执行更新",
}


def run(cmd: list[str], timeout: int = 30) -> tuple[int, str]:
    try:
        p = subprocess.run(cmd, cwd=str(REPO_DIR), text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, p.stdout.strip()
    except Exception as exc:
        return 1, str(exc)


def git_state(fetch: bool = False) -> dict:
    if not (REPO_DIR / ".git").exists():
        return {"ok": False, "error": f"不是 Git 仓库：{REPO_DIR}"}
    if fetch:
        code, out = run(["git", "fetch", "origin", BRANCH, "--prune"], timeout=60)
        if code != 0:
            return {"ok": False, "error": out[:1000]}
    _, branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"])
    _, local = run(["git", "rev-parse", "HEAD"])
    _, remote = run(["git", "rev-parse", f"origin/{branch or BRANCH}"])
    _, short_local = run(["git", "rev-parse", "--short", "HEAD"])
    _, short_remote = run(["git", "rev-parse", "--short", f"origin/{branch or BRANCH}"])
    update_available = bool(local and remote and local != remote)
    return {
        "ok": True,
        "repo_dir": str(REPO_DIR),
        "branch": branch or BRANCH,
        "local_sha": local,
        "remote_sha": remote,
        "local_short": short_local,
        "remote_short": short_remote,
        "update_available": update_available,
    }


def tail_log(limit: int = 80) -> str:
    try:
        if not LOG_PATH.exists():
            return ""
        lines = LOG_PATH.read_text(errors="replace").splitlines()[-limit:]
        return "\n".join(lines)[-6000:]
    except Exception as exc:
        return f"读取日志失败：{exc}"


def update_worker() -> None:
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with _state_lock:
        _state.update({"running": True, "started_at": started, "finished_at": None, "exit_code": None, "message": "更新执行中"})
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        cmd = ["bash", str(UPDATE_SCRIPT)]
        with LOG_PATH.open("a", encoding="utf-8") as log:
            log.write(f"\n===== update started {started}: {shlex.join(cmd)} =====\n")
            log.flush()
            env = dict(os.environ)
            env["SKIP_UPDATE_RUNNER_SYNC"] = "1"
            proc = subprocess.run(cmd, cwd=str(REPO_DIR), stdout=log, stderr=subprocess.STDOUT, text=True, env=env)
        code = int(proc.returncode)
        msg = "更新完成" if code == 0 else f"更新失败，退出码 {code}"
    except Exception as exc:
        code = 1
        msg = f"更新异常：{exc}"
    finished = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    with _state_lock:
        _state.update({"running": False, "finished_at": finished, "exit_code": code, "message": msg})


class Handler(BaseHTTPRequestHandler):
    server_version = "VpsDashboardUpdateRunner/1.0"

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def _json(self, code: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in ("/status", "/check"):
            return self._json(404, {"ok": False, "msg": "not found"})
        fetch = self.path == "/check"
        with _state_lock:
            state = dict(_state)
        self._json(200, {"ok": True, "mode": "github-source", "git": git_state(fetch=fetch), "runner": state, "log_tail": tail_log()})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/update":
            return self._json(404, {"ok": False, "msg": "not found"})
        with _state_lock:
            if _state.get("running"):
                return self._json(409, {"ok": False, "msg": "已有更新正在执行", "runner": dict(_state), "log_tail": tail_log()})
            _state.update({"running": True, "message": "更新已排队"})
        threading.Thread(target=update_worker, daemon=True).start()
        self._json(202, {"ok": True, "msg": "已开始 GitHub 源码全面更新", "runner": dict(_state), "log_tail": tail_log()})


class UnixHTTPServer(UnixStreamServer, HTTPServer):
    address_family = socket.AF_UNIX


def main() -> None:
    SOCKET_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        SOCKET_PATH.unlink()
    except FileNotFoundError:
        pass
    httpd = UnixHTTPServer(str(SOCKET_PATH), Handler)
    os.chmod(SOCKET_PATH, 0o666)

    def stop(signum, frame):  # noqa: ANN001
        httpd.shutdown()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
