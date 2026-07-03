"""
/api/telegram  —  Bot 配置 / 发消息 / 告警规则 / Webhook 处理
"""
import json
import requests
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app
from extensions import db
from models.models import TelegramConfig, AlertRule, Server, record_ops_event
from sqlalchemy import or_
from middleware.rbac import admin_required, viewer_or_admin_required
from middleware.rate_limit import limiter

telegram_bp = Blueprint("telegram", __name__)

TG_API = "https://api.telegram.org/bot{token}/{method}"
ALERT_RULE_TYPES = {"cpu", "ram", "disk", "bandwidth", "offline", "expiry", "latency", "consecutive_failures"}



def _tg_api(method: str, token: str = None, payload: dict | None = None, http_method: str = "POST") -> dict:
    cfg = _get_config()
    token = token or cfg.bot_token
    if not token:
        return {"ok": False, "error": "Bot Token not configured"}
    url = TG_API.format(token=token, method=method)
    try:
        if http_method.upper() == "GET":
            resp = requests.get(url, params=payload or {}, timeout=12)
        else:
            resp = requests.post(url, json=payload or {}, timeout=12)
        return resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _server_status_text(server: Server) -> str:
    cfg_map = server.agent_config if isinstance(server.agent_config, dict) else {}
    meta = cfg_map.get("inventory_meta", {}) if isinstance(cfg_map.get("inventory_meta", {}), dict) else {}
    os_name = meta.get("os") or "unknown"
    arch = meta.get("arch") or "unknown"
    hostname = meta.get("hostname") or "unknown"
    lat = getattr(server, "lat", None)
    lon = getattr(server, "lon", None)
    if lat is None or lon is None:
        lat = cfg_map.get("lat", lat)
        lon = cfg_map.get("lon", lon)
    coords = f"{lat}, {lon}" if lat is not None and lon is not None else "unset"
    cpu = getattr(server, "cpu_cores", getattr(server, "cpu", 0)) or 0
    ram = getattr(server, "ram_gb", getattr(server, "ram", 0)) or 0
    disk = getattr(server, "disk_gb", getattr(server, "disk", 0)) or 0
    bandwidth = getattr(server, "bandwidth", getattr(server, "bw", "-")) or "-"
    provider = getattr(server, "provider", "") or "-"
    tags = getattr(server, "tags", []) or []
    tag_text = " / ".join(tags) if tags else "-"
    cpu_use = round(float(getattr(server, "cpu_use", 0) or 0), 1)
    ram_use = round(float(getattr(server, "ram_use", 0) or 0), 1)
    disk_use = round(float(getattr(server, "disk_use", 0) or 0), 1)
    return (
        f"<b>{server.name}</b>\n"
        f"ID: <code>{server.id}</code>\n"
        f"Status: <b>{server.status or 'unknown'}</b>\n"
        f"IP: <code>{server.ip or '-'}</code>\n"
        f"Location: {server.location or '-'}\n"
        f"Provider: {provider}\n"
        f"Tags: {tag_text}\n"
        f"CPU: {cpu} cores ({cpu_use}%)\n"
        f"RAM: {ram} GB ({ram_use}%)\n"
        f"Disk: {disk} GB ({disk_use}%)\n"
        f"Bandwidth: {bandwidth}\n"
        f"OS: {os_name}\n"
        f"Arch: {arch}\n"
        f"Hostname: {hostname}\n"
        f"Coords: {coords}\n"
        f"Uptime: {server.uptime or '-'}\n"
        f"Updated: {server.updated_at or '-'}"
    )

def _find_servers(query: str, status: str | None = None):
    q = (query or '').strip()
    qs = Server.query
    if status:
        qs = qs.filter(Server.status == status)
    if not q:
        return qs.order_by(Server.id.asc()).all()
    if q.isdigit():
        exact = qs.filter(Server.id == int(q)).order_by(Server.id.asc()).all()
        if exact:
            return exact
    like = f"%{q}%"
    return qs.filter(or_(
        Server.name.ilike(like),
        Server.location.ilike(like),
        Server.ip.ilike(like),
        Server.group_name.ilike(like),
        Server.provider.ilike(like),
    )).order_by(Server.id.asc()).all()


