"""测试配置和 fixtures"""
import pytest
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import fakeredis
import extensions
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
    'ADMIN_DEFAULT_PASSWORD': 'TestAdmin@123456',
}


@pytest.fixture(scope='session')
def app():
    """创建测试应用实例"""
    application = create_app(**_TEST_CONFIG)

    # 用 fakeredis 替换真实 Redis，避免测试环境依赖外部 Redis 服务
    fake_redis = fakeredis.FakeRedis(decode_responses=True)
    extensions.redis_client = fake_redis

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
    """每个测试前重置数据库，确保 admin 用户存在；同时清空 Redis 缓存"""
    with app.app_context():
        _db.create_all()
        # 清空 Redis 缓存，避免跨测试缓存污染
        try:
            extensions.redis_client.flushdb()
        except Exception:
            pass
        if not User.query.filter_by(username='admin').first():
            admin = User(
                username='admin',
                password_hash=generate_password_hash('TestAdmin@123456'),
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
        _db.session.refresh(user)
        _db.session.expunge(user)
        yield user


@pytest.fixture
def test_server(app, test_user):
    """创建测试服务器，返回服务器 ID（整数）"""
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
        server_id = server.id
        yield server_id


@pytest.fixture
def auth_headers(client, test_user):
    """获取 testuser 的认证头"""
    response = client.post('/api/auth/login', json={
        'username': 'testuser',
        'password': 'password123',
    })
    data = response.get_json()
    assert 'access_token' in data, (
        f"登录失败，响应: {data}（状态码: {response.status_code}）"
    )
    token = data['access_token']
    return {'Authorization': f'Bearer {token}'}
