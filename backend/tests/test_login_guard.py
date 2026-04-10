"""LoginGuard 单元测试"""
import extensions
from middleware.login_guard import LoginGuard


def _flush_redis():
    try:
        extensions.redis_client.flushdb()
    except Exception:
        pass


# ── 用户名锁定 ────────────────────────────────────────────────────────────────

def test_account_not_locked_initially(app):
    """初始状态账户未锁定"""
    _flush_redis()
    locked, remaining = LoginGuard.is_account_locked("testuser")
    assert locked is False
    assert remaining == 0


def test_username_lock_triggers_after_max_attempts(client):
    """连续 5 次失败后账户被锁定，返回 429"""
    _flush_redis()
    for _ in range(LoginGuard.MAX_ATTEMPTS):
        resp = client.post('/api/auth/login', json={
            'username': 'noexist',
            'password': 'wrongpass',
        })
        assert resp.status_code in (401, 429)

    resp = client.post('/api/auth/login', json={
        'username': 'noexist',
        'password': 'wrongpass',
    })
    assert resp.status_code == 429
    data = resp.get_json()
    assert 'retry_after' in data
    assert data['retry_after'] is not None


def test_429_response_contains_retry_after(app):
    """手动触发账户锁定，确认 retry_after 字段存在"""
    _flush_redis()
    # 直接设置锁
    lock_key = "login:lock:lockeduser"
    extensions.redis_client.setex(lock_key, 900, "1")

    exc_raised = None
    try:
        LoginGuard.check_login_allowed("lockeduser")
    except Exception as e:
        exc_raised = e

    assert exc_raised is not None
    assert hasattr(exc_raised, 'retry_after')
    assert exc_raised.retry_after > 0


def test_successful_login_clears_attempt_count(client):
    """登录成功后清除失败计数"""
    _flush_redis()
    # 产生几次失败
    for _ in range(2):
        client.post('/api/auth/login', json={
            'username': 'admin',
            'password': 'wrongpass',
        })

    # 成功登录
    resp = client.post('/api/auth/login', json={
        'username': 'admin',
        'password': 'TestAdmin@123456',
    })
    assert resp.status_code == 200

    # 失败计数应已清除
    attempt_key = "login:attempts:admin"
    val = extensions.redis_client.get(attempt_key)
    assert val is None


def test_unlocked_after_ttl_expires(app):
    """TTL 过期后账户解锁"""
    _flush_redis()
    lock_key = "login:lock:tempuser"
    # 设置极短 TTL（已过期等效）
    extensions.redis_client.setex(lock_key, 1, "1")
    # 手动删除模拟过期
    extensions.redis_client.delete(lock_key)

    locked, remaining = LoginGuard.is_account_locked("tempuser")
    assert locked is False
    assert remaining == 0


# ── IP 锁定 ───────────────────────────────────────────────────────────────────

def test_ip_not_locked_initially(app):
    """初始状态 IP 未锁定"""
    _flush_redis()
    locked, remaining = LoginGuard.is_ip_locked("1.2.3.4")
    assert locked is False
    assert remaining == 0


def test_ip_lock_triggers_after_max_ip_attempts(app):
    """连续 20 次 IP 失败后 IP 被锁定"""
    _flush_redis()
    ip = "10.0.0.1"
    ip_attempt_key = f"login:ip_attempts:{ip}"

    # 模拟 MAX_IP_ATTEMPTS - 1 次失败
    for _ in range(LoginGuard.MAX_IP_ATTEMPTS - 1):
        extensions.redis_client.incr(ip_attempt_key)
    extensions.redis_client.expire(ip_attempt_key, LoginGuard.IP_ATTEMPT_WINDOW)

    # 第 20 次触发锁定
    extensions.redis_client.incr(ip_attempt_key)
    LoginGuard._lock_ip(ip)

    locked, remaining = LoginGuard.is_ip_locked(ip)
    assert locked is True
    assert remaining > 0


def test_ip_lock_check_in_check_login_allowed(app):
    """check_login_allowed 检查 IP 锁定并包含 retry_after"""
    _flush_redis()
    ip = "192.168.99.1"
    lock_key = f"login:ip_lock:{ip}"
    extensions.redis_client.setex(lock_key, 1800, "1")

    exc_raised = None
    try:
        LoginGuard.check_login_allowed("anyuser", ip_address=ip)
    except Exception as e:
        exc_raised = e

    assert exc_raised is not None
    assert hasattr(exc_raised, 'retry_after')
    assert exc_raised.retry_after > 0


def test_ip_lock_returns_429_via_login_endpoint(client):
    """IP 被锁定时登录接口返回 429 和 retry_after"""
    _flush_redis()
    # 使用固定测试 IP，通过 environ_base 传入
    lock_key = "login:ip_lock:127.0.0.1"
    extensions.redis_client.setex(lock_key, 1800, "1")

    resp = client.post('/api/auth/login', json={
        'username': 'admin',
        'password': 'TestAdmin@123456',
    }, environ_base={'REMOTE_ADDR': '127.0.0.1'})
    assert resp.status_code == 429
    data = resp.get_json()
    assert 'retry_after' in data
