"""测试配置和 fixtures"""
import fnmatch
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import extensions
from app import create_app
from extensions import db as _db
from models.models import User, Server
from werkzeug.security import generate_password_hash

try:
    import fakeredis  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - fallback for restricted envs
    fakeredis = None


class _InMemoryRedis:
    """用于测试的极简 Redis 替身（覆盖本项目测试会用到的方法）。"""

    def __init__(self):
        self._store = {}

    def _cleanup_expired(self):
        now = time.time()
        expired = [k for k, (_, exp) in self._store.items() if exp is not None and exp <= now]
        for k in expired:
            self._store.pop(k, None)

    def setex(self, key, ttl, value):
        exp = time.time() + max(int(ttl), 0)
        self._store[key] = (str(value), exp)
        return True

    def set(self, key, value, ex=None, nx=False):
        self._cleanup_expired()
        if nx and key in self._store:
            return False
        exp = None if ex is None else (time.time() + max(int(ex), 0))
        self._store[key] = (str(value), exp)
        return True

    def get(self, key):
        self._cleanup_expired()
        item = self._store.get(key)
        return None if item is None else item[0]

    def delete(self, *keys):
        removed = 0
        for key in keys:
            if key in self._store:
                self._store.pop(key, None)
                removed += 1
        return removed

    def exists(self, key):
        self._cleanup_expired()
        return 1 if key in self._store else 0

    def ttl(self, key):
        self._cleanup_expired()
        item = self._store.get(key)
        if item is None:
            return -2
        _, exp = item
        if exp is None:
            return -1
        return max(int(exp - time.time()), 0)

    def expire(self, key, ttl):
        self._cleanup_expired()
        if key not in self._store:
            return 0
        value, _ = self._store[key]
        self._store[key] = (value, time.time() + max(int(ttl), 0))
        return 1

    def incr(self, key):
        self._cleanup_expired()
        value = self.get(key)
        n = int(value) if value is not None else 0
        n += 1
        self._store[key] = (str(n), self._store.get(key, (None, None))[1])
        return n

    def scan_iter(self, pattern):
        self._cleanup_expired()
        for key in list(self._store.keys()):
            if fnmatch.fnmatch(key, pattern):
                yield key

    def rpush(self, key, *values):
        self._cleanup_expired()
        lst = self._store.get(key)
        items = list(lst[0]) if lst and isinstance(lst[0], list) else []
        items.extend(values)
        self._store[key] = (items, None)
        return len(items)

    def llen(self, key):
        self._cleanup_expired()
        item = self._store.get(key)
        if item is None:
            return 0
        val, _ = item
        return len(val) if isinstance(val, list) else 0

    def brpop(self, key, timeout=0):
        self._cleanup_expired()
        item = self._store.get(key)
        if item is None:
            return None
        val, exp = item
        if not isinstance(val, list) or not val:
            return None
        value = val.pop()
        self._store[key] = (val, exp)
        return (key, value)

    def flushdb(self):
        self._store.clear()
        return True

    def ping(self):
        return True


_TEST_CONFIG = {
    'TESTING': True,
    'SQLALCHEMY_DATABASE_URI': 'sqlite:///:memory:',
    'JWT_SECRET_KEY': 'test-secret-key-for-testing-only',
    'SECRET_KEY': 'test-secret-key-for-testing-only-32chars!',
    'REDIS_URL': 'redis://localhost:6379/15',
    'RATELIMIT_STORAGE_URI': 'memory://',
    # 测试环境默认关闭限流，避免高频调用 /api/v1/auth/login 时触发 429 干扰功能断言
    'RATELIMIT_ENABLED': False,
    'WTF_CSRF_ENABLED': False,
    'FORCE_HTTPS': False,
    'AGENT_REQUIRE_TLS': False,
    'ADMIN_DEFAULT_PASSWORD': 'TestAdmin@123456',
    # 测试用加密密钥 — 确保 TelegramConfig.bot_token 写入路径不触发 fail-closed
    'TELEGRAM_TOKEN_SECRET': 'test-telegram-secret-key-for-testing-only!',
    # P1-7: 测试环境通过 HTTP 运行，不强制 Secure 属性，保证 cookie 能被测试客户端正常收发
    'JWT_COOKIE_SECURE': False,
}


@pytest.fixture(scope='session')
def app():
    """创建测试应用实例"""
    application = create_app(**_TEST_CONFIG)

    # 优先使用 fakeredis；受限环境下回退到内存实现，避免依赖外部服务
    fake_redis = fakeredis.FakeRedis(decode_responses=True) if fakeredis else _InMemoryRedis()
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
        # 测试间隔离：默认关闭限流；若测试显式设为 True 则尊重该配置
        app.config.setdefault('RATELIMIT_ENABLED', False)
        try:
            app.limiter.enabled = bool(app.config.get('RATELIMIT_ENABLED', False))
        except Exception:
            pass

        try:
            _db.create_all()
        except RuntimeError:
            # 某些独立测试会自建最小 Flask app（未绑定 SQLAlchemy），直接跳过 DB 处理
            yield
            return
        # 清空 Redis 缓存，避免跨测试缓存污染
        try:
            extensions.redis_client.flushdb()
        except Exception:
            pass
        # 清空 flask-limiter 计数，避免跨测试累计命中 /auth/login 速率限制
        try:
            app.limiter.reset()
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
            password_hash=generate_password_hash('Password@123456'),
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
            probe_url='http://example.com/api/probe',
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
    response = client.post('/api/v1/auth/login', json={
        'username': 'testuser',
        'password': 'Password@123456',
    })
    data = response.get_json()
    assert 'access_token' in data, (
        f"登录失败，响应: {data}（状态码: {response.status_code}）"
    )
    token = data['access_token']
    return {'Authorization': f'Bearer {token}'}