def _handle_command_message(text: str, chat_id: str):
    raw = (text or "").strip()
    parts = raw.split()
    prefix = _get_config().prefix
    if not parts:
        return send_message(_full_msg(prefix, "欢迎使用 VPS 星图机器人（只读监控模式）。\n\n本机器人只能查询状态和接收告警，不能操控 VPS。\n\n可用命令：\n/vps [关键词] - 查看全部/筛选 VPS\n/status 名称或ID - 查看单台实时状态\n/online [关键词] - 查看在线 VPS\n/offline [关键词] - 查看离线 VPS\n/warn [关键词] - 查看预警 VPS\n/help - 查看帮助"), chat_id=chat_id)
    head = parts[0].lower()
    if head in ["/start", "/help"]:
        return send_message(_full_msg(prefix, "可用命令：\n/vps [关键词] - 查看全部/筛选 VPS\n/status 名称或ID - 查看单台实时状态\n/online [关键词] - 在线列表\n/offline [关键词] - 离线列表\n/warn [关键词] - 预警列表\n\n你也可以先发送 /vps，再直接点击按钮查看机器状态。"), chat_id=chat_id)
    if head == "/vps":
        query = raw[len("/vps"):].strip()
        servers = _find_servers(query)
        if not servers:
            return send_message(_full_msg(prefix, f"未找到匹配 VPS：{query}"), chat_id=chat_id)
        title = f"VPS 列表（筛选：{query}）" if query else "当前 VPS 列表"
        lines = [f"{s.id}. {s.name} · {s.location or '-'} · {s.status or 'unknown'}" for s in servers]
        keyboard = {"inline_keyboard": [[{"text": s.name[:32], "callback_data": f"status:{s.id}"}] for s in servers[:20]]}
        payload = {
            "chat_id": chat_id,
            "text": _full_msg(prefix, title + "（可直接点按钮查看状态）\n\n" + "\n".join(lines)),
            "parse_mode": "HTML",
            "reply_markup": keyboard,
        }
        return _tg_api("sendMessage", payload=payload)
    if head == "/status":
        query = raw[len("/status"):].strip()
        if not query:
            return send_message(_full_msg(prefix, "用法：/status 名称或ID\n例如：/status 8\n或：/status 192-VPS-Agent-01"), chat_id=chat_id)
        servers = _find_servers(query)
        server = servers[0] if servers else None
        if server is None:
            return send_message(_full_msg(prefix, f"未找到对应 VPS：{query}\n先发 /vps 查看可用名称。"), chat_id=chat_id)
        return send_message(_full_msg(prefix, _server_status_text(server)), chat_id=chat_id)
    if head == "/summary":
        total = Server.query.count()
        online = Server.query.filter_by(status="online").count()
        warn = Server.query.filter_by(status="warn").count()
        offline = Server.query.filter_by(status="offline").count()
        body = (
            f"星图概览\n\n"
            f"总节点：{total}\n"
            f"在线：{online}\n"
            f"预警：{warn}\n"
            f"离线：{offline}"
        )
        return send_message(_full_msg(prefix, body), chat_id=chat_id)
    if head in ["/online", "/offline", "/warn"]:
        status_map = {"/online": ("online", "在线"), "/offline": ("offline", "离线"), "/warn": ("warn", "预警")}
        target_status, label = status_map[head]
        query = raw[len(head):].strip()
        servers = _find_servers(query, status=target_status)
        if not servers:
            return send_message(_full_msg(prefix, f"当前没有{label} VPS。" if not query else f"未找到匹配的{label} VPS：{query}"), chat_id=chat_id)
        title = f"{label} VPS（筛选：{query}）" if query else f"当前{label} VPS"
        lines = [f"{s.id}. {s.name} · {s.location or '-'}" for s in servers]
        return send_message(_full_msg(prefix, title + "\n\n" + "\n".join(lines)), chat_id=chat_id)
    return send_message(_full_msg(prefix, "暂不支持这个命令。\n可用命令：/vps [关键词]、/status 名称或ID、/online [关键词]、/offline [关键词]、/warn [关键词]、/summary、/help"), chat_id=chat_id)


