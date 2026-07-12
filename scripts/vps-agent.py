#!/usr/bin/env python3
import hashlib, hmac, json, os, platform, shutil, socket, subprocess, time, urllib.request
from datetime import datetime

API_ROOT = os.environ["API_ROOT"].rstrip("/")
AGENT_UUID = os.environ["AGENT_UUID"]
AGENT_KEY = os.environ["AGENT_KEY"]
SERVER_ID = os.environ.get("SERVER_ID", "")
INTERVAL = max(2, int(os.environ.get("INTERVAL", "20")))
PROBE_INTERVAL = max(10, int(os.environ.get("PROBE_INTERVAL", "60")))
AGENT_VERSION = os.environ.get("AGENT_VERSION", "readonly-agent/1.0.0")
STATE_PATH = "/opt/vps-agent/state.json"

def read_os_name():
    try:
        data = {}
        with open("/etc/os-release", "r", encoding="utf-8") as f:
            for line in f:
                if "=" in line:
                    k, v = line.rstrip().split("=", 1)
                    data[k] = v.strip().strip('"')
        return data.get("PRETTY_NAME") or data.get("NAME") or platform.platform()
    except Exception:
        return platform.platform()

def read_kernel_version():
    try:
        return platform.release() or platform.uname().release or ""
    except Exception:
        return ""


def read_cpu_model():
    try:
        with open("/proc/cpuinfo", "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                if line.lower().startswith("model name") and ":" in line:
                    return line.split(":", 1)[1].strip()
                if line.lower().startswith("hardware") and ":" in line:
                    return line.split(":", 1)[1].strip()
    except Exception:
        pass
    try:
        return platform.processor() or platform.machine() or ""
    except Exception:
        return ""


def get_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.settimeout(2)
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
        return ip or "127.0.0.1"
    except Exception:
        return "127.0.0.1"

def meminfo():
    vals = {}
    with open("/proc/meminfo", "r", encoding="utf-8") as f:
        for line in f:
            key, rest = line.split(":", 1)
            vals[key] = int(rest.strip().split()[0])
    total = vals.get("MemTotal", 0) / 1024 / 1024
    avail = vals.get("MemAvailable", 0) / 1024 / 1024
    used_pct = 0 if total <= 0 else round((1 - avail / total) * 100, 2)
    return round(total, 2), used_pct

def diskinfo():
    du = shutil.disk_usage("/")
    total = du.total / 1024 / 1024 / 1024
    used_pct = 0 if du.total <= 0 else round((du.used / du.total) * 100, 2)
    return int(round(total)), used_pct

def uptime_text():
    try:
        with open("/proc/uptime", "r", encoding="utf-8") as f:
            sec = int(float(f.read().split()[0]))
        days, rem = divmod(sec, 86400)
        hours, rem = divmod(rem, 3600)
        mins, _ = divmod(rem, 60)
        parts = []
        if days: parts.append(f"{days} days")
        if hours: parts.append(f"{hours} hours")
        parts.append(f"{mins} minutes")
        return ", ".join(parts)
    except Exception:
        return ""

def net_totals():
    rx = tx = 0
    with open("/proc/net/dev", "r", encoding="utf-8") as f:
        lines = f.readlines()[2:]
    for line in lines:
        iface, rest = line.split(":", 1)
        iface = iface.strip()
        if iface == "lo": continue
        parts = rest.split()
        rx += int(parts[0])
        tx += int(parts[8])
    return rx, tx

def net_rates():
    now = time.time()
    rx, tx = net_totals()
    prev = {}
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as f:
            prev = json.load(f)
    except Exception:
        prev = {}
    prev_t = float(prev.get("t", now))
    prev_rx = int(prev.get("rx", rx))
    prev_tx = int(prev.get("tx", tx))
    dt = max(1e-6, now - prev_t)
    down = max(0.0, (rx - prev_rx) / 1024 / dt)
    up = max(0.0, (tx - prev_tx) / 1024 / dt)
    try:
        with open(STATE_PATH, "w", encoding="utf-8") as f:
            json.dump({"t": now, "rx": rx, "tx": tx}, f)
    except Exception:
        pass
    return round(up, 2), round(down, 2)

def cpu_use(cpu_cores):
    try:
        load1 = os.getloadavg()[0]
        return round(min(100.0, max(0.0, load1 / max(cpu_cores, 1) * 100)), 2)
    except Exception:
        return 0.0

def payload():
    cores = os.cpu_count() or 1
    ram_gb, ram_use = meminfo()
    disk_gb, disk_use = diskinfo()
    net_up, net_down = net_rates()
    return {
        "uuid": AGENT_UUID, "status": "online", "hostname": socket.gethostname(),
        "agent_version": AGENT_VERSION,
        "os": read_os_name(), "kernel_version": read_kernel_version(),
        "arch": platform.machine(), "cpu_model": read_cpu_model(), "cpu_cores": cores,
        "ram_gb": ram_gb, "disk_gb": disk_gb, "bandwidth": "N/A",
        "ip": get_ip(), "cpu_use": cpu_use(cores), "ram_use": ram_use,
        "disk_use": disk_use, "net_up": net_up, "net_down": net_down,
        "uptime": uptime_text(),
    }

def sign(body, ts, nonce):
    msg = f"{ts}.{nonce}.".encode("utf-8") + body
    return hmac.new(AGENT_KEY.encode("utf-8"), msg, hashlib.sha256).hexdigest()

def http_get(path, timeout=10):
    req = urllib.request.Request(API_ROOT + path, method="GET")
    req.add_header("X-Agent-UUID", AGENT_UUID)
    req.add_header("X-Agent-Key", AGENT_KEY)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))

