# backend/utils/errors.py - 完整错误处理

from functools import wraps
from flask import jsonify

class APIException(Exception):
    """API 异常基类"""
    def __init__(self, message, status_code=400, error_code=None, details=None):
        self.message = message
        self.status_code = status_code
        self.error_code = error_code or 'UNKNOWN_ERROR'
        self.details = details or {}
        super().__init__(self.message)

    def to_dict(self):
        return {
            'success': False,
            'message': self.message,
            'error_code': self.error_code,
            'details': self.details,
        }


class ValidationError(APIException):
    """数据验证错误"""
    def __init__(self, message, field=None, value=None):
        self.field = field
        self.value = value
        details = {}
        if field:
            details['field'] = field
        if value:
            details['value'] = str(value)
        super().__init__(message, 400, 'VALIDATION_ERROR', details)


class AuthenticationError(APIException):
    """认证错误"""
    def __init__(self, message="认证失败"):
        super().__init__(message, 401, 'AUTHENTICATION_ERROR')


class AuthorizationError(APIException):
    """授权错误"""
    def __init__(self, message="权限不足", required_role=None):
        details = {}
        if required_role:
            details['required_role'] = required_role
        super().__init__(message, 403, 'AUTHORIZATION_ERROR', details)


class ResourceNotFoundError(APIException):
    """资源不存在"""
    def __init__(self, resource_type, resource_id):
        message = f"{resource_type} #{resource_id} 不存在"
        details = {
            'resource_type': resource_type,
            'resource_id': str(resource_id),
        }
        super().__init__(message, 404, 'RESOURCE_NOT_FOUND', details)


class ConflictError(APIException):
    """冲突"""
    def __init__(self, message, conflicting_field=None):
        details = {}
        if conflicting_field:
            details['field'] = conflicting_field
        super().__init__(message, 409, 'CONFLICT', details)


class InternalServerError(APIException):
    """服务器内部错误"""
    def __init__(self, message="服务器内部错误", error_detail=None):
        details = {}
        if error_detail:
            details['detail'] = str(error_detail)
        super().__init__(message, 500, 'INTERNAL_SERVER_ERROR', details)


class RateLimitError(APIException):
    """速率限制"""
    def __init__(self, message="请求过于频繁", retry_after=None):
        details = {}
        if retry_after:
            details['retry_after'] = retry_after
        super().__init__(message, 429, 'RATE_LIMIT_EXCEEDED', details)


class BadGatewayError(APIException):
    """网关错误"""
    def __init__(self, message="网关错误，请稍后重试"):
        super().__init__(message, 502, 'BAD_GATEWAY')
