import json
import os
import re
from copy import deepcopy
from pathlib import Path

from utils.crypto import CryptoManager

DEFAULT_SETTINGS = {
    "site": {
        "site_name": "VPS星图",
        "site_description": "A simple server monitor tool.",
        "proxy_url": "",
        "single_site_mode": False,
        "auto_share": "manual",
        "temporary_share_enabled": False,
        "temporary_share_token": "",
        "temporary_share_expires_at": "",
        "custom_head": "",
        "custom_body": "",
        "favicon_data_url": "",
        "show_ip_labels": True,
        "show_detail_server_list": True,
        "desktop_background_url": "",
        "mobile_background_url": "",
        "marketplace_node_position": "last",
        "custom_footer_html": "",
        "main_content_width": 100,
    },
    "general": {
        "auto_discovery_button": "",
        "geoip_enabled": True,
        "geoip_provider": "ipinfo.io",
        "history_enabled": True,
        "retention_load_hours": 720,
        "retention_ping_hours": 24,
        "nezha_grpc_enabled": False,
        "nezha_grpc_listen": "0.0.0.0:5555",
    },
    "reverse_proxy": {
        "cloudflare_token_masked": "",
        "cloudflare_token_encrypted": "",
        "cloudflared_bin": "",
    },
    "login": {
        "disable_password_login": False,
        "sso_enabled": False,
        "github_client_id": "",
        "github_client_secret_masked": "",
        "github_client_secret_encrypted": "",
        "allowed_emails": "",
        "sso_provider": "CloudflareAccess",
        "sso_config": {},
        "api_key": "",
        "api_key_enabled": False,
        "breakglass_enabled": True,
    },
    "notifications": {
        "enabled": False,
        "default_channel": "telegram",
        "notify_on_offline": True,
        "notify_on_recovery": True,
        "notify_on_high_load": True,
        "message_prefix": "【VPS星图通知】",
        "test_recipient": "",
        "telegram_bot_id": None,
        "telegram_chat_id": "",
        "message_template": "Clients: {{client}}\nMessage: {{message}}\nTime: {{time}}",
        "channels": {"telegram": {}, "webhook": {}, "email": {}, "Javascript": {}, "Server酱Turbo": {}, "Server酱³": {}, "Server酱": {}, "bark": {}, "empty": {}},
    },
}


def _settings_file() -> Path:
    raw = (os.getenv("ADMIN_SETTINGS_FILE", "") or "").strip()
    if raw:
        return Path(raw)
    return Path("/var/lib/vps-dashboard/admin-settings.json")



_ALLOWED_URL_KEYS = {
    "desktop_background_url", "mobile_background_url", "login_background_url",
    "starmap_background_url", "logo_image_url", "favicon_image_url",
    "earth_texture_url", "cloud_texture_url", "hero_image_url", "node_icon_url",
    "proxy_url", "auto_discovery_button",
}
_ALLOWED_URL_SCHEMES = ("https://", "http://")
_DANGEROUS_URL_RE = re.compile(r"^\s*(javascript|data|vbscript|file|blob):", re.I)
_DATA_IMAGE_RE = re.compile(r"^\s*data:image/(png|jpe?g|webp|gif|ico|x-icon);base64,", re.I)
_DANGEROUS_BLOCK_RE = re.compile(r"<\s*(script|iframe|object|embed|svg|math|style)\b[^>]*>.*?<\s*/\s*\1\s*>", re.I | re.S)
_DANGEROUS_HTML_RE = re.compile(r"<\s*/?\s*(script|iframe|object|embed|link|meta|base|form|input|button|textarea|select|svg|math|style)[^>]*>", re.I)
_EVENT_ATTR_RE = re.compile(r"\s+on[a-zA-Z0-9_-]+\s*=\s*(?:(['\"]).*?\1|[^\s>]+)", re.I | re.S)
_JS_URL_ATTR_RE = re.compile(r"\s+(href|src|xlink:href|formaction|action|poster)\s*=\s*(?:(['\"])\s*(javascript|data|vbscript|file|blob):.*?\2|\s*(javascript|data|vbscript|file|blob):[^\s>]+)", re.I | re.S)
_STYLE_ATTR_RE = re.compile(r"\s+style\s*=\s*(?:(['\"]).*?\1|[^\s>]+)", re.I | re.S)


