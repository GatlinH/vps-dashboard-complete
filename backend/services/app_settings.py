import json
import os
import tempfile
import logging
from copy import deepcopy
from pathlib import Path
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)

import bleach
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
_ALLOWED_HTML_TAGS = [
    "a", "abbr", "b", "blockquote", "br", "code", "del", "em", "h1", "h2",
    "h3", "h4", "h5", "h6", "hr", "i", "li", "ol", "p", "pre", "span",
    "strong", "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]
_ALLOWED_HTML_ATTRIBUTES = {
    "a": ["href", "title", "target", "rel"],
    "abbr": ["title"],
    "td": ["colspan", "rowspan"],
    "th": ["colspan", "rowspan", "scope"],
}


def _sanitize_url(value):
    value = str(value or "").strip()
    if not value:
        return ""
    if any(ch in value for ch in ('"', "'", "<", ">", " ", "\\", "\r", "\n", "\x00")):
        return ""
    if value.startswith("/") and not value.startswith("//"):
        return value
    try:
        parsed = urlsplit(value)
    except ValueError:
        return ""
    if parsed.scheme.lower() == "https" and parsed.netloc:
        return value
    return ""


def _sanitize_html(value):
    value = str(value or "")
    if not value:
        return ""
    return bleach.clean(
        value.replace("\x00", ""),
        tags=_ALLOWED_HTML_TAGS,
        attributes=_ALLOWED_HTML_ATTRIBUTES,
        protocols=["http", "https"],
        strip=True,
    )


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
    if not secret:
        raise ValueError("MASTER_ENCRYPTION_KEY environment variable is required")
    return CryptoManager(secret)


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
            if not isinstance(payload, dict):
                raise ValueError("settings file root must be a JSON object")
            for k, v in payload.items():
                if isinstance(v, dict) and isinstance(data.get(k), dict):
                    data[k].update(v)
        except (OSError, IOError, json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"failed to read settings file: {exc}") from exc
    return data


def get_admin_settings(redact: bool = False):
    data = _read_raw()
    if redact and "login" in data:
        login = data["login"]
        encrypted = str(login.get("api_key") or "")
        api_key_set = bool(encrypted)
        login.pop("api_key", None)
        login["api_key_set"] = api_key_set
        # Only derive a mask from the trusted decrypted value. Legacy entries
        # without metadata remain set but intentionally expose no mask.
        if api_key_set and login.get("api_key_masked"):
            try:
                secret = _crypto().decrypt(encrypted)
                login["api_key_masked"] = _mask(secret)
            except Exception:
                login["api_key_masked"] = ""
        else:
            login["api_key_masked"] = ""
    return data


def _write(data):
    settings_file = _settings_file()
    settings_file.parent.mkdir(parents=True, exist_ok=True)
    settings_file.parent.chmod(0o700)
    fd = -1
    temporary_path = None
    try:
        fd, temporary_path = tempfile.mkstemp(prefix=f".{settings_file.name}.", dir=str(settings_file.parent))
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as temporary_file:
            fd = -1
            json.dump(data, temporary_file, ensure_ascii=False, indent=2)
            temporary_file.flush()
            os.fsync(temporary_file.fileno())
        os.rename(temporary_path, settings_file)
        temporary_path = None
    except Exception:
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass
        raise
    finally:
        try:
            if temporary_path:
                os.unlink(temporary_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("failed to clean temporary settings file %s: %s", temporary_path, exc)


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
        if "api_key" in payload:
            api_key = str(payload.get("api_key") or "").strip()
            current_secret = ""
            current_cipher = str(section_data.get("api_key") or "")
            if current_cipher:
                try:
                    current_secret = _crypto().decrypt(current_cipher)
                except Exception:
                    current_secret = ""
            trusted_mask = _mask(current_secret) if current_secret and section_data.get("api_key_masked") else ""
            if not api_key:
                pass
            elif trusted_mask and api_key == trusted_mask:
                pass
            elif "*" in api_key and not trusted_mask:
                pass
            elif "*" in api_key and trusted_mask:
                raise ValueError("api_key masked value is invalid")
            else:
                section_data["api_key"] = _crypto().encrypt(api_key)
                section_data["api_key_masked"] = _mask(api_key)
            if (not api_key) and (payload.get("clear_api_key") is True or payload.get("api_key_clear") is True):
                section_data["api_key"] = ""
                section_data["api_key_masked"] = ""
        for key in ["disable_password_login", "sso_enabled", "github_client_id", "allowed_emails", "sso_provider", "sso_config", "api_key_enabled", "breakglass_enabled"]:
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
