"""
backend/services/email_service.py
邮件发送服务

支持两种发送模式：
  SMTP_MODE=smtp  —— 生产环境，通过 SMTP_HOST 发送真实邮件
  SMTP_MODE=log   —— 开发/测试环境，将邮件内容打印到日志（默认）

环境变量（在 .env 或 docker-compose environment 中配置）：
  SMTP_MODE        smtp | log          默认 log
  SMTP_HOST        smtp.example.com    SMTP 服务器地址
  SMTP_PORT        465                 SSL 端口，或用 587 + STARTTLS
  SMTP_USE_TLS     true | false        是否使用 SSL（端口 465 时设 true）
  SMTP_USER        noreply@example.com 发件人账号
  SMTP_PASSWORD    xxxxxxxx            发件人密码
  SMTP_FROM        VPS星图 <noreply@example.com>  发件人显示名
  FRONTEND_URL     https://example.com            用于拼接邮件中的链接
"""

import logging
import os
import smtplib
import ssl
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from typing import Optional

logger = logging.getLogger(__name__)


# ── 配置读取 ──────────────────────────────────────────────────────────────────

def _env(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


class _EmailConfig:
    mode         = _env("SMTP_MODE", "log")       # "smtp" | "log"
    host         = _env("SMTP_HOST", "localhost")
    port         = int(_env("SMTP_PORT", "465"))
    use_tls      = _env("SMTP_USE_TLS", "true").lower() == "true"
    user         = _env("SMTP_USER", "")
    password     = _env("SMTP_PASSWORD", "")
    from_addr    = _env("SMTP_FROM", f"VPS星图 <{_env('SMTP_USER')}>")
    frontend_url = _env("FRONTEND_URL", "http://localhost:5173")


cfg = _EmailConfig()


# ── 核心发送函数 ──────────────────────────────────────────────────────────────

def _build_message(to: str, subject: str, html_body: str, text_body: str) -> MIMEMultipart:
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = cfg.from_addr
    msg["To"]      = to
    msg.attach(MIMEText(text_body, "plain", "utf-8"))
    msg.attach(MIMEText(html_body, "html",  "utf-8"))
    return msg


def _send(to: str, subject: str, html_body: str, text_body: str) -> bool:
    """底层发送，根据 SMTP_MODE 选择真实发送或日志输出"""
    if cfg.mode != "smtp":
        # 开发/测试模式：打印到日志，不发送真实邮件
        logger.info(
            f"\n{'='*60}\n"
            f"[EMAIL LOG MODE]\n"
            f"To:      {to}\n"
            f"Subject: {subject}\n"
            f"Body:\n{text_body}\n"
            f"{'='*60}"
        )
        return True

    try:
        msg = _build_message(to, subject, html_body, text_body)
        if cfg.use_tls:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(cfg.host, cfg.port, context=context, timeout=10) as server:
                server.login(cfg.user, cfg.password)
                server.sendmail(cfg.user, to, msg.as_string())
        else:
            with smtplib.SMTP(cfg.host, cfg.port, timeout=10) as server:
                server.ehlo()
                server.starttls()
                server.login(cfg.user, cfg.password)
                server.sendmail(cfg.user, to, msg.as_string())
        logger.info(f"✅ 邮件已发送: {to} — {subject}")
        return True
    except smtplib.SMTPAuthenticationError:
        logger.error("❌ SMTP 认证失败，请检查 SMTP_USER / SMTP_PASSWORD")
    except smtplib.SMTPConnectError:
        logger.error(f"❌ SMTP 连接失败: {cfg.host}:{cfg.port}")
    except Exception as e:
        logger.error(f"❌ 邮件发送异常: {e}")
    return False


# ── 业务邮件模板 ──────────────────────────────────────────────────────────────

_BASE_HTML = """\
<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<style>
  body {{ font-family: 'Noto Sans SC', Arial, sans-serif; background:#f5f5f5; margin:0; padding:0; }}
  .wrap {{ max-width:560px; margin:40px auto; background:#fff; border-radius:12px;
           box-shadow:0 2px 12px rgba(0,0,0,.08); overflow:hidden; }}
  .header {{ background:#070b14; padding:28px 32px; }}
  .header h1 {{ margin:0; color:#63b3ed; font-size:20px; letter-spacing:2px; }}
  .body {{ padding:32px; color:#333; line-height:1.7; }}
  .btn {{ display:inline-block; margin:20px 0; padding:12px 28px;
          background:#63b3ed; color:#fff; text-decoration:none;
          border-radius:8px; font-weight:bold; font-size:15px; }}
  .note {{ font-size:12px; color:#888; margin-top:16px; }}
  .footer {{ background:#f9f9f9; padding:16px 32px; font-size:12px; color:#aaa;
             border-top:1px solid #eee; }}
</style>
</head>
<body>
<div class="wrap">
  <div class="header"><h1>VPS · 星图</h1></div>
  <div class="body">{body}</div>
  <div class="footer">此邮件由系统自动发送，请勿直接回复。</div>
</div>
</body>
</html>"""


def send_verification_email(to: str, username: str, token: str) -> bool:
    """发送邮箱验证邮件（注册激活）"""
    verify_url = f"{cfg.frontend_url}/verify-email?token={token}"

    html_body_inner = f"""\
<p>您好，<b>{username}</b>！</p>
<p>感谢注册 <b>VPS 星图</b>。请点击下方按钮验证您的邮箱地址：</p>
<a class="btn" href="{verify_url}">✉ 验证邮箱</a>
<p class="note">链接有效期 <b>24 小时</b>。若非您本人操作，请忽略此邮件。</p>
<p class="note">如按钮无法点击，请复制以下链接到浏览器：<br>{verify_url}</p>"""

    html_body  = _BASE_HTML.format(body=html_body_inner)
    text_body  = (
        f"您好，{username}！\n\n"
        f"请访问以下链接验证您的邮箱（24 小时内有效）：\n{verify_url}\n\n"
        "若非您本人操作，请忽略此邮件。"
    )

    return _send(to, "【VPS星图】请验证您的邮箱", html_body, text_body)


def send_password_reset_email(to: str, username: str, token: str) -> bool:
    """发送密码重置邮件"""
    reset_url = f"{cfg.frontend_url}/reset-password?token={token}"

    html_body_inner = f"""\
<p>您好，<b>{username}</b>！</p>
<p>我们收到了重置您 <b>VPS 星图</b> 账户密码的请求。点击下方按钮设置新密码：</p>
<a class="btn" href="{reset_url}">🔑 重置密码</a>
<p class="note">链接有效期 <b>1 小时</b>，使用后立即失效。若非您本人操作，您的账户依然安全，无需处理。</p>
<p class="note">如按钮无法点击，请复制以下链接到浏览器：<br>{reset_url}</p>"""

    html_body  = _BASE_HTML.format(body=html_body_inner)
    text_body  = (
        f"您好，{username}！\n\n"
        f"请访问以下链接重置密码（1 小时内有效，使用后即失效）：\n{reset_url}\n\n"
        "若非您本人操作，请忽略此邮件，您的账户依然安全。"
    )

    return _send(to, "【VPS星图】密码重置请求", html_body, text_body)


def send_welcome_email(to: str, username: str) -> bool:
    """发送注册欢迎邮件（邮箱验证通过后调用）"""
    dashboard_url = cfg.frontend_url

    html_body_inner = f"""\
<p>您好，<b>{username}</b>！</p>
<p>🎉 您的邮箱已成功验证，欢迎加入 <b>VPS 星图</b>！</p>
<a class="btn" href="{dashboard_url}">🚀 进入控制台</a>
<p class="note">如有任何问题，请联系管理员。</p>"""

    html_body  = _BASE_HTML.format(body=html_body_inner)
    text_body  = (
        f"您好，{username}！\n\n"
        f"🎉 您的邮箱已成功验证，欢迎使用 VPS 星图！\n\n"
        f"访问控制台：{dashboard_url}"
    )

    return _send(to, "【VPS星图】欢迎加入！", html_body, text_body)