def poll_bot_updates() -> dict:
    cfg = _get_config()
    if not cfg.enabled or not cfg.bot_token:
        return {"ok": False, "reason": "telegram disabled"}
    state = current_app.config.setdefault("TG_BOT_STATE", {})
    offset = state.get("offset")
    data = _tg_api("getUpdates", payload={"timeout": 0, "offset": offset, "allowed_updates": ["message", "callback_query"]}, http_method="GET")
    if not data.get("ok"):
        return data
    handled = 0
    max_update_id = offset or 0
    for item in data.get("result", []):
        max_update_id = max(max_update_id, int(item.get("update_id", 0)))
        msg = item.get("message") or {}
        cb = item.get("callback_query") or {}
        if msg.get("text") and str(msg.get("chat", {}).get("id")) == str(cfg.chat_id):
            _handle_command_message(msg.get("text", ""), str(msg["chat"]["id"]))
            handled += 1
        elif cb:
            chat_id = str((cb.get("message") or {}).get("chat", {}).get("id", ""))
            data_s = cb.get("data", "")
            if chat_id == str(cfg.chat_id) and data_s.startswith("status:"):
                sid = data_s.split(":", 1)[1]
                server = db.session.get(Server, int(sid)) if sid.isdigit() else None
                if server:
                    send_message(_full_msg(cfg.prefix, _server_status_text(server)), chat_id=chat_id)
                _tg_api("answerCallbackQuery", payload={"callback_query_id": cb.get("id"), "text": "状态已发送"})
                handled += 1
    if max_update_id:
        state["offset"] = max_update_id + 1
    return {"ok": True, "handled": handled, "offset": state.get("offset")}


# ── 工具 ─────────────────────────────────────────────────────────────────────

def _get_config(bot_id: int | None = None) -> TelegramConfig:
    cfg = None
    if bot_id:
        cfg = db.session.get(TelegramConfig, int(bot_id))
    if not cfg:
        cfg = TelegramConfig.query.filter_by(is_default=True).first() or TelegramConfig.query.order_by(TelegramConfig.id.asc()).first()
    if not cfg:
        cfg = TelegramConfig(name="默认机器人", is_default=True)
        db.session.add(cfg)
        db.session.commit()
    return cfg


def _all_configs():
    return TelegramConfig.query.order_by(TelegramConfig.is_default.desc(), TelegramConfig.id.asc()).all()


def send_message(text: str, token: str = None, chat_id: str = None,
                 parse_mode: str = "HTML", bot_id: int | None = None) -> dict:
    cfg     = _get_config(bot_id)
    token   = token   or cfg.bot_token
    chat_id = chat_id or cfg.chat_id
    if not token or not chat_id:
        return {"ok": False, "error": "Bot Token 或 Chat ID 未配置"}
    try:
        url  = TG_API.format(token=token, method="sendMessage")
        resp = requests.post(url, json={
            "chat_id": chat_id,
            "text":    text,
            "parse_mode": parse_mode,
        }, timeout=8)
        data = resp.json()
        if data.get("ok"):
            try:
                record_ops_event("telegram_send_ok", "Telegram 发送成功", message="message delivered", payload={"chat_id": chat_id, "message_id": (data.get("result") or {}).get("message_id")})
                db.session.commit()
            except Exception:
                db.session.rollback()
            return data

        desc = (data.get("description") or "").lower()
        if resp.status_code == 401 or "unauthorized" in desc:
            return {"ok": False, "error_type": "TG_TOKEN_INVALID", "error": "token非法", "detail": data}
        if "chat not found" in desc:
            return {"ok": False, "error_type": "TG_CHAT_INVALID", "error": "chat id 非法", "detail": data}
        try:
            record_ops_event("telegram_send_failed", "Telegram 发送失败", message=data.get("description") or "telegram接口异常", level="error", payload={"detail": data, "chat_id": chat_id})
            db.session.commit()
        except Exception:
            db.session.rollback()
        return {"ok": False, "error_type": "TG_API_ERROR", "error": data.get("description") or "telegram接口异常", "detail": data}
    except requests.exceptions.Timeout:
        try:
            record_ops_event("telegram_send_failed", "Telegram 发送超时", message="telegram 接口超时", level="error", payload={"chat_id": chat_id})
            db.session.commit()
        except Exception:
            db.session.rollback()
        return {"ok": False, "error_type": "TG_TIMEOUT", "error": "telegram 接口超时"}
    except requests.exceptions.ConnectionError:
        try:
            record_ops_event("telegram_send_failed", "Telegram 网络异常", message="网络异常", level="error", payload={"chat_id": chat_id})
            db.session.commit()
        except Exception:
            db.session.rollback()
        return {"ok": False, "error_type": "NETWORK_ERROR", "error": "网络异常"}
    except Exception as e:
        return {"ok": False, "error_type": "UNKNOWN_ERROR", "error": str(e)}




