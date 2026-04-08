"""统一错误处理中间件"""
import logging
from flask import jsonify
from werkzeug.exceptions import HTTPException

logger = logging.getLogger(__name__)


class ErrorHandler:
    def __init__(self, app):
        @app.errorhandler(400)
        def bad_request(e):
            return jsonify(success=False, error_code='BAD_REQUEST', message=str(e)), 400

        @app.errorhandler(401)
        def unauthorized(e):
            return jsonify(success=False, error_code='UNAUTHORIZED', message='未授权'), 401

        @app.errorhandler(403)
        def forbidden(e):
            return jsonify(success=False, error_code='FORBIDDEN', message='权限不足'), 403

        @app.errorhandler(500)
        def internal_error(e):
            logger.error(f'500 error: {e}', exc_info=True)
            return jsonify(success=False, error_code='INTERNAL_ERROR', message='服务器内部错误'), 500

        @app.errorhandler(Exception)
        def handle_exception(e):
            if isinstance(e, HTTPException):
                return jsonify(success=False, error_code='HTTP_ERROR', message=str(e)), e.code
            logger.error(f'Unhandled exception: {e}', exc_info=True)
            return jsonify(success=False, error_code='INTERNAL_ERROR', message=str(e)), 500
