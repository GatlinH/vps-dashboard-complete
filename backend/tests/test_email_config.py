"""
test_email_config.py
P2 邮件服务配置统一验证

验证目标：
  1. 在 Flask app context 内，_get_cfg() 应从 app.config 读取配置
  2. 修改 app.config 后，_get_cfg() 的结果应立即反映变更（无模块导入缓存）
  3. 发信函数（send_*）使用 app.config 中的 FRONTEND_URL
  4. 默认模式为 log（即无真实 SMTP 连接）
  5. 在无 app context 时，回退到 os.environ（保持兼容性）
"""
import os
import pytest


# ── _get_cfg() 从 app.config 读取 ────────────────────────────────────────────

def test_get_cfg_reads_smtp_mode_from_app_config(app):
    """_get_cfg() 应读取 app.config['SMTP_MODE'] 而非 os.environ。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_MODE"] = "smtp"
        cfg = _get_cfg()
        assert cfg.mode == "smtp"

        app.config["SMTP_MODE"] = "log"
        cfg = _get_cfg()
        assert cfg.mode == "log"


def test_get_cfg_reads_smtp_host_from_app_config(app):
    """_get_cfg() 应读取 app.config['SMTP_HOST']。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_HOST"] = "mail.example.com"
        cfg = _get_cfg()
        assert cfg.host == "mail.example.com"


def test_get_cfg_reads_smtp_port_from_app_config(app):
    """_get_cfg() 应读取 app.config['SMTP_PORT'] 并转为 int。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_PORT"] = 587
        cfg = _get_cfg()
        assert cfg.port == 587


def test_get_cfg_reads_smtp_use_tls_from_app_config(app):
    """_get_cfg() 应读取 app.config['SMTP_USE_TLS'] 并转为 bool。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_USE_TLS"] = False
        cfg = _get_cfg()
        assert cfg.use_tls is False

        app.config["SMTP_USE_TLS"] = True
        cfg = _get_cfg()
        assert cfg.use_tls is True


def test_get_cfg_reads_smtp_credentials_from_app_config(app):
    """_get_cfg() 应读取 app.config 中的 SMTP_USER 和 SMTP_PASSWORD。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_USER"]     = "noreply@test.com"
        app.config["SMTP_PASSWORD"] = "s3cret"
        cfg = _get_cfg()
        assert cfg.user     == "noreply@test.com"
        assert cfg.password == "s3cret"


def test_get_cfg_reads_frontend_url_from_app_config(app):
    """_get_cfg() 应读取 app.config['FRONTEND_URL']。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["FRONTEND_URL"] = "https://dashboard.example.com"
        cfg = _get_cfg()
        assert cfg.frontend_url == "https://dashboard.example.com"


def test_get_cfg_smtp_from_fallback(app):
    """当 SMTP_FROM 未设置时，from_addr 应自动生成为 'VPS星图 <{user}>'。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_USER"] = "noreply@test.com"
        app.config["SMTP_FROM"] = ""
        cfg = _get_cfg()
        assert "noreply@test.com" in cfg.from_addr


def test_get_cfg_smtp_from_explicit(app):
    """当 SMTP_FROM 已设置时，from_addr 应使用该值。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["SMTP_FROM"] = "VPS Dashboard <noreply@example.com>"
        cfg = _get_cfg()
        assert cfg.from_addr == "VPS Dashboard <noreply@example.com>"


# ── 默认行为（log 模式） ──────────────────────────────────────────────────────

