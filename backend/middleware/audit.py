# backend/middleware/audit.py - 审计中间件

"""
审计中间件 - 记录所有重要操作
"""
import json
import logging
from datetime import datetime, timezone

from flask import current_app, g, request

from extensions import db
from models.audit_log import AuditLog

logger = logging.getLogger(__name__)

# Default maximum serialized size (bytes) for the new_values JSON field.
# Can be overridden via AUDIT_NEW_VALUES_MAX_BYTES in app config.
_DEFAULT_MAX_BYTES = 16384


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
        """构建审计详情（请求参数 + 审计元数据），并进行体积控制。

        处理顺序：先脱敏，后截断，确保敏感字段不会因截断而泄漏原文。
        当序列化后体积超过 AUDIT_NEW_VALUES_MAX_BYTES 时，执行截断并附加
        _truncation_meta 元信息字段。
        """
        body = self._safe_json_payload()
        metadata = {
            'query': {k: request.args.get(k) for k in request.args.keys()},
            'request_id': getattr(g, 'request_id', None),
            'role': role,
            'is_admin_action': role == 'admin',
        }

        if body is None and not metadata['query']:
            payload = metadata
        else:
            payload = {
                'payload': body,
                'metadata': metadata,
            }

        return self._enforce_size_limit(payload)

    def _enforce_size_limit(self, payload: dict) -> dict:
        """确保 payload 序列化后不超过配置上限。

        超限时执行字段级截断策略：
        1. 对超长字符串值截断至合理长度；
        2. 对超长数组只保留前 N 项；
        3. 若仍超限，移除非关键顶层字段，直至满足约束；
        4. 最终附加 _truncation_meta 元信息。
        """
        try:
            max_bytes = int(
                current_app.config.get('AUDIT_NEW_VALUES_MAX_BYTES', _DEFAULT_MAX_BYTES)
            )
        except Exception as exc:
            logger.warning("⚠️ AUDIT_NEW_VALUES_MAX_BYTES 配置读取失败，使用默认值 %d: %s", _DEFAULT_MAX_BYTES, exc)
            max_bytes = _DEFAULT_MAX_BYTES

        # Truncation disabled
        if max_bytes <= 0:
            return payload

        serialized = json.dumps(payload, ensure_ascii=False, default=str)
        original_size = len(serialized.encode('utf-8'))

        if original_size <= max_bytes:
            return payload

        # --- truncation needed ---
        truncated_payload = self._truncate_payload(payload, max_bytes)
        stored_serialized = json.dumps(truncated_payload, ensure_ascii=False, default=str)
        stored_size = len(stored_serialized.encode('utf-8'))

        truncated_payload['_truncation_meta'] = {
            'truncated': True,
            'original_size_bytes': original_size,
            'stored_size_bytes': stored_size,
        }
        return truncated_payload

    def _truncate_payload(self, payload: dict, max_bytes: int) -> dict:
        """对 payload 执行字段级截断，尽力满足 max_bytes 约束。"""
        # Work on a shallow copy so we don't mutate the original
        result = dict(payload)

        # Phase 1: trim individual string values and arrays inside 'payload' key
        if 'payload' in result and isinstance(result['payload'], dict):
            result['payload'] = self._trim_values(result['payload'], str_limit=256, arr_limit=20)
        elif 'payload' in result and isinstance(result['payload'], list):
            result['payload'] = result['payload'][:20]

        # Phase 2: if still too large, drop the 'payload' body entirely
        if self._serialized_bytes(result) > max_bytes:
            result.pop('payload', None)

        # Phase 3: if still too large, drop query params from metadata
        if self._serialized_bytes(result) > max_bytes:
            if 'metadata' in result and isinstance(result.get('metadata'), dict):
                trimmed_meta = dict(result['metadata'])
                trimmed_meta.pop('query', None)
                result['metadata'] = trimmed_meta

        return result

    @staticmethod
    def _trim_values(obj, str_limit: int, arr_limit: int):
        """Recursively trim string lengths and array sizes within obj."""
        if isinstance(obj, dict):
            return {k: AuditMiddleware._trim_values(v, str_limit, arr_limit) for k, v in obj.items()}
        if isinstance(obj, list):
            return [AuditMiddleware._trim_values(item, str_limit, arr_limit) for item in obj[:arr_limit]]
        if isinstance(obj, str) and len(obj) > str_limit:
            return obj[:str_limit]
        return obj

    @staticmethod
    def _serialized_bytes(obj) -> int:
        try:
            return len(json.dumps(obj, ensure_ascii=False, default=str).encode('utf-8'))
        except Exception as exc:
            logger.warning("⚠️ audit payload 序列化大小计算失败: %s", exc)
            return 0

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
