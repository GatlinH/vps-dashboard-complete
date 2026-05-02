"""
services/probe_fetcher.py

共享探针抓取与解析层。

职责边界：
  - 统一处理 HTTP 请求、错误分类、payload 解析
  - 不依赖 Flask 上下文、ORM 对象或 Redis
  - 两条调用链（API /fetch-probe 和定时任务 _job_fetch_probes）均复用此模块

调用方只需传入 url、snap（服务器指标 dict 快照）、timeout，
即可获得统一的 (metrics_dict | None, error_msg | None) 返回值。
"""
import json
import logging
import urllib.request
import urllib.error

from typing import Optional

from utils.validators import is_safe_outbound_url

log = logging.getLogger(__name__)


def fetch_and_parse_probe(
    url: str,
    snap: dict,
    timeout: float = 8.0,
    extra_headers: Optional[dict] = None,
) -> tuple:
    """
    抓取并解析探针数据，返回 ``(metrics_dict, error_msg)``。

    成功时返回 ``(dict, None)``；
    失败时返回 ``(None, str)``，error_msg 区分以下错误类型：

    - ``"probe_url 非法或存在安全风险"``  — URL 安全校验失败
    - ``"HTTP <code>"``                   — 非 2xx HTTP 响应
    - ``"timed out"``                     — 请求超时
    - ``"<reason>"``                      — 网络/DNS 连接错误
    - ``"invalid payload: <detail>"``     — JSON 解析或格式解析失败

    :param url:           探针 URL
    :param snap:          服务器指标快照 dict（含 id/name/cpu_use/ram_use/…）
    :param timeout:       HTTP 超时秒数（默认 8）
    :param extra_headers: 附加 HTTP 请求头（可选）
    """
    if not is_safe_outbound_url(url):
        return None, "probe_url 非法或存在安全风险"

    req_headers = {"User-Agent": "VPS-Dashboard/1.0"}
    if extra_headers:
        req_headers.update(extra_headers)

    try:
        req = urllib.request.Request(url, headers=req_headers, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        if "timed out" in reason.lower():
            return None, "timed out"
        return None, reason
    except (json.JSONDecodeError, ValueError) as exc:
        return None, f"invalid payload: {exc}"
    except Exception as exc:
        return None, str(exc)

    try:
        metrics = _parse_probe_payload_dict(payload, snap)
    except Exception as exc:
        return None, f"invalid payload: {exc}"

    return metrics, None


def _parse_probe_payload_dict(payload: dict, snap: dict) -> dict:
    """
    将探针 JSON 映射为统一指标字典（接受 dict 快照，线程安全）。

    支持两种格式：
      - 哪吒探针 v0：``{ "servers": [{ "id", "cpu", "mem_used", … }] }``
      - 通用自定义：``{ "cpu_use", "ram_use", "disk_use", "net_up", "net_down", … }``
    """
    # 哪吒探针 v0 格式
    if "servers" in payload:
        for item in payload["servers"]:
            if str(item.get("id")) == str(snap["id"]) or item.get("name") == snap["name"]:
                cpu  = item.get("cpu", 0)
                mem  = item.get("mem_used", 0) / max(item.get("mem_total", 1), 1) * 100
                disk = item.get("disk_used", 0) / max(item.get("disk_total", 1), 1) * 100
                return {
                    "cpu_use":  round(cpu,  2),
                    "ram_use":  round(mem,  2),
                    "disk_use": round(disk, 2),
                    "net_up":   round(item.get("net_out_speed", 0) / 1024 / 1024, 2),
                    "net_down": round(item.get("net_in_speed",  0) / 1024 / 1024, 2),
                    "status":   "online",
                    "uptime":   str(item.get("uptime", "")),
                }

    # 通用自定义格式
    return {
        "cpu_use":  round(float(payload.get("cpu_use",  snap["cpu_use"])),  2),
        "ram_use":  round(float(payload.get("ram_use",  snap["ram_use"])),  2),
        "disk_use": round(float(payload.get("disk_use", snap["disk_use"])), 2),
        "net_up":   round(float(payload.get("net_up",   snap["net_up"])),   2),
        "net_down": round(float(payload.get("net_down", snap["net_down"])), 2),
        "status":   payload.get("status", snap["status"]),
        "uptime":   payload.get("uptime", snap["uptime"]),
    }
