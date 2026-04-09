"""测试配置和 fixtures"""
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
        # expunge 后对象可在 session 外安全访问（只读已加载的属性）
        _db.session.expunge(user)
        yield user


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
        # 刷新以确保所有列（包括 id）已加载，再 expunge
        _db.session.refresh(server)
        _db.session.expunge(server)
        yield server


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
