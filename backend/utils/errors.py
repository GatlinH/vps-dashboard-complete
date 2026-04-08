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


# backend/middleware/error_handler.py

import logging
import traceback
from flask import request
from datetime import datetime

logger = logging.getLogger(__name__)

class ErrorHandler:
    """统一错误处理器"""
    
    def __init__(self, app):
        self.app = app
        self.setup_handlers()
    
    def setup_handlers(self):
        """设置所有错误处理器"""
        
        @self.app.errorhandler(APIException)
        def handle_api_exception(error):
            """处理 API 异常"""
            response = {
                'success': False,
                'timestamp': datetime.utcnow().isoformat(),
                'message': error.message,
                'error_code': error.error_code,
                'details': error.details,
                'request_id': request.headers.get('X-Request-ID', 'unknown'),
            }
            
            # 记录错误日志
            self._log_error(error, response)
            
            return jsonify(response), error.status_code
        
        @self.app.errorhandler(404)
        def handle_not_found(error):
            """处理 404"""
            response = {
                'success': False,
                'timestamp': datetime.utcnow().isoformat(),
                'message': '请求的资源不存在',
                'error_code': 'NOT_FOUND',
                'details': {
                    'path': request.path,
                    'method': request.method,
                },
                'request_id': request.headers.get('X-Request-ID', 'unknown'),
            }
            
            logger.warning(f"404 Not Found: {request.method} {request.path}")
            
            return jsonify(response), 404
        
        @self.app.errorhandler(405)
        def handle_method_not_allowed(error):
            """处理 405"""
            response = {
                'success': False,
                'timestamp': datetime.utcnow().isoformat(),
                'message': f'HTTP 方法 {request.method} 不被允许',
                'error_code': 'METHOD_NOT_ALLOWED',
                'details': {
                    'method': request.method,
                    'path': request.path,
                },
                'request_id': request.headers.get('X-Request-ID', 'unknown'),
            }
            
            logger.warning(f"405 Method Not Allowed: {request.method} {request.path}")
            
            return jsonify(response), 405
        
        @self.app.errorhandler(500)
        def handle_internal_error(error):
            """处理 500"""
            error_id = f"{datetime.utcnow().timestamp()}"
            response = {
                'success': False,
                'timestamp': datetime.utcnow().isoformat(),
                'message': '服务器内部错误',
                'error_code': 'INTERNAL_SERVER_ERROR',
                'error_id': error_id,
                'details': {},
                'request_id': request.headers.get('X-Request-ID', 'unknown'),
            }
            
            # 记录详细错误
            logger.error(
                f"500 Internal Server Error (ID: {error_id})",
                exc_info=True,
                extra={
                    'method': request.method,
                    'path': request.path,
                    'remote_addr': request.remote_addr,
                }
            )
            
            return jsonify(response), 500
        
        @self.app.errorhandler(Exception)
        def handle_unknown_error(error):
            """处理未知异常"""
            error_id = f"{datetime.utcnow().timestamp()}"
            response = {
                'success': False,
                'timestamp': datetime.utcnow().isoformat(),
                'message': '发生未预期的错误',
                'error_code': 'UNKNOWN_ERROR',
                'error_id': error_id,
                'details': {},
                'request_id': request.headers.get('X-Request-ID', 'unknown'),
            }
            
            # 记录堆栈跟踪
            logger.critical(
                f"Unknown Error (ID: {error_id}): {str(error)}",
                exc_info=True,
                extra={
                    'method': request.method,
                    'path': request.path,
                    'remote_addr': request.remote_addr,
                }
            )
            
            return jsonify(response), 500
    
    @staticmethod
    def _log_error(error, response):
        """记录错误信息"""
        level = {
            400: logging.WARNING,
            401: logging.INFO,
            403: logging.INFO,
            404: logging.DEBUG,
            429: logging.WARNING,
            500: logging.ERROR,
        }.get(error.status_code, logging.WARNING)
        
        logger.log(
            level,
            f"{error.status_code} {error.error_code}: {error.message}",
            extra={
                'error_code': error.error_code,
                'method': request.method,
                'path': request.path,
                'remote_addr': request.remote_addr,
            }
        )
