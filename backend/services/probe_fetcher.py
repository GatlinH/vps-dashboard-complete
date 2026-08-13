"""
services/probe_fetcher.py

共享探针抓取与解析层。

职责边界：
  - 统一处理 HTTP 请求、错误分类、payload 解析
  - 不依赖 Flask 上下文、ORM 对象或 Redis
  - 两条调用链（API /fetch-probe 和定时任务 _job_fetch_probes）均复用此模块

调用方只需传入 url、snap（服务器指标 dict 快照）、timeout，
即可获得统一的 (metrics_dict | None, error_msg | None) 返回值。

SSRF / DNS rebinding 防护
-------------------------
探针 URL 由使用者填写，因此每次抓取都必须：

  1. 校验 URL scheme / 凭据 / 主机；
  2. 解析主机名一次，确认**所有**解析结果都是公网地址；
  3. 把 socket 连接钉在第 2 步已校验的地址上。

第 3 步过去通过临时替换全局 ``socket.getaddrinfo`` 实现。生产环境的
Gunicorn 以 ``--worker-class gthread --threads 4`` 运行，同一进程内多个线程
会并发抓取不同探针，全局替换存在两个真实缺陷：

  - 竞态：线程 A 的 ``finally`` 会把 resolver 还原成线程 B 安装的版本，
    或反过来把 B 的 pin 提前撤掉，导致 B 的连接走未经校验的解析路径；
  - 越界：替换期间进程内**任何**其它组件（DB、Redis、Telegram 推送）的
    DNS 解析都会经过探针专用的补丁函数。

因此这里改为“请求局部”的连接钉定：为单次请求构造连接类，socket 连到已
校验的 IP，而 ``Host`` 头与 TLS SNI / 证书校验仍使用原始主机名。没有任何
进程级共享状态被修改，线程之间互不影响。
"""
import http.client
import json
import logging
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse

from typing import Optional

from utils.validators import is_safe_outbound_url, resolve_public_host_addresses

log = logging.getLogger(__name__)


class _NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _pinned_connection_classes(connect_ip: str):
    """Build request-local connection classes pinned to ``connect_ip``.

    ``self.host`` stays the original hostname, so the HTTP ``Host`` header,
    TLS SNI and certificate verification all still target the name the operator
    configured. Only the TCP peer address is forced to the pre-validated IP.
    """

    class _PinnedHTTPConnection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.create_connection(
                (connect_ip, self.port), self.timeout, self.source_address
            )
            if self._tunnel_host:
                self._tunnel()

    class _PinnedHTTPSConnection(http.client.HTTPSConnection):
        def connect(self):
            sock = socket.create_connection(
                (connect_ip, self.port), self.timeout, self.source_address
            )
            if self._tunnel_host:
                self.sock = sock
                self._tunnel()
                sock = self.sock
            # server_hostname keeps SNI + hostname verification on the original
            # name; connecting by IP must never silently disable either.
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)

    return _PinnedHTTPConnection, _PinnedHTTPSConnection


class _PinnedHTTPHandler(urllib.request.HTTPHandler):
    def __init__(self, conn_cls):
        super().__init__()
        self._conn_cls = conn_cls

    def http_open(self, req):
        return self.do_open(self._conn_cls, req)


class _PinnedHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, conn_cls):
        super().__init__()
        self._conn_cls = conn_cls

    def https_open(self, req):
        return self.do_open(self._conn_cls, req)


def _open_pinned(req: urllib.request.Request, timeout: float = 8.0):
    """Open ``req`` against a freshly validated, pinned public address.

    This is the single outbound-HTTP seam of this module: the hostname and port
    are taken from the request itself, re-validated, and the socket is pinned to
    a public address that passed validation. Tests patch this function to
    exercise error mapping without real network I/O — production code must never
    branch on whether a mock is installed.

    Raises ``ValueError`` when the host does not resolve exclusively to public
    addresses. No process-global state is touched, so concurrent callers in
    other threads are unaffected.
    """
    parsed = urlparse(req.full_url)
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("probe_url 非法或存在安全风险")

    pinned = resolve_public_host_addresses(hostname, parsed.port)
    if not pinned:
        raise ValueError("probe_url 非法或存在安全风险")

    connect_ip = str(pinned[0][4][0])
    http_cls, https_cls = _pinned_connection_classes(connect_ip)
    opener = urllib.request.build_opener(
        _NoRedirectHandler,
        _PinnedHTTPHandler(http_cls),
        _PinnedHTTPSHandler(https_cls),
    )
    return opener.open(req, timeout=timeout)


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

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None, "probe_url 非法或存在安全风险"

    req_headers = {"User-Agent": "VPS-Dashboard/1.0"}
    if extra_headers:
        req_headers.update(extra_headers)

    try:
        req = urllib.request.Request(url, headers=req_headers, method="GET")
        with _open_pinned(req, timeout=timeout) as resp:
            payload = json.loads(resp.read(1024 * 1024).decode())
    except urllib.error.HTTPError as exc:
        return None, f"HTTP {exc.code}"
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        if "timed out" in reason.lower():
            return None, "timed out"
        return None, reason
    except (json.JSONDecodeError, ValueError) as exc:
        return None, f"invalid payload: {exc}"
    except socket.timeout:
        return None, "timed out"
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
