from flask import Blueprint, jsonify, request, current_app, send_file, Response
from middleware.rbac import viewer_or_admin_required, admin_required, owner_required
from models.models import db, OpsEvent, Server, TelegramConfig, record_ops_event

import os
import shutil
import secrets
import subprocess
import base64
import json
import re
import urllib.parse
import urllib.request
from urllib.parse import urlparse
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
from datetime import datetime, timezone
from services.app_settings import get_admin_settings, update_admin_settings, _crypto
from api.telegram import send_message

def _audit_ops_high_risk(action, title, section=None):
    try:
        from flask_jwt_extended import get_jwt_identity, get_jwt
        claims = get_jwt() or {}
        record_ops_event(
            action,
            title,
            message=title,
            level="warn",
            payload={
                "actor": get_jwt_identity(),
                "role": claims.get("role"),
                "section": section,
                "ip": request.headers.get("X-Forwarded-For", request.remote_addr or ""),
            },
        )
        db.session.commit()
    except Exception:
        db.session.rollback()


ops_bp = Blueprint("ops", __name__)

_UPDATE_IMAGES = (
    {"name": "backend", "image": "ghcr.io/gatlinh/vps-dashboard-complete-backend", "tag": "latest"},
    {"name": "frontend", "image": "ghcr.io/gatlinh/vps-dashboard-complete-frontend", "tag": "latest"},
)
_UPDATE_SERVICES = ("frontend", "api", "agent_consumer")


def _audit_manual_update(action, ok, message, payload=None):
    try:
        record_ops_event(
            f"manual_update_{action}",
            "手动更新检查" if action == "check" else "手动应用更新",
            message=(message or "")[:1000],
            level="info" if ok else "error",
            payload={"action": action, **(payload or {})},
        )
        db.session.commit()
    except Exception:
        db.session.rollback()


def _registry_token_for(scope):
    url = f"https://ghcr.io/token?service=ghcr.io&scope={urllib.parse.quote(scope, safe=':')}"
    headers = {}
    read_token = os.environ.get("GHCR_READ_TOKEN", "").strip()
    if read_token:
        headers["Authorization"] = f"Bearer {read_token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return data.get("token") or data.get("access_token") or ""


def _ghcr_manifest_digest(image, tag="latest"):
    owner, package = image.removeprefix("ghcr.io/").split("/", 1)
    repo = f"{owner}/{package}"
    url = f"https://ghcr.io/v2/{repo}/manifests/{tag}"
    accept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
    headers = {"Accept": accept}
    token = os.environ.get("GHCR_REGISTRY_TOKEN", "").strip() or _registry_token_for(f"repository:{repo}:pull")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        digest = resp.headers.get("Docker-Content-Digest") or ""
        return {"image": image, "tag": tag, "digest": digest, "status": getattr(resp, "status", 200)}


@ops_bp.get("/updates/status")
@viewer_or_admin_required
def updates_status():
    return jsonify(
        ok=True,
        mode="manual",
        auto_update=False,
        services=list(_UPDATE_SERVICES),
        images=_UPDATE_IMAGES,
        msg="当前为手动更新模式：检查更新不会重启服务；应用更新需要管理员确认。",
    ), 200


@ops_bp.post("/updates/check")
@admin_required
def updates_check():
    images = []
    errors = []
    for item in _UPDATE_IMAGES:
        try:
            images.append({**item, **_ghcr_manifest_digest(item["image"], item["tag"])})
        except Exception as exc:
            errors.append({"image": item["image"], "error": str(exc)[:300]})
    ok = not errors
    msg = "镜像清单检查完成" if ok else "部分镜像检查失败"
    _audit_manual_update("check", ok, msg, {"images": images, "errors": errors})
    return jsonify(ok=ok, action="check", update_available=None, images=images, errors=errors, msg=msg), 200 if ok else 502


