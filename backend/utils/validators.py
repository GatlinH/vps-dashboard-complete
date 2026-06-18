"""
utils/validators.py — 输入验证工具函数
"""
import ipaddress
import re
import socket
from urllib.parse import urlparse


def validate_password_strength(password: str) -> tuple:
    """
    校验密码强度，返回 (passed: bool, error_message: str)
    规则：至少12位，需同时包含大写字母、小写字母、数字、特殊字符
    """
    if len(password) < 12:
        return False, "密码至少 12 位"
    if not re.search(r'[A-Z]', password):
        return False, "密码需包含大写字母"
    if not re.search(r'[a-z]', password):
        return False, "密码需包含小写字母"
    if not re.search(r'[0-9]', password):
        return False, "密码需包含数字"
    if not re.search(r'[!@#$%^&*()\-_=+\[\]{};:\'",.<>?/\\|`~]', password):
        return False, "密码需包含特殊字符（如 !@#$%^&*）"
    return True, ""


def validate_port(port: int) -> bool:
    """端口合法性校验：1-65535。"""
    return 1 <= int(port) <= 65535


def validate_ip_or_hostname(value: str) -> bool:
    """
    校验是否为可解析的 IP 或主机名（基础格式检查）。
    不做可达性探测。
    """
    if not value or len(value) > 255:
        return False

    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        pass

    hostname_re = re.compile(
        r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)"
        r"(?:\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*\.?$"
    )
    return bool(hostname_re.match(value))


def validate_server_name(value: str) -> bool:
    """
    服务器名称校验：
    - 2~64 字符
    - 允许中英文、数字、空格、下划线、横线、点
    - 不允许连续空格和首尾空格
    """
    if not isinstance(value, str):
        return False
    if value != value.strip():
        return False
    if len(value) < 2 or len(value) > 64:
        return False
    if "  " in value:
        return False
    return bool(re.match(r"^[\w\-. \u4e00-\u9fff]+$", value))


def validate_server_ip(value: str) -> bool:
    """
    服务器 IP/主机名校验：
    - 不允许 URL（禁止包含 scheme/path/query）
    - 允许 IPv4/IPv6 或 hostname
    """
    if not isinstance(value, str):
        return False
    raw = value.strip()
    if not raw:
        return False
    if "://" in raw or "/" in raw or "?" in raw or "#" in raw:
        return False
    return validate_ip_or_hostname(raw)


def _is_public_ip_address(addr: str) -> bool:
    ip = ipaddress.ip_address(addr)
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def resolve_public_host_addresses(host: str, port: int | None = None):
    """Resolve host once and return getaddrinfo tuples only if every result is public.

    Callers can pass the returned tuples into a pinned connection path to avoid
    DNS rebinding between validation and connect.
    """
    if not host:
        return []
    lowered = host.lower().strip().strip("[]").rstrip(".")
    if lowered in {"localhost", "localhost.localdomain"}:
        return []
    try:
        ipaddress.ip_address(lowered)
        return socket.getaddrinfo(lowered, port) if _is_public_ip_address(lowered) else []
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(lowered, port)
    except socket.gaierror:
        return []
    if not infos:
        return []
    for info in infos:
        addr = info[4][0]
        try:
            if not _is_public_ip_address(addr):
                return []
        except ValueError:
            return []
    return infos


def is_safe_outbound_url(url: str) -> bool:
    """
    SSRF 防护：
    - 仅允许 http/https
    - 禁止 URL 中携带用户名/密码
    - 禁止 localhost 与保留/内网/回环/链路本地等地址
    - 尝试解析域名并逐个校验解析结果
    """
    if not url:
        return False

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    if not parsed.netloc or parsed.username or parsed.password:
        return False

    host = parsed.hostname
    if not host:
        return False
    return bool(resolve_public_host_addresses(host, parsed.port))


def match_domain_whitelist(url: str, whitelist_domains: list[str]) -> tuple[bool, str]:
    """
    校验 URL 的域名是否命中白名单（支持子域名）。
    返回 (is_matched, hostname)。
    """
    parsed = urlparse((url or "").strip())
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return False, ""

    allowed = [
        d.strip().lower().lstrip(".")
        for d in (whitelist_domains or [])
        if d and d.strip()
    ]
    for domain in allowed:
        if hostname == domain or hostname.endswith(f".{domain}"):
            return True, hostname
    return False, hostname
