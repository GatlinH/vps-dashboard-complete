# backend/middleware/validators.py - 完整验证系统

from functools import wraps
from flask import request, jsonify
from utils.errors import ValidationError
import json
from datetime import datetime

class RequestValidator:
    """请求验证器"""
    
    @staticmethod
    def validate_json(*required_fields, optional_fields=None, type_checks=None):
        """
        JSON 请求体验证装饰器
        
        Args:
            *required_fields: 必填字段列表
            optional_fields: 可选字段列表
            type_checks: 字段类型检查字典 {'field': str, 'age': int}
        """
        def decorator(f):
            @wraps(f)
            def decorated_function(*args, **kwargs):
                data = request.get_json(silent=True)
                
                if data is None:
                    raise ValidationError("请求体必须是 JSON 格式")
                
                if not isinstance(data, dict):
                    raise ValidationError("请求体必须是 JSON 对象")
                
                # 检查必填字段
                missing = [field for field in required_fields if field not in data or data[field] is None]
                if missing:
                    raise ValidationError(
                        f"缺少必填字段: {', '.join(missing)}",
                        field=missing[0]
                    )
                
                # 检查字段类型
                if type_checks:
                    for field, expected_type in type_checks.items():
                        if field in data and data[field] is not None:
                            if not isinstance(data[field], expected_type):
                                raise ValidationError(
                                    f"字段 '{field}' 类型错误，期望 {expected_type.__name__}",
                                    field=field,
                                    value=data[field]
                                )
                
                # 检查多余字段
                allowed_fields = set(required_fields) | set(optional_fields or [])
                extra_fields = set(data.keys()) - allowed_fields
                if extra_fields:
                    # 可选：警告或拒绝多余字段
                    pass
                
                request.validated_data = data
                return f(*args, **kwargs)
            
            return decorated_function
        return decorator
    
    @staticmethod
    def validate_pagination():
        """分页参数验证"""
        def decorator(f):
            @wraps(f)
            def decorated_function(*args, **kwargs):
                try:
                    page = request.args.get('page', 1, type=int)
                    per_page = request.args.get('per_page', 20, type=int)
                    
                    if page < 1:
                        raise ValidationError("page 必须大于等于 1")
                    
                    if per_page < 1 or per_page > 100:
                        raise ValidationError("per_page 必须在 1-100 之间")
                    
                    kwargs['page'] = page
                    kwargs['per_page'] = per_page
                
                except ValueError as e:
                    raise ValidationError("分页参数必须是整数")
                
                return f(*args, **kwargs)
            
            return decorated_function
        return decorator
    
    @staticmethod
    def validate_query_params(**param_types):
        """查询参数验证
        
        用法:
        @validate_query_params(
            status=str,
            limit=int,
            offset=int
        )
        """
        def decorator(f):
            @wraps(f)
            def decorated_function(*args, **kwargs):
                validated_params = {}
                
                for param, param_type in param_types.items():
                    value = request.args.get(param)
                    
                    if value is None:
                        continue
                    
                    try:
                        if param_type == bool:
                            validated_params[param] = value.lower() in ('true', '1', 'yes')
                        elif param_type == int:
                            validated_params[param] = int(value)
                        elif param_type == float:
                            validated_params[param] = float(value)
                        else:
                            validated_params[param] = param_type(value)
                    
                    except (ValueError, TypeError):
                        raise ValidationError(
                            f"查询参数 '{param}' 转换为 {param_type.__name__} 失败",
                            field=param
                        )
                
                kwargs['query_params'] = validated_params
                return f(*args, **kwargs)
            
            return decorated_function
        return decorator
    
    @staticmethod
    def sanitize_string(max_length=1000, strip=True, lowercase=False):
        """字符串清理装饰器"""
        def decorator(f):
            @wraps(f)
            def decorated_function(*args, **kwargs):
                data = request.get_json(silent=True) or {}
                
                for key, value in data.items():
                    if isinstance(value, str):
                        if strip:
                            value = value.strip()
                        if len(value) > max_length:
                            raise ValidationError(
                                f"字段 '{key}' 长度超过 {max_length}",
                                field=key
                            )
                        if lowercase:
                            value = value.lower()
                        data[key] = value
                
                request.validated_data = data
                return f(*args, **kwargs)
            
            return decorated_function
        return decorator
