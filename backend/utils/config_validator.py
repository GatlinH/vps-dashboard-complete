# backend/utils/config_validator.py - 新建文件

"""配置验证工具"""

import os
from typing import List, Tuple

class ConfigValidator:
    """配置检验器"""
    
    REQUIRED_VARS = [
        'SECRET_KEY',
        'MYSQL_HOST',
        'MYSQL_USER',
        'MYSQL_PASSWORD',
        'MYSQL_DB',
        'JWT_SECRET_KEY',
    ]
    
    OPTIONAL_VARS = [
        'TELEGRAM_BOT_TOKEN',
        'TELEGRAM_CHAT_ID',
    ]
    
    @classmethod
    def validate(cls) -> Tuple[bool, List[str]]:
        """
        验证配置
        
        Returns:
            (是否有效, 错误列表)
        """
        errors = []
        
        # 检查必需变量
        for var in cls.REQUIRED_VARS:
            value = os.getenv(var)
            if not value:
                errors.append(f"缺少必需的环境变量: {var}")
            elif var.endswith('_KEY') and len(value) < 32:
                errors.append(f"环境变量 {var} 长度不足 32 个字符")
        
        # 检查 MySQL 连接
        try:
            import pymysql
            connection = pymysql.connect(
                host=os.getenv('MYSQL_HOST'),
                port=int(os.getenv('MYSQL_PORT', 3306)),
                user=os.getenv('MYSQL_USER'),
                password=os.getenv('MYSQL_PASSWORD'),
                database=os.getenv('MYSQL_DB'),
            )
            connection.close()
        except Exception as e:
            errors.append(f"MySQL 连接失败: {e}")
        
        # 检查 Redis 连接
        try:
            import redis
            redis_client = redis.Redis(
                host=os.getenv('REDIS_HOST', 'localhost'),
                port=int(os.getenv('REDIS_PORT', 6379)),
                db=int(os.getenv('REDIS_DB', 0)),
            )
            redis_client.ping()
        except Exception as e:
            errors.append(f"Redis 连接失败: {e}")
        
        return len(errors) == 0, errors


# 在 app.py 中使用
if __name__ == "__main__":
    from utils.config_validator import ConfigValidator
    
    valid, errors = ConfigValidator.validate()
    if not valid:
        print("⚠️ 配置验证失败:")
        for error in errors:
            print(f"  - {error}")
        exit(1)
    
    print("✓ 配置验证成功")
    app = create_app()
    app.run()
