"""测试配置和 fixtures"""
# 在文件顶部添加
from sqlalchemy.orm import make_transient

@pytest.fixture
def test_server(app, test_user):
    """创建测试服务器"""
    with app.app_context():
        server = Server(
            name='Test Server',
            group_name='Test Group',
            ip='192.168.1.1',
            cpu_cores=4,
            ram_gb=8.0,
            disk_gb=100,
            price=100.0,
            period='monthly',
            status='online',
            cpu_use=50.0,
            ram_use=60.0,
            disk_use=70.0,
        )
        _db.session.add(server)
        _db.session.commit()
        _db.session.refresh(server)   # ← 强制立即加载所有列
        _db.session.expunge(server)   # ← 从 Session 中分离
        make_transient(server)        # ← 标记为 transient，允许离线访问属性
        return server
import pytest
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import create_app
from extensions import db as _db
from models.models import User, Server
from werkzeug.security import generate_password_hash

_TEST_CONFIG = {
    'TESTING': True,
    'SQLALCHEMY_DATABASE_URI': 'sqlite:///:memory:',
    'JWT_SECRET_KEY': 'test-secret-key-for-testing-only',
    'SECRET_KEY': 'test-secret-key-for-testing-only-32chars!',
    'REDIS_URL': 'redis://localhost:6379/15',
    'WTF_CSRF_ENABLED': False,
    'FORCE_HTTPS': False,
}


@pytest.fixture(scope='session')
def app():
    """创建测试应用实例"""
    application = create_app(**_TEST_CONFIG)

    with application.app_context():
        _db.create_all()
        yield application
        _db.session.remove()
        _db.drop_all()


@pytest.fixture
def client(app):
    """测试客户端"""
    return app.test_client()


@pytest.fixture(autouse=True)
def reset_db(app):
    """每个测试前重置数据库，确保 admin 用户存在"""
    with app.app_context():
        _db.create_all()
        if not User.query.filter_by(username='admin').first():
            admin = User(
                username='admin',
                password_hash=generate_password_hash('admin123'),
                role='admin',
            )
            _db.session.add(admin)
            _db.session.commit()
        yield
        _db.session.remove()
        _db.drop_all()


@pytest.fixture
def test_user(app):
    """创建 testuser 测试用户"""
    with app.app_context():
        user = User(
            username='testuser',
            password_hash=generate_password_hash('password123'),
            role='admin',
        )
        _db.session.add(user)
        _db.session.commit()
        return user


@pytest.fixture
def test_server(app, test_user):
    """创建测试服务器"""
    with app.app_context():
        server = Server(
            name='Test Server',
            group_name='Test Group',
            ip='192.168.1.1',
            cpu_cores=4,
            ram_gb=8.0,
            disk_gb=100,
            price=100.0,
            period='monthly',
            status='online',
            cpu_use=50.0,
            ram_use=60.0,
            disk_use=70.0,
        )
        _db.session.add(server)
        _db.session.commit()
        return server


@pytest.fixture
def auth_headers(client, test_user):
    """获取 testuser 的认证头"""
    response = client.post('/api/auth/login', json={
        'username': 'testuser',
        'password': 'password123',
    })
    token = response.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}
