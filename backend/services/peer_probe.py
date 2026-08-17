"""Target resolution helpers for external and VPS-to-VPS probes."""
import ipaddress
import json
import os

from models.models import Server
from services.probe_protocols import normalize_probe_protocol


DEFAULT_PING_TARGET_PRESETS = [
    {"key": "hk", "label": "香港 CMI", "host": "43.155.88.12", "port": 443, "protocol": "tcp"},
    {"key": "jp", "label": "日本东京 SoftBank", "host": "27.0.234.55", "port": 443, "protocol": "tcp"},
    {"key": "de", "label": "德国法兰克福", "host": "95.216.12.88", "port": 443, "protocol": "tcp"},
    {"key": "sg", "label": "新加坡", "host": "172.104.55.99", "port": 443, "protocol": "tcp"},
    {"key": "us", "label": "美国纽约 OVH", "host": "51.81.22.44", "port": 443, "protocol": "tcp"},
]


def _is_private_or_loopback_host(host: str) -> bool:
    try:
        ip = ipaddress.ip_address(str(host).strip().strip("[]"))
        return ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast
    except Exception:
        return False


def _peer_probe_endpoint(peer: Server):
    cfg = peer.agent_config if isinstance(peer.agent_config, dict) else {}
    network = cfg.get("network") if isinstance(cfg.get("network"), dict) else {}
    nat = cfg.get("nat") if isinstance(cfg.get("nat"), dict) else {}
    mapped = cfg.get("mapped_ports") if isinstance(cfg.get("mapped_ports"), dict) else {}
    meta = cfg.get("inventory_meta") if isinstance(cfg.get("inventory_meta"), dict) else {}

    def _port(*candidates, default=80):
        for value in candidates:
            if value is None or value == "":
                continue
            try:
                return int(value)
            except Exception:
                continue
        return default

    host = str(nat.get("public_ipv4") or network.get("public_ipv4") or cfg.get("public_ipv4") or meta.get("public_ip") or meta.get("public_ipv4") or "").strip()
    port = _port(nat.get("public_port"), nat.get("mapped_port"), mapped.get("https"), mapped.get("tcp"), mapped.get("ssh"), cfg.get("public_port"), cfg.get("probe_port"), meta.get("public_port"), meta.get("probe_port"), default=80)
    if host and not _is_private_or_loopback_host(host):
        return host, port, "tcp", "public_ipv4"

    ipv6 = str(network.get("public_ipv6") or nat.get("public_ipv6") or cfg.get("public_ipv6") or meta.get("public_ipv6") or "").strip()
    if ipv6 and not _is_private_or_loopback_host(ipv6):
        return ipv6, _port(nat.get("port"), mapped.get("https"), mapped.get("tcp"), cfg.get("probe_port"), default=22), "tcp", "public_ipv6"

    hostname = str(meta.get("hostname") or meta.get("public_host") or cfg.get("public_host") or "").strip()
    if hostname and "." in hostname and not _is_private_or_loopback_host(hostname):
        return hostname, port, "tcp", "hostname"

    host = str(getattr(peer, "ip", "") or "").strip()
    if host and not _is_private_or_loopback_host(host):
        use_port = port if not host.replace(".", "").isdigit() else 80
        if host.replace(".", "").isdigit() or ":" in host.strip("[]"):
            use_port = 80 if port == 80 else port
        return host, use_port if not _is_private_or_loopback_host(host) else 80, "tcp", "server_ip"
    return None


def _server_peer_ping_targets(server: Server):
    try:
        peers = Server.query.filter(Server.id != server.id).order_by(Server.id.asc()).all()
    except Exception:
        return [], False
    out = []
    for peer in peers:
        endpoint = _peer_probe_endpoint(peer)
        if not endpoint:
            continue
        host, port, protocol, source = endpoint
        parts = [str(getattr(peer, "name", "") or "").strip(), str(getattr(peer, "location", "") or "").strip()]
        out.append({"key": f"vps-{peer.id}", "label": " · ".join(p for p in parts if p) or host, "host": host, "port": port, "protocol": protocol, "peer_server_id": peer.id, "source": source, "type": "peer"})
    return out, bool(peers)


def _ping_targets_are_peer_targets(server: Server, targets=None):
    targets = targets if targets is not None else _resolve_ping_targets_for_server(server)
    return bool(targets) and all(str(t.get("key", "")).startswith("vps-") or t.get("peer_server_id") for t in targets)


def _agent_side_unavailable_payload(server_id, targets, hours=None):
    sanitized = []
    for target in targets or []:
        protocol = target.get("protocol") or "tcp"
        sanitized.append({"key": target.get("key"), "label": target.get("label") or target.get("key") or "peer", "port": target.get("port"), "protocol": protocol, "results": [], "stats": {"avg_ms": None, "count": 0, "success": 0, "loss_pct": None, "port": target.get("port"), "protocol": protocol}, "quality": None, "source": "agent-side-unavailable", "points": []})
    payload = {"server_id": server_id, "targets": sanitized, "derived_from": "agent-side peer probe unavailable", "probe_source": "agent", "unavailable": True, "message": "暂无真实节点侧互探采样"}
    if hours is not None:
        payload["hours"] = hours
    return payload


def _resolve_ping_targets_for_server(server: Server):
    cfg = (server.agent_config or {}) if getattr(server, "agent_config", None) else {}
    targets = cfg.get("ping_targets")
    if isinstance(targets, list):
        if not targets:
            return []
        cleaned = []
        for idx, item in enumerate(targets):
            if not isinstance(item, dict):
                continue
            host = str(item.get("host", "")).strip()
            if not host:
                continue
            try:
                port = int(item.get("port", 443))
            except Exception:
                port = 443
            cleaned.append({"key": str(item.get("key", f"target-{idx+1}")).strip(), "label": str(item.get("label", host or f"target-{idx+1}")).strip(), "host": host, "port": port, "protocol": normalize_probe_protocol(item.get("protocol")), "type": "external"})
        return cleaned
    return [{**target, "type": "external"} for target in _load_ping_targets()]


def _load_ping_targets():
    raw = os.getenv("PING_TARGETS_JSON", "").strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        if not isinstance(data, list):
            return []
        legacy_hosts = {str(target.get("host")) for target in DEFAULT_PING_TARGET_PRESETS}
        incoming_hosts = {str(target.get("host")) for target in data if isinstance(target, dict)}
        if incoming_hosts == legacy_hosts:
            return []
        cleaned = []
        for idx, item in enumerate(data):
            if not isinstance(item, dict):
                continue
            host = str(item.get("host", "")).strip()
            if not host:
                continue
            try:
                port = int(item.get("port", 443))
            except Exception:
                port = 443
            cleaned.append({"key": str(item.get("key", f"target-{idx+1}")).strip(), "label": str(item.get("label", host or f"target-{idx+1}")).strip(), "host": host, "port": port, "protocol": normalize_probe_protocol(item.get("protocol")), "type": "external"})
        return cleaned
    except Exception:
        return []
