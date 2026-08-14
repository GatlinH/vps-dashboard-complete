"""Explicit server DTO projections.

Public serialization is allowlist-based: adding a field to the internal/admin DTO
must never expose it to anonymous APIs automatically.
"""

PUBLIC_SERVER_FIELDS = frozenset({
    "id",
    "name",
    "group",
    "group_info",
    "flag",
    "location",
    "city",
    "region",
    "country",
    "ip",
    "cpu",
    "ram",
    "disk",
    "bw",
    "provider",
    "os",
    "kernel_version",
    "arch",
    "cpu_model",
    "tags",
    "price",
    "period",
    "expiry",
    "lat",
    "lon",
    "cpu_use",
    "ram_use",
    "disk_use",
    "net_up",
    "net_down",
    "process_count",
    "status",
    "uptime",
    "traffic_limit_gb",
    "traffic_reset_day",
    "traffic_up_gb",
    "traffic_down_gb",
    "traffic_used_gb",
    "updated_at",
})


def mask_public_ip(value) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    parts = raw.split(".")
    if len(parts) == 4 and all(part.isdigit() for part in parts):
        return f"{parts[0]}.{parts[1]}.*.*"
    if ":" in raw:
        head = raw.split(":", 1)[0]
        return f"{head}:***" if head else "***"
    if len(raw) <= 6:
        return "***"
    return raw[:3] + "***" + raw[-2:]


def serialize_public_server(internal: dict, *, note: str = "") -> dict:
    """Project an internal server DTO onto the anonymous/public contract."""
    public = {
        key: internal[key]
        for key in PUBLIC_SERVER_FIELDS
        if key in internal
    }

    public["ip"] = mask_public_ip(public.get("ip"))
    for key in ("city", "region", "country"):
        public[key] = str(public.get(key) or "")[:64]

    raw_os = str(public.get("os") or "").strip()
    if raw_os:
        public["os"] = raw_os.split("(", 1)[0].strip()[:80]
    raw_kernel = str(public.get("kernel_version") or "").strip()
    if raw_kernel:
        kernel_family = raw_kernel.split("-", 1)[0]
        parts = kernel_family.split(".")
        public["kernel_version"] = (
            ".".join(parts[:2]) if len(parts) >= 2 else kernel_family[:16]
        )

    raw_public_note = str(note or "").strip()
    if raw_public_note:
        public["public_note"] = raw_public_note[:160]
        public["publicRemark"] = public["public_note"]
    elif str(public.get("location") or "").strip() and not str(public.get("region") or "").strip():
        public["public_note"] = public["location"]

    return public
