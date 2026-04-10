"""
utils/validators.py — 输入验证工具函数
"""
import re


def validate_password_strength(password: str) -> tuple:
    """
    校验密码强度，返回 (passed: bool, error_message: str)
    规则：至少12位，需同时包含大写字母、小写字母、数字、特殊字符
    """
    if len(password) < 12:
        return False, "密码至少 12 位"
    if not re.search(r'[A-Z]', password):
        return False, "密码需包含大写字母"
    if not re.search(r'[a-z]', password):
        return False, "密码需包含小写字母"
    if not re.search(r'[0-9]', password):
        return False, "密码需包含数字"
    if not re.search(r'[!@#$%^&*()\-_=+\[\]{};:\'",.<>?/\\|`~]', password):
        return False, "密码需包含特殊字符（如 !@#$%^&*）"
    return True, ""
