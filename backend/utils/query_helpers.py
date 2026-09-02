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
