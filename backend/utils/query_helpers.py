# backend/utils/query_helpers.py - 新建文件

"""
查询优化工具
"""
from flask import request
from sqlalchemy.orm import Query

class QueryHelper:
    """查询辅助类"""
    
    @staticmethod
    def paginate(query: Query, page: int = 1, per_page: int = 20, max_per_page: int = 100):
        """
        分页查询
        
        Args:
            query: SQLAlchemy 查询对象
            page: 页码（从 1 开始）
            per_page: 每页数量
            max_per_page: 最大每页数量
        
        Returns:
            dict: {items, total, pages, current_page, has_next, has_prev}
        """
        per_page = min(per_page, max_per_page)
        page = max(1, page)
        
        paginated = query.paginate(
            page=page,
            per_page=per_page,
            error_out=False
        )
        
        return {
            'items': paginated.items,
            'total': paginated.total,
            'pages': paginated.pages,
            'current_page': page,
            'per_page': per_page,
            'has_next': paginated.has_next,
            'has_prev': paginated.has_prev,
        }
    
    @staticmethod
    def filter_by_kwargs(query: Query, model, **kwargs):
        """
        通过关键字参数过滤查询
        
        Usage:
            query = QueryHelper.filter_by_kwargs(
                query, Server,
                group_name='default',
                status='online'
            )
        """
        for key, value in kwargs.items():
            if value is not None and hasattr(model, key):
                query = query.filter(getattr(model, key) == value)
        
        return query
    
    @staticmethod
    def get_pagination_params():
        """从请求参数获取分页参数"""
        page = request.args.get('page', 1, type=int)
        per_page = request.args.get('per_page', 20, type=int)
        return max(1, page), min(max(1, per_page), 100)


# 使用示例
# backend/api/servers.py

from utils.query_helpers import QueryHelper
from flask import request, jsonify

@servers_bp.get('/')
def list_servers():
    """获取服务器列表（带分页）"""
    page, per_page = QueryHelper.get_pagination_params()
    
    query = Server.query
    
    # 过滤条件
    if request.args.get('group'):
        query = query.filter_by(group_name=request.args.get('group'))
    
    if request.args.get('status'):
        query = query.filter_by(status=request.args.get('status'))
    
    # 排序
    sort_field = request.args.get('sort', 'id')
    sort_order = request.args.get('order', 'asc').lower()
    
    if hasattr(Server, sort_field):
        order_by = getattr(Server, sort_field)
        if sort_order == 'desc':
            order_by = order_by.desc()
        query = query.order_by(order_by)
    
    # 分页
    result = QueryHelper.paginate(query, page, per_page)
    
    return jsonify({
        'servers': [s.to_dict() for s in result['items']],
        'pagination': {
            'total': result['total'],
            'pages': result['pages'],
            'current_page': result['current_page'],
            'per_page': result['per_page'],
            'has_next': result['has_next'],
            'has_prev': result['has_prev'],
        }
    })
