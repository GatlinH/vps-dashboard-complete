"""统一错误处理中间件"""
# 委托给 utils.errors 中的完整实现，该实现正确处理 APIException、
# HTTP 状态码（404/405/500）以及所有未捕获异常。
from utils.errors import ErrorHandler  # noqa: F401

__all__ = ['ErrorHandler']