def _parse_bool(value, default=True):
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() not in {"0", "false", "off", "no", ""}


def _valid_chat_id(value: str) -> bool:
    if not value:
        return True
    import re
    return bool(re.match(r"^(-\d{5,20}|@[A-Za-z0-9_]{5,32})$", value))


def _clean_alert_rule_payload(data: dict, existing: AlertRule | None = None) -> dict:
    data = data or {}
    rule_type = str(data.get("rule_type") or (existing.rule_type if existing else "")).strip().lower()
    if rule_type not in ALERT_RULE_TYPES:
        raise ValueError("不支持的规则类型")

    server_id = data.get("server_id", existing.server_id if existing else None)
    server_id = int(server_id) if str(server_id).strip() not in {"", "None", "null"} else None
    threshold_default = 1 if rule_type in {"offline", "consecutive_failures"} else 7 if rule_type == "expiry" else 200 if rule_type == "latency" else 1024 if rule_type == "bandwidth" else 90
    threshold = float(data.get("threshold", existing.threshold if existing else threshold_default) or threshold_default)
    if rule_type == "offline":
        threshold = max(1.0, threshold)
    if rule_type == "consecutive_failures":
        threshold = max(1.0, threshold)
    if rule_type == "expiry":
        threshold = max(0.0, threshold)
    if rule_type == "latency":
        threshold = max(1.0, threshold)
    if rule_type == "bandwidth":
        threshold = max(0.0, threshold)

    bot_raw = data.get("bot_id", existing.bot_id if existing else None)
    bot_id = int(bot_raw) if str(bot_raw or '').strip() not in {"", "None", "null"} else None
    if bot_id and not db.session.get(TelegramConfig, bot_id):
        raise ValueError("机器人配置不存在")
    target_chat_id = str(data.get("target_chat_id") or (existing.target_chat_id if existing else "") or "").strip()
    if target_chat_id and not target_chat_id.startswith("notify:") and not _valid_chat_id(target_chat_id):
        raise ValueError("目标 Chat ID 格式不正确")

    clean = {
        "server_id": server_id,
        "name": str(data.get("name") or (existing.name if existing else "") or "").strip(),
        "rule_type": rule_type,
        "threshold": threshold,
        "enabled": _parse_bool(data.get("enabled", existing.enabled if existing else True), True),
        "cool_down_s": max(0, int(data.get("cool_down_s", existing.cool_down_s if existing else 300) or 0)),
        "notify_repeat": _parse_bool(data.get("notify_repeat", existing.notify_repeat if existing else True), True),
        "target_chat_id": target_chat_id,
        "bot_id": bot_id,
        "note": str(data.get("note") or (existing.note if existing else "") or "").strip(),
    }
    if not clean["name"]:
        scope_label = "节点级" if clean["server_id"] else "全局"
        clean["name"] = f"{scope_label}-{rule_type}"
    return clean

def _full_msg(prefix: str, body: str) -> str:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"{prefix}\n\n{body}\n\n⏱ {ts}"


