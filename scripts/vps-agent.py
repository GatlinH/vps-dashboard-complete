#!/usr/bin/env python3
"""Readonly host metrics agent for Linux and Windows."""
import hashlib
import hmac
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import importlib.util
from datetime import datetime
from pathlib import Path

API_ROOT = os.environ["API_ROOT"].rstrip("/")
AGENT_UUID = os.environ["AGENT_UUID"]
AGENT_KEY = os.environ["AGENT_KEY"]
SERVER_ID = os.environ.get("SERVER_ID", "")
INTERVAL = max(2, int(os.environ.get("INTERVAL", "20")))
PROBE_INTERVAL = max(10, int(os.environ.get("PROBE_INTERVAL", "60")))
AGENT_VERSION = os.environ.get("AGENT_VERSION", "readonly-agent/1.1.0")
_DEFAULT_STATE_DIR = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "VpsDashboardAgent" if os.name == "nt" else Path("/opt/vps-agent")
STATE_PATH = Path(os.environ.get("AGENT_STATE_PATH", str(_DEFAULT_STATE_DIR / "state.json")))


def read_os_name():
    if os.name == "nt":
        return f"Windows {platform.release()} {platform.version()}".strip()
    try:
        data = {}
        with open("/etc/os-release", encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    key, value = line.rstrip().split("=", 1)
                    data[key] = value.strip().strip('"')
        return data.get("PRETTY_NAME") or data.get("NAME") or platform.platform()
    except OSError:
        return platform.platform()


def read_cpu_model():
    if os.name == "nt":
        try:
            output = subprocess.check_output(["wmic", "cpu", "get", "Name", "/value"], text=True, timeout=5)
            for line in output.splitlines():
                if line.startswith("Name="):
                    return line.split("=", 1)[1].strip()
        except Exception:
            pass
    else:
        try:
            with open("/proc/cpuinfo", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.lower().startswith(("model name", "hardware")) and ":" in line:
                        return line.split(":", 1)[1].strip()
        except OSError:
            pass
    return platform.processor() or platform.machine() or ""


def get_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(2)
            sock.connect(("8.8.8.8", 80))
            return sock.getsockname()[0] or "127.0.0.1"
    except OSError:
        return "127.0.0.1"


def _psutil():
    try:
        import psutil
        return psutil
    except ImportError:
        return None


def meminfo():
    psutil = _psutil()
    if psutil:
        mem = psutil.virtual_memory()
        return round(mem.total / 1024**3, 2), round(mem.percent, 2)
    try:
        values = {}
        with open("/proc/meminfo", encoding="utf-8") as f:
            for line in f:
                key, rest = line.split(":", 1)
                values[key] = int(rest.strip().split()[0])
        total, available = values.get("MemTotal", 0), values.get("MemAvailable", 0)
        return round(total / 1024**2, 2), round((1 - available / total) * 100, 2) if total else 0.0
    except OSError:
        return 0.0, 0.0


def diskinfo():
    root = Path(os.environ.get("SystemDrive", "C:")) if os.name == "nt" else Path("/")
    usage = shutil.disk_usage(root)
    return int(round(usage.total / 1024**3)), round(usage.used / usage.total * 100, 2) if usage.total else 0.0


def uptime_text():
    psutil = _psutil()
    if psutil:
        seconds = max(0, int(time.time() - psutil.boot_time()))
    else:
        try:
            seconds = int(float(Path("/proc/uptime").read_text().split()[0]))
        except Exception:
            return ""
    days, rem = divmod(seconds, 86400)
    hours, rem = divmod(rem, 3600)
    minutes, _ = divmod(rem, 60)
    parts = ([f"{days} days"] if days else []) + ([f"{hours} hours"] if hours else []) + [f"{minutes} minutes"]
    return ", ".join(parts)


def net_totals():
    psutil = _psutil()
    if psutil:
        counters = psutil.net_io_counters()
        return counters.bytes_recv, counters.bytes_sent
    rx = tx = 0
    try:
        for line in Path("/proc/net/dev").read_text().splitlines()[2:]:
            iface, rest = line.split(":", 1)
            if iface.strip() != "lo":
                parts = rest.split(); rx += int(parts[0]); tx += int(parts[8])
    except OSError:
        pass
    return rx, tx


def net_rates():
    now = time.time(); rx, tx = net_totals(); previous = {}
    try:
        previous = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except Exception:
        pass
    elapsed = max(1e-6, now - float(previous.get("t", now)))
    upload = max(0.0, (tx - int(previous.get("tx", tx))) / 1024 / elapsed)
    download = max(0.0, (rx - int(previous.get("rx", rx))) / 1024 / elapsed)
    try:
        STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
        STATE_PATH.write_text(json.dumps({"t": now, "rx": rx, "tx": tx}), encoding="utf-8")
    except OSError:
        pass
    return round(upload, 2), round(download, 2)


def cpu_use(cores):
    psutil = _psutil()
    if psutil:
        return round(psutil.cpu_percent(interval=0.1), 2)
    try:
        return round(min(100.0, max(0.0, os.getloadavg()[0] / max(cores, 1) * 100)), 2)
    except OSError:
        return 0.0


def payload():
    cores = os.cpu_count() or 1; ram_gb, ram_use = meminfo(); disk_gb, disk_use = diskinfo(); net_up, net_down = net_rates()
    return {"uuid": AGENT_UUID, "status": "online", "hostname": socket.gethostname(), "agent_version": AGENT_VERSION,
            "os": read_os_name(), "kernel_version": platform.release() or "", "arch": platform.machine(), "cpu_model": read_cpu_model(),
            "cpu_cores": cores, "ram_gb": ram_gb, "disk_gb": disk_gb, "bandwidth": "N/A", "ip": get_ip(),
            "cpu_use": cpu_use(cores), "ram_use": ram_use, "disk_use": disk_use, "net_up": net_up, "net_down": net_down, "uptime": uptime_text()}


def sign(body, timestamp, nonce):
    return hmac.new(AGENT_KEY.encode(), f"{timestamp}.{nonce}.".encode() + body, hashlib.sha256).hexdigest()


def _request(path, body=None):
    timestamp, nonce = str(int(time.time())), str(int(time.time() * 1000))
    raw = body or b""
    request = urllib.request.Request(API_ROOT + path, data=body, method="POST" if body is not None else "GET")
    request.add_header("X-Agent-UUID", AGENT_UUID); request.add_header("X-Agent-Key", AGENT_KEY)
    request.add_header("X-Agent-Timestamp", timestamp); request.add_header("X-Agent-Nonce", nonce); request.add_header("X-Agent-Signature", sign(raw, timestamp, nonce))
    if body is not None: request.add_header("Content-Type", "application/json")
    return urllib.request.urlopen(request, timeout=15).read()


def push_once():
    return _request("/api/v1/agent/push", json.dumps(payload(), ensure_ascii=False, separators=(",", ":")).encode())


def tcp_probe(host, port, timeout=5):
    try:
        started = time.time(); sock = socket.create_connection((str(host), int(port)), timeout=timeout); sock.close(); return round((time.time() - started) * 1000, 1)
    except OSError:
        return None


def probe_targets(allowed_keys=None):
    if not SERVER_ID: return
    try:
        request = urllib.request.Request(f"{API_ROOT}/api/v1/probe/public/ping-targets/{SERVER_ID}?count=2&source=agent")
        request.add_header("X-Agent-UUID", AGENT_UUID); request.add_header("X-Agent-Key", AGENT_KEY)
        targets = json.loads(urllib.request.urlopen(request, timeout=10).read()).get("targets", [])
    except Exception:
        return
    results = []
    for target in targets:
        if allowed_keys is not None and target.get("key") not in allowed_keys:
            continue
        host, port = target.get("host") or target.get("label"), target.get("port") or 80; latency = tcp_probe(host, port)
        results.append({"key": target.get("key", str(host)), "host": host, "port": port, "protocol": target.get("protocol", "tcp"), "latency_ms": latency, "success": latency is not None, "loss_pct": 0 if latency is not None else 100})
    if results: _request("/api/v1/agent/probe-results", json.dumps({"results": results, "agent_uuid": AGENT_UUID}, ensure_ascii=False).encode())


def _load_task_validator():
    path = Path(__file__).with_name("agent_tasks.py")
    spec = importlib.util.spec_from_file_location("agent_tasks", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate_task


def poll_tasks():
    try:
        return json.loads(_request("/api/v1/agent/poll")).get("tasks", [])
    except Exception:
        return []


def ack_tasks(task_ids):
    if task_ids:
        _request("/api/v1/agent/ack", json.dumps({"command_ids": task_ids}, separators=(",", ":")).encode())


def execute_tasks(tasks):
    validate_task = _load_task_validator()
    completed = []
    for task in tasks:
        task = validate_task(task)
        if not task:
            continue
        try:
            if task["kind"] == "collect_inventory":
                push_once()
            elif task["kind"] == "run_peer_probe":
                probe_targets(set(task["params"]["target_keys"]))
            elif task["kind"] != "reload_agent_config":
                continue
            completed.append(task["id"])
        except Exception as error:
            print(f"[{datetime.now().isoformat()}] task {task['id']} failed: {error}", flush=True)
    return completed


def run_forever(stop_event=None):
    last_probe = 0.0
    while not (stop_event and stop_event.is_set()):
        try: push_once()
        except Exception as error: print(f"[{datetime.now().isoformat()}] push failed: {error}", flush=True)
        try:
            ack_tasks(execute_tasks(poll_tasks()))
        except Exception as error: print(f"[{datetime.now().isoformat()}] task poll failed: {error}", flush=True)
        if time.time() - last_probe >= PROBE_INTERVAL:
            try: probe_targets()
            except Exception as error: print(f"[{datetime.now().isoformat()}] probe failed: {error}", flush=True)
            last_probe = time.time()
        if stop_event: stop_event.wait(INTERVAL)
        else: time.sleep(INTERVAL)


if __name__ == "__main__":
    run_forever()