def test_default_mode_is_log(app):
    """默认 SMTP_MODE 应为 log（不发送真实邮件）。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config.pop("SMTP_MODE", None)
        app.config["SMTP_MODE"] = "log"
        cfg = _get_cfg()
        assert cfg.mode == "log"


def test_send_in_log_mode_returns_true_without_smtp(app):
    """log 模式下 _send() 应立即返回 True，不尝试 SMTP 连接。"""
    from services.email_service import _send

    with app.app_context():
        app.config["SMTP_MODE"] = "log"
        result = _send("user@example.com", "Test Subject", "<p>html</p>", "text")
        assert result is True


# ── 业务函数使用 app.config 中的 FRONTEND_URL ────────────────────────────────

def test_send_verification_email_uses_app_config_frontend_url(app, caplog):
    """send_verification_email 应在邮件中使用 app.config['FRONTEND_URL']。"""
    import logging
    from services.email_service import send_verification_email

    with app.app_context():
        app.config["SMTP_MODE"]    = "log"
        app.config["FRONTEND_URL"] = "https://custom.example.com"

        with caplog.at_level(logging.INFO, logger="services.email_service"):
            result = send_verification_email("user@example.com", "testuser", "tok123")

        assert result is True
        assert "custom.example.com" in caplog.text
        assert "verify-email" in caplog.text


def test_send_password_reset_email_uses_app_config_frontend_url(app, caplog):
    """send_password_reset_email 应在邮件中使用 app.config['FRONTEND_URL']。"""
    import logging
    from services.email_service import send_password_reset_email

    with app.app_context():
        app.config["SMTP_MODE"]    = "log"
        app.config["FRONTEND_URL"] = "https://custom.example.com"

        with caplog.at_level(logging.INFO, logger="services.email_service"):
            result = send_password_reset_email("user@example.com", "testuser", "tok456")

        assert result is True
        assert "custom.example.com" in caplog.text
        assert "reset-password" in caplog.text


def test_send_welcome_email_uses_app_config_frontend_url(app, caplog):
    """send_welcome_email 应在邮件中使用 app.config['FRONTEND_URL']。"""
    import logging
    from services.email_service import send_welcome_email

    with app.app_context():
        app.config["SMTP_MODE"]    = "log"
        app.config["FRONTEND_URL"] = "https://custom.example.com"

        with caplog.at_level(logging.INFO, logger="services.email_service"):
            result = send_welcome_email("user@example.com", "testuser")

        assert result is True
        assert "custom.example.com" in caplog.text


# ── app.config 动态注入生效（无模块级缓存） ──────────────────────────────────

def test_app_config_change_reflects_without_restart(app):
    """更改 app.config 后，下一次 _get_cfg() 调用应立即反映新值（无缓存）。"""
    from services.email_service import _get_cfg

    with app.app_context():
        app.config["FRONTEND_URL"] = "https://first.example.com"
        assert _get_cfg().frontend_url == "https://first.example.com"

        app.config["FRONTEND_URL"] = "https://second.example.com"
        assert _get_cfg().frontend_url == "https://second.example.com"


# ── 无 app context 时回退到 os.environ（兼容性） ─────────────────────────────

def test_get_cfg_falls_back_to_environ_outside_app_context(monkeypatch):
    """在无 Flask app context 时，_get_cfg() 应从 os.environ 读取配置。"""
    import flask
    import services.email_service as email_module

    # 模拟无 app context：令 current_app.config 抛出 RuntimeError
    class _NoContext:
        @property
        def config(self):
            raise RuntimeError("Working outside of application context.")

    monkeypatch.setattr(flask, "current_app", _NoContext())

    original = os.environ.get("SMTP_HOST")
    try:
        os.environ["SMTP_HOST"] = "environ-smtp.example.com"
        cfg = email_module._get_cfg()
        assert cfg.host == "environ-smtp.example.com"
    finally:
        if original is None:
            os.environ.pop("SMTP_HOST", None)
        else:
            os.environ["SMTP_HOST"] = original


def test_get_cfg_environ_default_mode_is_log():
    """无 app context 且未设置 SMTP_MODE 时，默认应为 log。"""
    from services.email_service import _get_cfg

    original = os.environ.pop("SMTP_MODE", None)
    try:
        cfg = _get_cfg()
        assert cfg.mode == "log"
    finally:
        if original is not None:
            os.environ["SMTP_MODE"] = original