def _sanitize_url(value):
    value = str(value or "").strip()
    if not value:
        return ""
    if any(ch in value for ch in ('\r', '\n', '\x00')):
        return ""
    lowered = value.lower()
    if _DANGEROUS_URL_RE.match(value):
        # Only allow a very small safe data-image subset; never SVG/HTML/scriptable data URLs.
        return value if _DATA_IMAGE_RE.match(value) else ""
    # Allow site-local absolute paths used by this dashboard, e.g. /assets/custom/logo.png.
    if value.startswith("/") and not value.startswith("//") and not lowered.startswith("/\\"):
        return value
    # Prefer https; keep http only because this deployment is still bare-IP HTTP compatible.
    if lowered.startswith(_ALLOWED_URL_SCHEMES):
        return value
    return ""


def _sanitize_html(value):
    value = str(value or "")
    if not value:
        return ""
    value = value.replace("\x00", "")
    value = _DANGEROUS_BLOCK_RE.sub("", value)
    # Strip dangerous standalone/open/close tags too: <script src=x>, <svg onload=...>, etc.
    value = _DANGEROUS_HTML_RE.sub("", value)
    value = _EVENT_ATTR_RE.sub("", value)
    value = _JS_URL_ATTR_RE.sub("", value)
    value = _STYLE_ATTR_RE.sub("", value)
    return value


def _sanitize_value(key, value):
    if key in _ALLOWED_URL_KEYS or key.endswith("_url") or key.endswith("_image") or key.endswith("_texture"):
        return _sanitize_url(value)
    if key in {"custom_head", "custom_body", "custom_footer_html"}:
        return _sanitize_html(value)
    if isinstance(value, dict):
        return {k: _sanitize_value(k, v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(key, v) for v in value]
    return value


def _crypto():
    secret = os.getenv("MASTER_ENCRYPTION_KEY", "").strip()
    return CryptoManager(secret) if secret else None


def _mask(value: str, head: int = 4, tail: int = 4):
    value = str(value or "").strip()
    if not value:
        return ""
    if len(value) <= head + tail:
        return "*" * len(value)
    return f"{value[:head]}****{value[-tail:]}"


def _read_raw():
    data = deepcopy(DEFAULT_SETTINGS)
    settings_file = _settings_file()
    if settings_file.exists():
        try:
            payload = json.loads(settings_file.read_text())
            for k, v in payload.items():
                if isinstance(v, dict) and isinstance(data.get(k), dict):
                    data[k].update(v)
        except Exception:
            pass
    return data


def get_admin_settings():
    return _read_raw()


def _write(data):
    settings_file = _settings_file()
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    settings_file.write_text(json.dumps(data, ensure_ascii=False, indent=2))


def _save_secret(section_data: dict, payload: dict, input_key: str, masked_key: str, encrypted_key: str):
    if input_key not in payload:
        return
    secret = str(payload.get(input_key, "")).strip()
    if secret:
        crypto = _crypto()
        if crypto:
            section_data[encrypted_key] = crypto.encrypt(secret)
        else:
            section_data[encrypted_key] = ""
        section_data[masked_key] = _mask(secret)
        return
    section_data[masked_key] = ""
    section_data[encrypted_key] = ""


def update_admin_settings(section: str, payload: dict):
    data = _read_raw()
    section_data = data.setdefault(section, {})

    if section == "reverse_proxy":
        _save_secret(section_data, payload, "cloudflare_token", "cloudflare_token_masked", "cloudflare_token_encrypted")
        for key in ["cloudflared_bin"]:
            if key in payload:
                section_data[key] = _sanitize_value(key, payload.get(key) or "")
    elif section == "login":
        _save_secret(section_data, payload, "github_client_secret", "github_client_secret_masked", "github_client_secret_encrypted")
        for key in ["disable_password_login", "sso_enabled", "github_client_id", "allowed_emails", "sso_provider", "sso_config", "api_key", "api_key_enabled", "breakglass_enabled"]:
            if key in payload:
                section_data[key] = _sanitize_value(key, payload.get(key))
    elif section == "notifications":
        for key in [
            "enabled", "default_channel", "notify_on_offline", "notify_on_recovery",
            "notify_on_high_load", "message_prefix", "test_recipient", "telegram_bot_id", "telegram_chat_id", "message_template", "channels",
        ]:
            if key in payload:
                section_data[key] = _sanitize_value(key, payload.get(key))
    else:
        for key, value in payload.items():
            if key in section_data:
                section_data[key] = _sanitize_value(key, value)

    _write(data)
    return data.get(section, {})
