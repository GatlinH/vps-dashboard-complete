"""统一错误处理中间件"""
import logging
import traceback
from flask import jsonify, request
from werkzeug.exceptions import HTTPException
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


class ErrorHandler:
    def __init__(self, app):
        # 导入 APIException（避免循环导入，在函数内导入）
        from utils.errors import APIException

        @app.errorhandler(APIException)
        def handle_api_exception(error):
            """处理所有自定义 API 异常（含 ValidationError / NotFoundError 等）"""
            logger.log(
                logging.WARNING if error.status_code < 500 else logging.ERROR,
                f"{error.status_code} {error.error_code}: {error.message}",
            )
            return jsonify(
                success=False,
                timestamp=datetime.now(timezone.utc).isoformat(),
                message=error.message,
                error_code=error.error_code,
                details=error.details,
            ), error.status_code

        @app.errorhandler(Exception)
        def handle_exception(e):
            if isinstance(e, HTTPException):
                return jsonify(
                    success=False,
                    error_code='HTTP_ERROR',
                    message=str(e)
                ), e.code
            logger.error(f'Unhandled exception: {e}', exc_info=True)
            return jsonify(
                success=False,
                error_code='INTERNAL_ERROR',
                message=str(e)
            ), 500
