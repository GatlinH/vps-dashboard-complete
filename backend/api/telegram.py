"""
/api/telegram  —  Bot 配置 / 发消息 / 告警规则 / Webhook 处理
"""
import json
import requests
from datetime import datetime, timezone
from flask import Blueprint, request, jsonify, current_app
from flask_jwt_extended import jwt_required, get_jwt
from extensions import db
from models.models import TelegramConfig, AlertRule, Server
from middleware.rbac import admin_required

telegram_bp = Blueprint("telegram", __name__)

TG_API = "https://api.telegram.org/bot{token}/{method}"


# ── 工具 ─────────────────────────────────────────────────────────────────────

def _get_config() -> TelegramConfig:
    cfg = TelegramConfig.query.first()
    if not cfg:
        cfg = TelegramConfig()
        db.session.add(cfg)
        db.session.commit()
    return cfg


def send_message(text: str, token: str = None, chat_id: str = None,
                 parse_mode: str = "HTML") -> dict:
    cfg     = _get_config()
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
        return resp.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def _full_msg(prefix: str, body: str) -> str:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    return f"{prefix}\n\n{body}\n\n⏱ {ts}"


# ── 路由 ─────────────────────────────────────────────────────────────────────

@telegram_bp.get("/config")
@jwt_required()
def get_config():
    return jsonify(config=_get_config().to_dict())


@telegram_bp.post("/config")
@jwt_required()
def save_config():
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    data = request.get_json(silent=True) or {}
    cfg  = _get_config()

    if "bot_token" in data and data["bot_token"]:
        cfg.bot_token = data["bot_token"].strip()
    if "chat_id" in data:
        cfg.chat_id = data["chat_id"].strip()
    if "prefix" in data:
        cfg.prefix = data["prefix"].strip() or "【VPS星图】"
    if "enabled" in data:
        cfg.enabled = bool(data["enabled"])

    db.session.commit()
    return jsonify(msg="配置已保存", config=cfg.to_dict())


@telegram_bp.post("/test")
@admin_required
def test_send():
    cfg     = _get_config()
    online  = Server.query.filter_by(status="online").count()
    total   = Server.query.count()
    body    = (f"🔔 <b>测试推送成功</b>\n"
               f"当前监控 <b>{total}</b> 台服务器\n"
               f"在线: <b>{online}</b> 台\n"
               f"离线: <b>{total - online}</b> 台")
    result  = send_message(_full_msg(cfg.prefix, body))
    if result.get("ok"):
        return jsonify(msg="测试消息已发送")
    return jsonify(msg="发送失败", detail=result), 502


@telegram_bp.post("/send")
@admin_required
def manual_send():
    data = request.get_json(silent=True) or {}
    text = data.get("text", "").strip()
    if not text:
        return jsonify(msg="消息内容不能为空"), 400
    cfg    = _get_config()
    result = send_message(_full_msg(cfg.prefix, text))
    if result.get("ok"):
        return jsonify(msg="消息已发送")
    return jsonify(msg="发送失败", detail=result), 502


# ── 告警规则 ──────────────────────────────────────────────────────────────────

@telegram_bp.get("/alerts")
@admin_required
def list_alerts():
    rules = AlertRule.query.all()
    return jsonify(rules=[r.to_dict() for r in rules])


@telegram_bp.post("/alerts")
@jwt_required()
def save_alerts():
    """
    Body: { rules: [{ rule_type, threshold, enabled, server_id? }, ...] }
    全量替换全局告警规则
    """
    claims = get_jwt()
    if claims.get("role") != "admin":
        return jsonify(msg="权限不足"), 403

    data  = request.get_json(silent=True) or {}
    rules = data.get("rules", [])

    # 删除旧全局规则（server_id IS NULL）
    AlertRule.query.filter_by(server_id=None).delete()

    for r in rules:
        db.session.add(AlertRule(
            server_id  = r.get("server_id"),
            rule_type  = r["rule_type"],
            threshold  = float(r.get("threshold", 90)),
            enabled    = bool(r.get("enabled", True)),
            cool_down_s= int(r.get("cool_down_s", 300)),
        ))

    db.session.commit()
    return jsonify(msg="告警规则已保存")


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
              enum: [cpu, ram, disk, offline, expiry]
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

    s   = Server.query.get(sid)
    cfg = _get_config()
    if not cfg.enabled or not cfg.bot_token:
        return jsonify(msg="Telegram 未启用"), 200

    icons = {"cpu": "🔥", "ram": "💾", "disk": "💿", "offline": "🔴", "expiry": "📅"}
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

    result = send_message(_full_msg(cfg.prefix, body))
    if result.get("ok"):
        # 更新 last_fired
        rule = AlertRule.query.filter_by(server_id=sid, rule_type=rule_type).first()
        if rule:
            rule.last_fired = datetime.now(timezone.utc)
            db.session.commit()
        return jsonify(msg="告警已推送")
    return jsonify(msg="推送失败", detail=result), 502
