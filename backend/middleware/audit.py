# backend/middleware/audit.py - 审计中间件

"""
审计中间件 - 记录所有重要操作
"""
import logging
from datetime import datetime, timezone

from flask import g, request

from extensions import db
from models.audit_log import AuditLog

logger = logging.getLogger(__name__)


class AuditMiddleware:
    """审计中间件"""

    # 需要审计的操作
    AUDITED_METHODS = {'POST', 'PUT', 'DELETE', 'PATCH'}

    # 忽略的端点
    IGNORED_PATHS = {
        '/health',
        '/metrics',
    }

    # 常见敏感字段（写入审计日志前会脱敏）
    SENSITIVE_KEYS = {
        'password', 'password_hash', 'token', 'access_token', 'refresh_token',
        'secret', 'secret_key', 'jwt', 'authorization', 'cookie', 'bot_token',
    }

    def __init__(self, app=None):
        self.app = app
        if app:
            self.init_app(app)

    def init_app(self, app):
        """初始化中间件"""

        @app.before_request
        def before_request():
            """记录请求开始时间"""
            g.start_time = datetime.now(timezone.utc)
            g.request_id = request.headers.get('X-Request-ID', f"{datetime.now(timezone.utc).timestamp()}")

        @app.after_request
        def after_request(response):
            """记录审计日志"""
            try:
                # 检查是否需要审计
                if not self._should_audit():
                    return response

                # 提取用户信息
                user_id, username, role = self._get_actor_info()

                # 构建审计记录
                audit_log = AuditLog(
                    user_id=int(user_id) if user_id else None,
                    username=username,
                    action=self._get_action(request.path, request.method, role),
                    resource_type=self._get_resource_type(request.path),
                    resource_id=self._get_resource_id(request),
                    method=request.method,
                    endpoint=request.path,
                    status_code=response.status_code,
                    success=response.status_code < 400,
                    error_message=self._extract_error_message(response),
                    old_values=None,
                    new_values=self._build_new_values_payload(role),
                    ip_address=self._get_client_ip(),
                    user_agent=request.user_agent.string[:255] if request.user_agent else None,
                    created_at=g.start_time,
                )

                db.session.add(audit_log)
                db.session.commit()

            except Exception as e:
                logger.warning(f"⚠️ 审计日志记录失败: {e}")
                db.session.rollback()

            return response

    def _should_audit(self) -> bool:
        """判断是否需要审计"""
        # 只审计修改操作
        if request.method not in self.AUDITED_METHODS:
            return False

        # 忽略特定路径
        if request.path in self.IGNORED_PATHS:
            return False

        return True

    def _get_actor_info(self):
        """获取操作人信息（user_id/username/role）"""
        try:
            from flask_jwt_extended import get_jwt, get_jwt_identity

            user_id = get_jwt_identity()
            claims = get_jwt() if user_id else {}
            username = claims.get('username') or ('anonymous' if not user_id else f'user_{user_id}')
            role = claims.get('role', 'user') if user_id else 'anonymous'
            return user_id, username, role
        except Exception:
            return None, 'anonymous', 'anonymous'

    def _get_action(self, path: str, method: str, role: str) -> str:
        """获取操作类型（覆盖用户修改/管理员操作/支付事件）"""
        method_action_map = {
            'POST': 'CREATE',
            'PUT': 'UPDATE',
            'PATCH': 'UPDATE',
            'DELETE': 'DELETE',
        }
        base_action = method_action_map.get(method, 'UNKNOWN')

        lowered = path.lower()
        if '/auth' in lowered:
            return f'USER_{base_action}'
        if '/users' in lowered:
            return f'USER_{base_action}'
        if any(keyword in lowered for keyword in ['/aff', '/payment', '/billing', '/order', '/invoice']):
            return f'PAYMENT_{base_action}'
        if role == 'admin':
            return f'ADMIN_{base_action}'
        return base_action

    def _get_resource_type(self, path: str) -> str:
        """获取资源类型"""
        lowered = path.lower()
        if '/servers' in lowered:
            return 'Server'
        if '/probe' in lowered:
            return 'Probe'
        if '/telegram' in lowered:
            return 'Telegram'
        if '/alerts' in lowered:
            return 'Alert'
        if '/auth' in lowered or '/users' in lowered:
            return 'User'
        if any(keyword in lowered for keyword in ['/aff', '/payment', '/billing', '/order', '/invoice']):
            return 'Payment'
        return 'Unknown'

    def _get_resource_id(self, request_obj) -> str:
        """获取资源 ID"""
        try:
            # 从 URL 路径提取 ID
            parts = request_obj.path.split('/')
            for part in parts:
                if part.isdigit():
                    return part

            # 从 JSON 请求体提取 ID
            data = request_obj.get_json(silent=True)
            if data and 'id' in data:
                return str(data['id'])

        except Exception:
            pass

        return 'unknown'

    def _get_client_ip(self) -> str:
        """获取客户端 IP（由 ProxyFix 中间件处理后的可信地址）"""
        # ProxyFix has already resolved X-Forwarded-For into request.remote_addr;
        # reading HTTP_X_FORWARDED_FOR directly would bypass that layer and risk
        # trusting untrusted proxy headers.
        return request.remote_addr or 'unknown'

    def _extract_error_message(self, response):
        """提取失败响应的错误信息"""
        if response.status_code < 400:
            return None
        try:
            payload = response.get_json(silent=True) or {}
            message = payload.get('message') or payload.get('error') or payload.get('detail')
            if message:
                return str(message)[:2048]
        except Exception:
            pass
        return f'HTTP {response.status_code}'

    def _build_new_values_payload(self, role: str):
        """构建审计详情（请求参数 + 审计元数据）"""
        body = self._safe_json_payload()
        metadata = {
            'query': {k: request.args.get(k) for k in request.args.keys()},
            'request_id': getattr(g, 'request_id', None),
            'role': role,
            'is_admin_action': role == 'admin',
        }

        if body is None and not metadata['query']:
            return metadata
        return {
            'payload': body,
            'metadata': metadata,
        }

    def _safe_json_payload(self):
        """读取并脱敏请求体"""
        data = request.get_json(silent=True)
        if data is None:
            return None
        return self._sanitize_value(data)

    def _sanitize_value(self, value):
        """递归脱敏 + 长度限制"""
        if isinstance(value, dict):
            result = {}
            for key, val in value.items():
                if str(key).lower() in self.SENSITIVE_KEYS:
                    result[key] = '***'
                else:
                    result[key] = self._sanitize_value(val)
            return result

        if isinstance(value, list):
            return [self._sanitize_value(item) for item in value[:100]]

        if isinstance(value, str):
            return value[:512]

        return value
