"""Network protocol implementations used by probe API routes.

This module intentionally has no Flask, ORM, or persistence dependencies.
"""

import ipaddress
import os
import re
import socket
import subprocess
import time
from urllib.parse import urlencode, urlparse

import requests
import urllib3


def normalize_probe_protocol(value) -> str:
    proto = str(value or "tcp").strip().lower()
    if proto == "lcmp":
        proto = "icmp"
    return proto if proto in {"tcp", "icmp", "http"} else "tcp"


def http_probe_url(host: str, port: int | None = None) -> str:
    """Build a valid HTTP URL from a host, including a bare IPv6 literal."""
    raw = (host or "").strip()
    if raw.startswith(("http://", "https://")):
        return raw
    target = raw.strip("[]")
    try:
        is_v6 = ipaddress.ip_address(target).version == 6
    except ValueError:
        is_v6 = False
    authority = f"[{target}]" if is_v6 else target
    if port and port not in (80, 443):
        return f"http://{authority}:{int(port)}"
    return f"http://{authority}"


def tcp_ping(host: str, port: int, timeout: float = 5.0) -> dict:
    """Run one TCP connect probe."""
    start = time.perf_counter()
    try:
        target = str(host or "").strip().strip("[]")
        if ":" in target:
            helper = os.getenv("HOST_PROBE_HELPER_URL", "").strip()
            if helper:
                try:
                    query = urlencode({"host": target, "port": int(port), "timeout": float(timeout)})
                    response = requests.get(f"{helper}?{query}", timeout=timeout + 1)
                    if response.ok:
                        data = response.json()
                        return {
                            "success": bool(data.get("success")),
                            "latency_ms": data.get("latency_ms"),
                            "error": data.get("error"),
                        }
                    return {
                        "success": False,
                        "latency_ms": None,
                        "error": f"helper HTTP {response.status_code}",
                    }
                except Exception as exc:
                    return {"success": False, "latency_ms": None, "error": f"helper: {exc}"}
        family = socket.AF_INET6 if ":" in target else socket.AF_INET
        sock = socket.socket(family, socket.SOCK_STREAM)
        try:
            sock.settimeout(timeout)
            result = sock.connect_ex((target, port))
            elapsed = (time.perf_counter() - start) * 1000
        finally:
            sock.close()
        if result == 0:
            return {"success": True, "latency_ms": round(elapsed, 2), "error": None}
        return {"success": False, "latency_ms": None, "error": f"errno {result}"}
    except socket.timeout:
        return {"success": False, "latency_ms": None, "error": "timeout"}
    except Exception as exc:
        return {"success": False, "latency_ms": None, "error": str(exc)}


def icmp_ping(host: str, timeout: float = 5.0) -> dict:
    start = time.perf_counter()
    try:
        target = str(host or "").strip().strip("[]")
        try:
            is_v6 = ipaddress.ip_address(target).version == 6
        except ValueError:
            is_v6 = False
        command = ["ping", "-6"] if is_v6 else ["ping"]
        command += ["-c", "1", "-W", str(max(1, int(timeout))), target]
        process = subprocess.run(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout + 1,
        )
        output = (process.stdout or "") + "\n" + (process.stderr or "")
        if process.returncode == 0:
            match = re.search(r"time[=<]([0-9.]+)\s*ms", output)
            latency = float(match.group(1)) if match else (time.perf_counter() - start) * 1000
            return {"success": True, "latency_ms": round(latency, 2), "error": None}
        error = output.strip().splitlines()[-1] if output.strip() else f"exit {process.returncode}"
        return {"success": False, "latency_ms": None, "error": error[:160]}
    except FileNotFoundError:
        return {"success": False, "latency_ms": None, "error": "ping command unavailable"}
    except subprocess.TimeoutExpired:
        return {"success": False, "latency_ms": None, "error": "timeout"}
    except Exception as exc:
        return {"success": False, "latency_ms": None, "error": str(exc)}


def http_ping(
    host: str,
    port: int | None = None,
    timeout: float = 5.0,
    connect_host: str | None = None,
) -> dict:
    """Probe HTTP while preserving the original authority for Host and TLS."""
    url = http_probe_url(host, port)
    parsed = urlparse(url)
    origin_host = parsed.hostname or str(host or "").strip().strip("[]")
    connect_ip = str(connect_host or origin_host).strip().strip("[]")
    scheme = parsed.scheme or "http"
    target_port = parsed.port or (443 if scheme == "https" else 80)
    path = (parsed.path or "/") + (f"?{parsed.query}" if parsed.query else "")
    start = time.perf_counter()
    try:
        headers = {"User-Agent": "vps-dashboard-probe/1.0", "Host": origin_host}
        pool_class = urllib3.HTTPSConnectionPool if scheme == "https" else urllib3.HTTPConnectionPool
        pool_kwargs = {
            "retries": False,
            "timeout": urllib3.Timeout(total=timeout),
            "headers": headers,
        }
        if scheme == "https":
            pool_kwargs["server_hostname"] = origin_host
            pool_kwargs["assert_hostname"] = origin_host
        pool = pool_class(connect_ip, port=target_port, **pool_kwargs)
        try:
            response = pool.request("GET", path, redirect=False, preload_content=False)
            status_code = int(response.status)
            response.release_conn()
        finally:
            pool.close()
        elapsed = (time.perf_counter() - start) * 1000
        success = 100 <= status_code < 500
        return {
            "success": success,
            "latency_ms": round(elapsed, 2) if success else None,
            "error": None if success else f"HTTP {status_code}",
            "status_code": status_code,
            "url": url,
        }
    except (urllib3.exceptions.ConnectTimeoutError, urllib3.exceptions.ReadTimeoutError):
        return {"success": False, "latency_ms": None, "error": "timeout", "url": url}
    except Exception as exc:
        return {"success": False, "latency_ms": None, "error": str(exc), "url": url}


def run_probe_once(
    protocol: str,
    host: str,
    port: int,
    timeout: float = 5.0,
    connect_host: str | None = None,
) -> dict:
    protocol = normalize_probe_protocol(protocol)
    target = connect_host or host
    if protocol == "icmp":
        result = icmp_ping(target, timeout)
    elif protocol == "http":
        result = http_ping(host, port, timeout, connect_host=connect_host)
    else:
        result = tcp_ping(target, port, timeout)
    result["protocol"] = protocol
    return result