def push_once():
    data = payload()
    body = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    ts = str(int(time.time()))
    nonce = str(int(time.time() * 1000))
    req = urllib.request.Request(API_ROOT + "/api/v1/agent/push", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-Agent-UUID", AGENT_UUID)
    req.add_header("X-Agent-Key", AGENT_KEY)
    req.add_header("X-Agent-Timestamp", ts)
    req.add_header("X-Agent-Nonce", nonce)
    req.add_header("X-Agent-Signature", sign(body, ts, nonce))
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode("utf-8", "ignore")

# ── Peer probe ─────────────────────────────────────────────────
def tcp_probe(host, port, timeout=5):
    try:
        start = time.time()
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        result = sock.connect_ex((str(host), int(port)))
        elapsed = (time.time() - start) * 1000
        sock.close()
        return round(elapsed, 1) if result == 0 else None
    except Exception:
        return None

def probe_targets():
    try:
        sid = SERVER_ID or ""
        if not sid:
            return
        targets_resp = http_get(f"/api/v1/probe/public/ping-targets/{sid}?count=2&source=agent")
    except Exception:
        return
    targets = targets_resp.get("targets", [])
    if not targets:
        return
    results = []
    for t in targets:
        host = t.get("host") or t.get("label")
        port = t.get("port") or 80
        latency = tcp_probe(host, port)
        results.append({
            "key": t.get("key", str(host)), "host": host, "port": port,
            "protocol": t.get("protocol", "tcp"),
            "latency_ms": latency, "success": latency is not None,
            "loss_pct": 0 if latency is not None else 100,
        })
    if results:
        body = json.dumps({"results": results, "agent_uuid": AGENT_UUID}, ensure_ascii=False).encode("utf-8")
        ts = str(int(time.time()))
        nonce = str(int(time.time() * 1000))
        req = urllib.request.Request(API_ROOT + "/api/v1/agent/probe-results", data=body, method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-Agent-UUID", AGENT_UUID)
        req.add_header("X-Agent-Key", AGENT_KEY)
        req.add_header("X-Agent-Timestamp", ts)
        req.add_header("X-Agent-Nonce", nonce)
        req.add_header("X-Agent-Signature", sign(body, ts, nonce))
        try:
            urllib.request.urlopen(req, timeout=15)
        except Exception:
            pass

last_probe = 0
while True:
    try:
        push_once()
    except Exception as e:
        print(f"[{datetime.utcnow().isoformat()}] push failed: {e}", flush=True)
    now = time.time()
    if now - last_probe >= PROBE_INTERVAL:
        try:
            probe_targets()
        except Exception as e:
            print(f"[{datetime.utcnow().isoformat()}] probe failed: {e}", flush=True)
        last_probe = now
    time.sleep(INTERVAL)