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
    lowered = host.lower()
    if lowered in {"localhost", "localhost.localdomain"}:
        return False

    def _is_public_ip(addr: str) -> bool:
        ip = ipaddress.ip_address(addr)
        return not (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        )

    try:
        # host 为直连 IP
        ipaddress.ip_address(host)
        return _is_public_ip(host)
    except ValueError:
        pass

    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False

    for info in infos:
        addr = info[4][0]
        try:
            if not _is_public_ip(addr):
                return False
        except ValueError:
            return False
    return True
