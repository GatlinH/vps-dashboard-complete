# backend/services/cache_warmer.py - 新文���

"""
缓存预热和智能失效机制
"""
import json
import logging
from extensions import redis_client, db
from models.models import Server

logger = logging.getLogger(__name__)

class CacheWarmer:
    """缓存预热器"""
    
    @staticmethod
    def warm_up_cache():
        """在应用启动时预热缓存"""
        try:
            logger.info("🔥 开始预热缓存...")
            
            # 预热服务器列表
            servers = Server.query.all()
            server_list = [s.to_dict() for s in servers]
            
            redis_client.setex(
                "vps:servers:list",
                15,
                json.dumps(server_list, ensure_ascii=False)
            )
            
            logger.info(f"✓ 已预热 {len(servers)} 台服务器数据到缓存")
            
            # 预热分组列表
            groups = [s.group_name for s in servers if s.group_name]
            groups = list(set(groups))
            
            redis_client.setex(
                "vps:server:groups",
                3600,
                json.dumps(groups, ensure_ascii=False)
            )
            
            logger.info(f"✓ 已预热 {len(groups)} 个分组到缓存")
        
        except Exception as e:
            logger.error(f"❌ 缓存预热失败: {e}")


class SmartCacheInvalidator:
    """智能缓存失效"""
    
    # 依赖关系图
    CACHE_DEPENDENCIES = {
        'vps:servers:list': [
            'vps:server:groups',
            'vps:server:*:metrics',
        ],
        'vps:server:*:metrics': [],
    }
    
    @staticmethod
    def invalidate(primary_key: str):
        """智能失效缓存"""
        # 删除主键
        redis_client.delete(primary_key)
        
        # 级联删除依赖项
        if primary_key in SmartCacheInvalidator.CACHE_DEPENDENCIES:
            for dependent in SmartCacheInvalidator.CACHE_DEPENDENCIES[primary_key]:
                if '*' in dependent:
                    # 模式匹配删除
                    pattern = dependent.replace('*', '*')
                    for key in redis_client.scan_iter(pattern):
                        redis_client.delete(key)
                else:
                    redis_client.delete(dependent)
        
        logger.info(f"✓ 缓存已失效: {primary_key}")
    
    @staticmethod
    def get_cache_stats() -> dict:
        """获取缓存统计"""
        info = redis_client.info('stats')
        return {
            'total_connections': info.get('total_connections_received', 0),
            'total_commands': info.get('total_commands_processed', 0),
            'instantaneous_ops': info.get('instantaneous_ops_per_sec', 0),
            'memory_used': info.get('used_memory_human', 'N/A'),
        }
