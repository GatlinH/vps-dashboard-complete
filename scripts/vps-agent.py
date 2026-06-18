#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import platform
import shutil
import socket
import subprocess
import time
import urllib.request
from datetime import datetime

API_ROOT = os.environ['API_ROOT'].rstrip('/')
AGENT_UUID = os.environ['AGENT_UUID']
AGENT_KEY = os.environ['AGENT_KEY']
INTERVAL = max(2, int(os.environ.get('INTERVAL', '20')))
STATE_PATH = '/opt/vps-agent/state.json'

def read_os_name():
    try:
        data = {}
        with open('/etc/os-release', 'r', encoding='utf-8') as f:
            for line in f:
                if '=' in line:
                    k, v = line.rstrip().split('=', 1)
                    data[k] = v.strip().strip('"')
        return data.get('PRETTY_NAME') or data.get('NAME') or platform.platform()
    except Exception:
        return platform.platform()

def get_ip():
    try:
        out = subprocess.check_output("hostname -I | awk '{print $1}'", shell=True, text=True, timeout=5).strip()
        return out or '127.0.0.1'
    except Exception:
        return '127.0.0.1'

def meminfo():
    vals = {}
    with open('/proc/meminfo', 'r', encoding='utf-8') as f:
        for line in f:
            key, rest = line.split(':', 1)
            vals[key] = int(rest.strip().split()[0])
    total = vals.get('MemTotal', 0) / 1024 / 1024
    avail = vals.get('MemAvailable', 0) / 1024 / 1024
    used_pct = 0 if total <= 0 else round((1 - avail / total) * 100, 2)
    return round(total, 2), used_pct

def diskinfo():
    du = shutil.disk_usage('/')
    total = du.total / 1024 / 1024 / 1024
    used_pct = 0 if du.total <= 0 else round((du.used / du.total) * 100, 2)
    return int(round(total)), used_pct

def uptime_text():
    try:
        with open('/proc/uptime', 'r', encoding='utf-8') as f:
            sec = int(float(f.read().split()[0]))
        days, rem = divmod(sec, 86400)
        hours, rem = divmod(rem, 3600)
        mins, _ = divmod(rem, 60)
        parts = []
        if days:
            parts.append(f'{days} days')
        if hours:
            parts.append(f'{hours} hours')
        parts.append(f'{mins} minutes')
        return ', '.join(parts)
    except Exception:
        return ''

def net_totals():
    rx = tx = 0
    with open('/proc/net/dev', 'r', encoding='utf-8') as f:
        lines = f.readlines()[2:]
    for line in lines:
        iface, rest = line.split(':', 1)
        iface = iface.strip()
        if iface == 'lo':
            continue
        parts = rest.split()
        rx += int(parts[0])
        tx += int(parts[8])
    return rx, tx

def net_rates():
    now = time.time()
    rx, tx = net_totals()
    prev = {}
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            prev = json.load(f)
    except Exception:
        prev = {}
    prev_t = float(prev.get('t', now))
    prev_rx = int(prev.get('rx', rx))
    prev_tx = int(prev.get('tx', tx))
    dt = max(1e-6, now - prev_t)
    down = max(0.0, (rx - prev_rx) / 1024 / dt)
    up = max(0.0, (tx - prev_tx) / 1024 / dt)
    try:
        with open(STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump({'t': now, 'rx': rx, 'tx': tx}, f)
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
        'uuid': AGENT_UUID,
        'status': 'online',
        'hostname': socket.gethostname(),
        'os': read_os_name(),
        'arch': platform.machine(),
        'cpu_cores': cores,
        'ram_gb': ram_gb,
        'disk_gb': disk_gb,
        'bandwidth': '待人工补充',
        'ip': get_ip(),
        'cpu_use': cpu_use(cores),
        'ram_use': ram_use,
        'disk_use': disk_use,
        'net_up': net_up,
        'net_down': net_down,
        'uptime': uptime_text(),
    }

def sign(body: bytes, ts: str, nonce: str) -> str:
    msg = f'{ts}.{nonce}.'.encode('utf-8') + body
    return hmac.new(AGENT_KEY.encode('utf-8'), msg, hashlib.sha256).hexdigest()

def push_once():
    data = payload()
    body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    ts = str(int(time.time()))
    nonce = str(int(time.time() * 1000))
    req = urllib.request.Request(API_ROOT + '/api/v1/agent/push', data=body, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('X-Agent-UUID', AGENT_UUID)
    req.add_header('X-Agent-Key', AGENT_KEY)
    req.add_header('X-Agent-Timestamp', ts)
    req.add_header('X-Agent-Nonce', nonce)
    req.add_header('X-Agent-Signature', sign(body, ts, nonce))
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode('utf-8', 'ignore')

while True:
    try:
        push_once()
    except Exception as e:
        print(f'[{datetime.utcnow().isoformat()}] push failed: {e}', flush=True)
    time.sleep(INTERVAL)