# ── 路由 ─────────────────────────────────────────────────────────────────────

@telegram_bp.get("/config")
@viewer_or_admin_required
def get_config():
    cfg = _get_config()
    return jsonify(config=cfg.to_dict(), bots=[c.to_dict() for c in _all_configs()])


@telegram_bp.post("/config")
@admin_required
def save_config():
    data = request.get_json(silent=True) or {}
    bot_id = data.get("id") or data.get("bot_id")
    cfg  = _get_config(int(bot_id)) if bot_id else TelegramConfig()
    if not bot_id:
        db.session.add(cfg)

    token = (data.get("bot_token") or "").strip() if "bot_token" in data else None
    chat_id = (data.get("chat_id") or "").strip() if "chat_id" in data else None

    if token is not None and not token:
        return jsonify(msg="Bot Token 不能为空"), 400
    if chat_id is not None and not chat_id:
        return jsonify(msg="Chat ID 不能为空"), 400

    if "name" in data:
        cfg.name = str(data.get("name") or "").strip() or f"机器人 {cfg.id or ''}".strip()
    if token:
        cfg.bot_token = token
    if chat_id is not None:
        cfg.chat_id = chat_id
    if "prefix" in data:
        cfg.prefix = data["prefix"].strip() or "【VPS星图】"
    if "enabled" in data:
        cfg.enabled = bool(data["enabled"])
    if data.get("is_default"):
        TelegramConfig.query.update({TelegramConfig.is_default: False})
        cfg.is_default = True

    db.session.commit()
    if not TelegramConfig.query.filter_by(is_default=True).first():
        cfg.is_default = True
        db.session.commit()
    return jsonify(msg="配置已保存", config=cfg.to_dict(), bots=[c.to_dict() for c in _all_configs()])


@telegram_bp.post("/test")
@admin_required
@limiter.limit("3 per minute")
def test_send():
    data = request.get_json(silent=True) or {}
    cfg     = _get_config(data.get("bot_id"))
    online  = Server.query.filter_by(status="online").count()
    total   = Server.query.count()
    body    = (f"🔔 <b>测试推送成功</b>\n"
               f"当前监控 <b>{total}</b> 台服务器\n"
               f"在线: <b>{online}</b> 台\n"
               f"离线: <b>{total - online}</b> 台")
    result  = send_message(_full_msg(cfg.prefix, body), bot_id=cfg.id)
    if result.get("ok"):
        return jsonify(msg="测试消息已发送")
    return jsonify(msg="发送失败", error_type=result.get("error_type"), detail=result), 502


@telegram_bp.post("/send")
@admin_required
def manual_send():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify(msg="消息内容不能为空"), 400
    cfg    = _get_config(data.get("bot_id"))
    result = send_message(_full_msg(cfg.prefix, text), bot_id=cfg.id)
    if result.get("ok"):
        return jsonify(msg="消息已发送")
    return jsonify(msg="发送失败", error_type=result.get("error_type"), detail=result), 502


def _serialize_rule_public(rule):
    return {
        "id": rule.id,
        "name": rule.name or rule.rule_type,
        "rule_type": rule.rule_type,
        "threshold": rule.threshold,
        "enabled": bool(rule.enabled),
        "cool_down_s": int(rule.cool_down_s or 0),
        "bot_id": rule.bot_id,
        "notify_repeat": bool(getattr(rule, "notify_repeat", True)),
        "scope": "server" if rule.server_id else "global",
        "server_id": rule.server_id,
        "note": rule.note or "",
    }


# ── 告警规则 ──────────────────────────────────────────────────────────────────

@telegram_bp.get("/alerts")
@viewer_or_admin_required
def list_alerts():
    rules = AlertRule.query.order_by(AlertRule.server_id.isnot(None).asc(), AlertRule.server_id.asc(), AlertRule.id.desc()).all()
    return jsonify(rules=[r.to_dict() for r in rules], rule_types=sorted(ALERT_RULE_TYPES), bots=[c.to_dict() for c in _all_configs()])