@ops_bp.post("/updates/apply")
@admin_required
def updates_apply():
    token = os.environ.get("WATCHTOWER_HTTP_API_TOKEN", "").strip()
    if not token:
        return jsonify(ok=False, action="apply", msg="WATCHTOWER_HTTP_API_TOKEN 未配置，无法触发手动更新"), 503
    url = os.environ.get("WATCHTOWER_HTTP_API_URL", "http://watchtower:8080/v1/update").strip()
    req = urllib.request.Request(url, data=b"", method="POST", headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = resp.read().decode("utf-8", "replace")[:1000]
            ok = 200 <= getattr(resp, "status", 200) < 300
    except Exception as exc:
        _audit_manual_update("apply", False, str(exc), {"services": list(_UPDATE_SERVICES)})
        return jsonify(ok=False, action="apply", msg=f"触发 Watchtower 更新失败：{exc}"), 502
    _audit_manual_update("apply", ok, body or "已触发 Watchtower 手动更新", {"services": list(_UPDATE_SERVICES)})
    return jsonify(ok=ok, action="apply", msg="已触发 Watchtower 手动更新", output=body, services=list(_UPDATE_SERVICES)), 202 if ok else 502


@ops_bp.get("/events")
@viewer_or_admin_required
def list_ops_events():
    limit = min(request.args.get("limit", 80, type=int), 200)
    event_type = request.args.get("event_type", "").strip()
    server_id = request.args.get("server_id", type=int)
    query = OpsEvent.query.order_by(OpsEvent.created_at.desc())
    if event_type:
        query = query.filter(OpsEvent.event_type == event_type)
    if server_id:
        query = query.filter(OpsEvent.server_id == server_id)
    items = query.limit(limit).all()
    return jsonify(events=[i.to_dict() for i in items], total=len(items)), 200


@ops_bp.get("/summary")
@viewer_or_admin_required
def ops_summary():
    rows = OpsEvent.query.order_by(OpsEvent.created_at.desc()).limit(240).all()

    def pick(types):
        return [r.to_dict() for r in rows if r.event_type in types][:12]

    return jsonify(
        recent_agent_failures=pick(["agent_register_failed", "agent_push_failed"]),
        recent_rule_hits=pick(["alert_rule_fired"]),
        recent_tg_status=pick(["telegram_send_ok", "telegram_send_failed"]),
        recent_agent_reports=pick(["agent_register_ok", "agent_push_ok"]),
    ), 200



@ops_bp.post("/security-scan-log")
def security_scan_log():
    data = request.get_json(silent=True) or {}
    path = str(data.get("path") or "")[:240]
    method = str(data.get("method") or "GET")[:16]
    ip = str(data.get("ip") or request.remote_addr or "")[:120]
    ua = str(data.get("user_agent") or "")[:180]
    lower = path.lower()
    if not any(x in lower for x in ("/.env", "/.git", "wp-admin", "phpmyadmin", "xmlrpc")):
        return jsonify(ok=False), 400
    record_ops_event(
        "security_http_anomaly",
        "疑似扫描路径",
        message=f"{method} {path} -> 404",
        level="warn",
        payload={"method": method, "path": path, "status": 404, "ip": ip, "user_agent": ua},
    )
    db.session.commit()
    return jsonify(ok=True), 202

def _runtime_oauth():
    base = (os.getenv("FRONTEND_URL") or request.host_url.rstrip("/")).rstrip("/")
    login = get_admin_settings().get("login", {})
    google_secret = bool(login.get("google_client_secret_encrypted") or os.getenv("GOOGLE_CLIENT_SECRET"))
    github_secret = bool(login.get("github_client_secret_encrypted") or os.getenv("GITHUB_CLIENT_SECRET"))
    return {
        "google": bool((login.get("google_client_id") or os.getenv("GOOGLE_CLIENT_ID")) and google_secret),
        "github": bool((login.get("github_client_id") or os.getenv("GITHUB_CLIENT_ID")) and github_secret),
        "allowlist_count": len([x for x in str(login.get("allowed_emails") or os.getenv("OAUTH_ADMIN_EMAILS", "")).split(",") if x.strip()]),
        "callback_url": f"{base}/api/v1/auth/oauth/github/callback",
    }


def _cloudflared_status(saved_settings=None):
    saved_settings = saved_settings or {}
    binary = saved_settings.get("cloudflared_bin") or shutil.which("cloudflared") or ""
    installed = bool(binary)
    running = False
    try:
        proc = subprocess.run(["pgrep", "-af", "cloudflared"], capture_output=True, text=True, timeout=3)
        running = proc.returncode == 0 and bool(proc.stdout.strip())
    except Exception:
        running = False
    return {
        "installed": installed,
        "binary": binary,
        "status": "running" if running else "stopped",
        "has_token": bool(saved_settings.get("cloudflare_token_masked")),
    }


def _redact_sensitive_settings(section: str, settings: dict):
    # Return settings safe for API responses; keep raw secrets server-side only.
    clean = dict(settings or {})
    if section == "site":
        clean.pop("temporary_share_token", None)
    elif section == "reverse_proxy":
        clean.pop("cloudflare_token_encrypted", None)
        clean.pop("cloudflare_token", None)
    elif section == "login":
        clean.pop("github_client_secret_encrypted", None)
        clean.pop("github_client_secret", None)
        api_key = str(clean.pop("api_key", "") or "").strip()
        clean["api_key_enabled"] = bool(clean.get("api_key_enabled") or api_key)
        clean["api_key_masked"] = (api_key[:4] + "****" + api_key[-4:]) if len(api_key) > 8 else ("********" if api_key else "")
    elif section == "notifications":
        channels = clean.get("channels")
        if isinstance(channels, dict):
            redacted_channels = {}
            for name, cfg in channels.items():
                if isinstance(cfg, dict):
                    c = dict(cfg)
                    for key in list(c.keys()):
                        lk = str(key).lower()
                        if any(part in lk for part in ("token", "secret", "password", "passwd", "api_key", "apikey", "sendkey")):
                            val = str(c.get(key) or "")
                            c[key] = (val[:3] + "****" + val[-3:]) if len(val) > 6 else ("******" if val else "")
                    redacted_channels[name] = c
                else:
                    redacted_channels[name] = cfg
            clean["channels"] = redacted_channels
    return clean


def _site_response(site: dict):
    safe = _redact_sensitive_settings("site", site)
    return {**safe, "favicon": _site_favicon_info(site)}

_SITE_ASSET_FIELDS = {
    "desktop_background_url", "mobile_background_url", "login_background_url",
    "starmap_background_url", "logo_image_url", "favicon_image_url",
    "earth_texture_url", "cloud_texture_url", "hero_image_url", "node_icon_url",
}
_ALLOWED_LOCAL_ASSET_PREFIXES = ("/assets/custom/", "/assets/", "/static/", "/favicon.ico")
_FORBIDDEN_HTML_RE = re.compile(r"(<\s*script\b|on[a-z]+\s*=|javascript\s*:|data\s*:|<\s*iframe\b|<\s*object\b|<\s*embed\b|<\s*link\b|<\s*meta\b)", re.I)


def _validate_site_asset_url(value, field):
    if value is None or value == "":
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{field} 必须是字符串 URL 或留空")
    raw = value.strip()
    if not raw:
        return ""
    low = raw.lower()
    if low.startswith(("javascript:", "data:", "file:", "ftp:", "blob:", "//")):
        raise ValueError(f"{field} 仅允许 /assets/custom/... 站内路径或 https:// 外链")
    if low.startswith("http://"):
        raise ValueError(f"{field} 禁止 http://，请使用 https:// 或站内路径")
    if low.startswith("https://"):
        parsed = urlparse(raw)
        if not parsed.netloc or any(ch in raw for ch in ("\n", "\r")):
            raise ValueError(f"{field} 不是有效 https URL")
        return raw
    if raw.startswith("/"):
        if any(ch in raw for ch in ("\n", "\r", "\\")) or ".." in raw:
            raise ValueError(f"{field} 路径非法")
        if not raw.startswith(_ALLOWED_LOCAL_ASSET_PREFIXES):
            raise ValueError(f"{field} 仅允许 /assets/custom/...、/assets/...、/static/... 或 /favicon.ico")
        return raw
    raise ValueError(f"{field} 仅允许站内绝对路径或 https:// 外链")


def _validate_custom_footer_html(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ValueError("custom_footer_html 必须是字符串")
    if len(value) > 20000:
        raise ValueError("custom_footer_html 过长")
    if _FORBIDDEN_HTML_RE.search(value or ""):
        raise ValueError("custom_footer_html 禁止 script/事件属性/javascript/data/iframe/object/embed/meta/link")
    return value


def _validate_site_settings_payload(payload: dict):
    if not isinstance(payload, dict):
        raise ValueError("请求体必须是 JSON 对象")
    clean = dict(payload)
    for field in _SITE_ASSET_FIELDS:
        if field in clean:
            clean[field] = _validate_site_asset_url(clean.get(field), field)
    custom_images = clean.get("custom_images")
    if custom_images is not None:
        if not isinstance(custom_images, dict):
            raise ValueError("custom_images 必须是对象")
        ci = dict(custom_images)
        for field in _SITE_ASSET_FIELDS:
            if field in ci:
                ci[field] = _validate_site_asset_url(ci.get(field), f"custom_images.{field}")
        clean["custom_images"] = ci
    if "custom_footer_html" in clean:
        clean["custom_footer_html"] = _validate_custom_footer_html(clean.get("custom_footer_html"))
    if "main_content_width" in clean:
        try:
            width = int(clean.get("main_content_width") or 100)
        except Exception:
            raise ValueError("main_content_width 必须是数字")
        if width < 40 or width > 100:
            raise ValueError("main_content_width 必须在 40 到 100 之间")
        clean["main_content_width"] = width
    if clean.get("marketplace_node_position") not in (None, "", "first", "keep", "last"):
        raise ValueError("marketplace_node_position 仅允许 first/keep/last")
    return clean



def _reverse_proxy_response(settings: dict):
    safe = _redact_sensitive_settings("reverse_proxy", settings)
    return {**safe, **_cloudflared_status(settings)}


def _login_runtime(saved_settings=None):
    saved_settings = saved_settings or {}
    safe = _redact_sensitive_settings("login", saved_settings)
    return {
        **safe,
        "breakglass_enabled": saved_settings.get("breakglass_enabled", True),
        "runtime_github_configured": bool((saved_settings.get("github_client_id") or os.getenv("GITHUB_CLIENT_ID")) and (saved_settings.get("github_client_secret_encrypted") or os.getenv("GITHUB_CLIENT_SECRET"))),
        "runtime_google_configured": bool((saved_settings.get("google_client_id") or os.getenv("GOOGLE_CLIENT_ID")) and (saved_settings.get("google_client_secret_encrypted") or os.getenv("GOOGLE_CLIENT_SECRET"))),
    }


@ops_bp.get("/settings-summary")
@viewer_or_admin_required
def settings_summary():
    tg = TelegramConfig.query.order_by(TelegramConfig.id.asc()).first()
    oauth = _runtime_oauth()
    servers = Server.query.all()
    agent_claimed = sum(1 for s in servers if getattr(s, "uuid", None))
    agent_keys = sum(1 for s in servers if getattr(s, "agent_key_hash", None))
    security = {
        "jwt_cookie_secure": bool(current_app.config.get("JWT_COOKIE_SECURE", False)),
        "jwt_cookie_samesite": current_app.config.get("JWT_COOKIE_SAMESITE", "Lax"),
        "jwt_cookie_csrf_protect": bool(current_app.config.get("JWT_COOKIE_CSRF_PROTECT", False)),
        "force_https": bool(current_app.config.get("FORCE_HTTPS", False)),
        "admin_default_password_set": bool(current_app.config.get("ADMIN_DEFAULT_PASSWORD", "")),
    }
    telegram = {
        "enabled": bool(getattr(tg, "enabled", False)),
        "has_token": bool(getattr(tg, "bot_token", "")),
        "chat_id_masked": getattr(tg, "to_dict", lambda: {})().get("chat_id_masked", "") if tg else "",
        "prefix": getattr(tg, "prefix", "【VPS星图】") if tg else "【VPS星图】",
    }
    settings = get_admin_settings()
    return jsonify(
        oauth=oauth,
        telegram=telegram,
        agent={
            "server_total": len(servers),
            "claimed_total": agent_claimed,
            "key_bound_total": agent_keys,
            "unclaimed_total": max(0, len(servers) - agent_claimed),
        },
        security=security,
        site=_redact_sensitive_settings("site", settings.get("site", {})),
        general=settings.get("general", {}),
        reverse_proxy=_reverse_proxy_response(settings.get("reverse_proxy", {})),
        login=_login_runtime(settings.get("login", {})),
        notifications=_redact_sensitive_settings("notifications", settings.get("notifications", {})),
    ), 200


_ALLOWED_FAVICON_TYPES = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
}


def _site_favicon_info(site=None):
    site = site or get_admin_settings().get("site", {})
    data_url = str(site.get("favicon_data_url") or "").strip()
    if not data_url.startswith("data:"):
        return {"has_custom_icon": False, "favicon_url": "/favicon.ico", "content_type": "image/x-icon", "size": 0}
    try:
        header, payload = data_url.split(",", 1)
        content_type = header[5:].split(";", 1)[0] or "application/octet-stream"
        raw_len = len(base64.b64decode(payload, validate=False))
    except Exception:
        content_type, raw_len = "application/octet-stream", 0
    return {"has_custom_icon": True, "favicon_url": "/api/v1/ops/settings/site/favicon", "content_type": content_type, "size": raw_len}


def _data_url_to_bytes(data_url: str):
    header, payload = data_url.split(",", 1)
    content_type = header[5:].split(";", 1)[0] or "application/octet-stream"
    return content_type, base64.b64decode(payload)


@ops_bp.get("/settings/site")
@viewer_or_admin_required
def get_site_settings():
    site = get_admin_settings().get("site", {})
    return jsonify(_site_response(site)), 200


@ops_bp.put("/settings/site")
@admin_required
def put_site_settings():
    payload = request.get_json(silent=True) or {}
    try:
        payload = _validate_site_settings_payload(payload)
    except ValueError as exc:
        return jsonify(error="invalid_site_settings", message=str(exc)), 400
    saved = update_admin_settings("site", payload)
    return jsonify(_site_response(saved)), 200


@ops_bp.post("/settings/site/share/generate")
@admin_required
def generate_site_share_link():
    payload = request.get_json(silent=True) or {}
    hours = payload.get("hours", 24)
    try:
        hours = max(1, min(int(hours), 720))
    except Exception:
        hours = 24
    now = datetime.now(timezone.utc)
    expires = now.timestamp() + hours * 3600
    token = secrets.token_urlsafe(24)
    saved = update_admin_settings("site", {
        "temporary_share_enabled": True,
        "temporary_share_token": token,
        "temporary_share_expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat(),
        "auto_share": "manual",
    })
    return jsonify({**_site_response(saved), "share_url": f"/?share={token}", "msg": "✅ 临时访问链接已生成"}), 200


@ops_bp.post("/settings/site/share/revoke")
@admin_required
def revoke_site_share_link():
    saved = update_admin_settings("site", {
        "temporary_share_enabled": False,
        "temporary_share_token": "",
        "temporary_share_expires_at": "",
    })
    return jsonify({**_site_response(saved), "share_url": "", "msg": "✅ 临时访问链接已撤销"}), 200


@ops_bp.get("/settings/site/favicon")
def get_site_favicon():
    site = get_admin_settings().get("site", {})
    data_url = str(site.get("favicon_data_url") or "").strip()
    if not data_url.startswith("data:"):
        return Response(status=404)
    try:
        content_type, raw = _data_url_to_bytes(data_url)
    except Exception:
        return Response(status=404)
    return Response(raw, mimetype=content_type, headers={"Cache-Control": "no-store, max-age=0"})


@ops_bp.post("/settings/site/favicon")
@admin_required
def upload_site_favicon():
    file = request.files.get("icon") or request.files.get("file")
    if not file:
        return jsonify(msg="请选择网站图标文件"), 400
    content_type = (file.content_type or "").split(";", 1)[0].strip().lower()
    filename = (file.filename or "favicon").lower()
    if content_type not in _ALLOWED_FAVICON_TYPES:
        if filename.endswith(".ico"):
            content_type = "image/x-icon"
        elif filename.endswith(".svg"):
            return jsonify(msg="出于安全原因不支持 SVG 图标；请使用 PNG/WebP/ICO"), 400
        else:
            return jsonify(msg="仅支持 PNG/JPG/WebP/ICO 图标"), 400
    raw = file.read(256 * 1024 + 1)
    if len(raw) > 256 * 1024:
        return jsonify(msg="图标文件不能超过 256KB"), 413
    payload = {"favicon_data_url": f"data:{content_type};base64,{base64.b64encode(raw).decode('ascii')}"}
    saved = update_admin_settings("site", payload)
    return jsonify(_site_response(saved)), 200


@ops_bp.delete("/settings/site/favicon")
@admin_required
def reset_site_favicon():
    saved = update_admin_settings("site", {"favicon_data_url": ""})
    return jsonify(_site_response(saved)), 200


@ops_bp.get("/settings/site/backup")
@admin_required
def download_site_backup():
    settings = get_admin_settings()
    safe_settings = {}
    for section, value in (settings or {}).items():
        if isinstance(value, dict):
            if section in {"site", "reverse_proxy", "login", "notifications"}:
                safe_settings[section] = _redact_sensitive_settings(section, value)
            else:
                safe_settings[section] = dict(value)
        else:
            safe_settings[section] = value
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    manifest = {"app": "vps-dashboard", "kind": "site-settings-backup", "created_at": datetime.now(timezone.utc).isoformat(), "sections": list(safe_settings.keys()), "redacted": True}
    buf = BytesIO()
    with ZipFile(buf, "w", ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        zf.writestr("admin-settings.json", json.dumps(safe_settings, ensure_ascii=False, indent=2))
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=f"vps-dashboard-site-backup-{stamp}.zip")


@ops_bp.post("/settings/site/backup/restore")
@owner_required
def restore_site_backup():
    file = request.files.get("backup") or request.files.get("file")
    if not file:
        return jsonify(msg="请选择备份 ZIP 文件"), 400
    raw = file.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        return jsonify(msg="备份文件不能超过 2MB"), 413
    try:
        with ZipFile(BytesIO(raw), "r") as zf:
            names = set(zf.namelist())
            if "admin-settings.json" not in names:
                return jsonify(msg="备份文件缺少 admin-settings.json"), 400
            payload = json.loads(zf.read("admin-settings.json").decode("utf-8"))
    except Exception as exc:
        return jsonify(msg=f"备份文件解析失败：{exc}"), 400
    if not isinstance(payload, dict):
        return jsonify(msg="备份内容格式错误"), 400
    allowed = {"site", "general", "reverse_proxy", "login", "notifications"}
    restored = []
    for section in allowed:
        if isinstance(payload.get(section), dict):
            update_admin_settings(section, payload[section])
            restored.append(section)
    site = get_admin_settings().get("site", {})
    return jsonify(msg="备份已恢复", restored=restored, site=_site_response(site)), 200


@ops_bp.get("/settings/general")
@viewer_or_admin_required
def get_general_settings():
    return jsonify(get_admin_settings().get("general", {})), 200


@ops_bp.put("/settings/general")
@admin_required
def put_general_settings():
    payload = request.get_json(silent=True) or {}
    saved = update_admin_settings("general", payload)
    return jsonify(saved), 200


@ops_bp.post("/settings/general/geoip/update")
@admin_required
def update_geoip_database():
    """触发 GeoIP 数据库更新/刷新状态。

    当前部署未配置 MaxMind License 时不伪造下载成功；按钮仍提供后台入口，
    会记录一次更新时间并回报本地 MMDB 文件状态，便于后续接入真实下载任务。
    """
    settings = get_admin_settings().get("general", {})
    provider = settings.get("geoip_provider", "ipinfo.io")
    candidates = [
        os.environ.get("GEOIP_MMDB_PATH", ""),
        "/var/lib/vps-dashboard/GeoLite2-City.mmdb",
        "/var/lib/vps-dashboard/GeoLite2-Country.mmdb",
        "/usr/share/GeoIP/GeoLite2-City.mmdb",
        "/usr/share/GeoIP/GeoLite2-Country.mmdb",
    ]
    existing = [p for p in candidates if p and os.path.exists(p)]
    payload = {
        "geoip_last_update_at": datetime.now(timezone.utc).isoformat(),
        "geoip_last_update_provider": provider,
        "geoip_database_path": existing[0] if existing else "",
        "geoip_database_present": bool(existing),
    }
    saved = update_admin_settings("general", payload)
    if provider == "maxmind" and not existing and not os.environ.get("MAXMIND_LICENSE_KEY"):
        return jsonify({**saved, "msg": "已刷新 GeoIP 状态；未检测到本地 MMDB 或 MAXMIND_LICENSE_KEY，无法自动下载 MaxMind 数据库。"}), 200
    if existing:
        return jsonify({**saved, "msg": f"✅ GeoIP 数据库状态已更新：{existing[0]}"}), 200
    return jsonify({**saved, "msg": f"✅ GeoIP 数据源 {provider} 已刷新（在线数据源无需本地数据库）。"}), 200


@ops_bp.get("/settings/reverse-proxy/cloudflare")
@viewer_or_admin_required
def get_cloudflare_settings():
    settings = get_admin_settings().get("reverse_proxy", {})
    return jsonify(_reverse_proxy_response(settings)), 200


@ops_bp.put("/settings/reverse-proxy/cloudflare")
@admin_required
def put_cloudflare_settings():
    payload = request.get_json(silent=True) or {}
    saved = update_admin_settings("reverse_proxy", payload)
    return jsonify(_reverse_proxy_response(saved)), 200


@ops_bp.post("/settings/reverse-proxy/cloudflare/refresh")
@admin_required
def refresh_cloudflare_settings():
    settings = get_admin_settings().get("reverse_proxy", {})
    return jsonify(_reverse_proxy_response(settings)), 200


@ops_bp.get("/settings/login")
@viewer_or_admin_required
def get_login_settings():
    return jsonify(_login_runtime(get_admin_settings().get("login", {}))), 200


@ops_bp.put("/settings/login")
@admin_required
def put_login_settings():
    payload = request.get_json(silent=True) or {}
    _audit_ops_high_risk("login_settings_updated", "登录安全配置已修改", "login")
    saved = update_admin_settings("login", payload)
    return jsonify(_login_runtime(saved)), 200


@ops_bp.post("/settings/notifications/test")
@admin_required
def test_notification_settings():
    settings = get_admin_settings().get("notifications", {})
    channel = str(settings.get("default_channel") or "telegram").strip().lower()
    if channel != "telegram":
        return jsonify(msg="当前仅支持 Telegram 测试发送", channel=channel), 400

    bot_id = settings.get("telegram_bot_id")
    target = str(settings.get("telegram_chat_id") or settings.get("test_recipient") or "").strip()
    if not target:
        return jsonify(msg="请先在通知设置中填写测试接收目标或 Telegram Chat ID"), 400

    prefix = str(settings.get("message_prefix") or "【VPS星图通知】").strip() or "【VPS星图通知】"
    total = Server.query.count()
    online = Server.query.filter_by(status="online").count()
    body = (
        f"🔔 <b>通知测试成功</b>\n"
        f"当前监控 <b>{total}</b> 台服务器\n"
        f"在线: <b>{online}</b> 台\n"
        f"离线: <b>{total - online}</b> 台"
    )
    result = send_message(f"{prefix}\n\n{body}", chat_id=target, bot_id=bot_id)
    if result.get("ok"):
        return jsonify(msg="测试通知已发送", target=target, bot_id=bot_id), 200
    return jsonify(msg="测试通知发送失败", target=target, bot_id=bot_id, detail=result), 502


@ops_bp.get("/settings/notifications")
@viewer_or_admin_required
def get_notification_settings():
    return jsonify(_redact_sensitive_settings("notifications", get_admin_settings().get("notifications", {}))), 200


@ops_bp.put("/settings/notifications")
@admin_required
def put_notification_settings():
    payload = request.get_json(silent=True) or {}
    saved = update_admin_settings("notifications", payload)
    return jsonify(_redact_sensitive_settings("notifications", saved)), 200