@telegram_bp.get("/alerts/public/<int:server_id>")
def public_server_alerts(server_id: int):
    server = db.session.get(Server, server_id)
    if not server:
        return jsonify(ok=False, msg="server not found"), 404
    rules = AlertRule.query.filter(
        AlertRule.enabled == True,
        or_(AlertRule.server_id == server_id, AlertRule.server_id.is_(None)),
    ).order_by(AlertRule.server_id.is_(None).asc(), AlertRule.id.desc()).all()
    return jsonify(
        ok=True,
        server={"id": server.id, "name": server.name, "status": server.status},
        rules=[_serialize_rule_public(r) for r in rules],
    )


@telegram_bp.get("/export")
@admin_required
def export_telegram_bundle():
    cfg = _get_config()
    rules = AlertRule.query.order_by(AlertRule.created_at.desc()).all()
    payload = {
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "config": cfg.to_dict(),
        "bots": [c.to_dict() for c in _all_configs()],
        "rules": [
            {
                **r.to_dict(),
                "last_fired": r.last_fired.isoformat() if r.last_fired else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rules
        ],
    }
    filename = f"telegram-export-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    response = current_app.response_class(
        response=json.dumps(payload, ensure_ascii=False, indent=2),
        status=200,
        mimetype="application/json",
    )
    response.headers["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


@telegram_bp.post("/alerts")
@admin_required
def save_alerts():
    """
    Body: { rules: [...] }
    兼容旧前端：全量替换全局规则；若 rule 含 server_id 则一并替换对应节点规则。
    """
    data = request.get_json(silent=True) or {}
    rules = data.get("rules", []) or []
    seen_server_ids = {int(r.get("server_id")) for r in rules if str(r.get("server_id") or '').strip() not in {'', 'None', 'null'}}
    AlertRule.query.filter_by(server_id=None).delete()
    if seen_server_ids:
        AlertRule.query.filter(AlertRule.server_id.in_(seen_server_ids)).delete(synchronize_session=False)
    try:
        for r in rules:
            clean = _clean_alert_rule_payload(r)
            db.session.add(AlertRule(**clean))
        db.session.commit()
        return jsonify(msg="告警规则已保存", rules=[r.to_dict() for r in AlertRule.query.order_by(AlertRule.id.desc()).all()])
    except ValueError as e:
        db.session.rollback()
        return jsonify(msg=str(e)), 400


@telegram_bp.post("/alerts/rule")
@admin_required
def create_alert_rule():
    try:
        clean = _clean_alert_rule_payload(request.get_json(silent=True) or {})
        rule = AlertRule(**clean)
        db.session.add(rule)
        db.session.commit()
        return jsonify(msg="规则已创建", rule=rule.to_dict())
    except ValueError as e:
        db.session.rollback()
        return jsonify(msg=str(e)), 400


@telegram_bp.put("/alerts/<int:rule_id>")
@admin_required
def update_alert_rule(rule_id: int):
    rule = db.session.get(AlertRule, rule_id)
    if not rule:
        return jsonify(msg="规则不存在"), 404
    try:
        clean = _clean_alert_rule_payload(request.get_json(silent=True) or {}, existing=rule)
        for k, v in clean.items():
            setattr(rule, k, v)
        db.session.commit()
        return jsonify(msg="规则已更新", rule=rule.to_dict())
    except ValueError as e:
        db.session.rollback()
        return jsonify(msg=str(e)), 400


@telegram_bp.post("/alerts/<int:rule_id>/toggle")
@admin_required
def toggle_alert_rule(rule_id: int):
    rule = db.session.get(AlertRule, rule_id)
    if not rule:
        return jsonify(msg="规则不存在"), 404
    enabled = _parse_bool((request.get_json(silent=True) or {}).get("enabled"), not rule.enabled)
    rule.enabled = enabled
    db.session.commit()
    return jsonify(msg="规则状态已更新", rule=rule.to_dict())


@telegram_bp.delete("/alerts/<int:rule_id>")
@admin_required
def delete_alert_rule(rule_id: int):
    rule = db.session.get(AlertRule, rule_id)
    if not rule:
        return jsonify(msg="规则不存在"), 404
    db.session.delete(rule)
    db.session.commit()
    return jsonify(msg="规则已删除")


@telegram_bp.post("/alert/fire")
@admin_required
def fire_alert():
    """
    由探针服务调用，触发告警消息
    Body: { server_id, rule_type, current_value, threshold }
    ---
    tags:
      - Webhook
      - Telegram
    summary: 触发 Telegram 告警推送
    description: 可由内部任务/探针服务调用，按规则推送告警消息到 Telegram。
    security:
      - Bearer: []
    consumes:
      - application/json
    parameters:
      - in: body
        name: body
        required: true
        schema:
          type: object
          required: [server_id, rule_type]
          properties:
            server_id:
              type: integer
              example: 12
            rule_type:
              type: string
              enum: [cpu, ram, disk, bandwidth, offline, expiry, latency, consecutive_failures]
            current_value:
              type: number
              example: 96.2
            threshold:
              type: number
              example: 90
        examples:
          application/json:
            server_id: 12
            rule_type: cpu
            current_value: 96.2
            threshold: 90
    responses:
      200:
        description: 告警已推送或 Telegram 未启用
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 告警已推送
      403:
        description: 权限不足（仅管理员可触发）
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 权限不足
      502:
        description: 推送失败
        schema:
          type: object
          properties:
            msg:
              type: string
              example: 推送失败
            detail:
              type: object
      500:
        description: 服务内部错误（例如参数缺失导致模板拼接失败）
    """
    data      = request.get_json(silent=True) or {}
    sid       = data.get("server_id")
    rule_type = data.get("rule_type", "")
    cur_val   = data.get("current_value")
    threshold = data.get("threshold")

    s   = db.session.get(Server, sid) if sid is not None else None

    icons = {"cpu": "🔥", "ram": "💾", "disk": "💿", "bandwidth": "📶", "offline": "🔴", "expiry": "📅", "latency": "📡", "consecutive_failures": "🚨"}
    icon  = icons.get(rule_type, "⚠️")
    name  = s.name if s else f"Server #{sid}"

    if rule_type == "offline":
        body = f"{icon} <b>{name}</b> 已离线！\n位置: {s.location if s else '-'}"
    elif rule_type == "expiry":
        body = f"{icon} <b>{name}</b> 即将到期\n到期日: {s.expiry}"
    else:
        label = {"cpu": "CPU", "ram": "内存", "disk": "磁盘"}.get(rule_type, rule_type)
        body  = (f"{icon} <b>{name}</b> {label} 告警\n"
                 f"当前值: <b>{cur_val:.1f}%</b> 超过阈值 {threshold}%\n"
                 f"位置: {s.location if s else '-'}")

    rule = AlertRule.query.filter_by(server_id=sid, rule_type=rule_type).first()
    if not rule:
        rule = AlertRule.query.filter_by(server_id=None, rule_type=rule_type).first()
    send_cfg = _get_config(rule.bot_id if rule and rule.bot_id else None)
    if not send_cfg.enabled or not send_cfg.bot_token:
        return jsonify(msg="Telegram 未启用"), 200
    result = send_message(_full_msg(send_cfg.prefix, body), chat_id=(rule.target_chat_id if rule and rule.target_chat_id else None), bot_id=send_cfg.id)
    if result.get("ok"):
        record_ops_event(
            "alert_rule_fired",
            f"规则命中 · {(rule.name if rule and rule.name else rule_type)}",
            message=body.split("\n")[0],
            server_id=s.id if s else sid,
            rule_id=rule.id if rule else None,
            payload={"rule_type": rule_type, "scope": ('server' if rule and rule.server_id else ('global' if rule else 'adhoc'))},
        )
        # 更新 last_fired
        if rule:
            rule.last_fired = datetime.now(timezone.utc)
        db.session.commit()
        return jsonify(msg="告警已推送")
    return jsonify(msg="推送失败", error_type=result.get("error_type"), detail=result), 502
