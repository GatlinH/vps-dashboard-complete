import pytest
from flask import Flask, jsonify
from middleware.rate_limit import RateLimitConfig, limiter, LOGIN_LIMIT
from flask_jwt_extended import JWTManager, create_access_token

@pytest.fixture
def app():
    """创建一个用于测试限流的 Flask 最小应用"""
    app = Flask(__name__)
    app.config['TESTING'] = True
    app.config['JWT_SECRET_KEY'] = 'test-secret-key-for-rate-limit'
    app.config['REDIS_URL'] = 'memory://'  # 测试环境强制使用内存，避免依赖 Redis 实例
    
    JWTManager(app)
    RateLimitConfig.init_app(app)

    # 模拟一个登录接口，挂载 10次/分钟 的限制
    @app.route('/api/v1/auth/login', methods=['POST'])
    @limiter.limit(LOGIN_LIMIT)
    def mock_login():
        return jsonify({"success": True, "message": "Login successful"})

    # 模拟一个需要认证的普通接口
    @app.route('/api/v1/user/profile', methods=['GET'])
    @limiter.limit("2 per minute") # 故意设得很小用于测试
    def mock_profile():
        return jsonify({"success": True, "message": "Profile data"})

    return app

@pytest.fixture
def client(app):
    return app.test_client()

def test_login_rate_limit_ip_based(client):
    """测试基于 IP 的登录接口限流 (未登录状态)"""
    
    # 前 10 次请求应该全部成功 (基于 LOGIN_LIMIT = 10 per minute)
    for _ in range(10):
        response = client.post('/api/v1/auth/login')
        assert response.status_code == 200
        assert response.get_json()['success'] is True
    
    # 第 11 次请求应该被限流拦截 (返回 429)
    response = client.post('/api/v1/auth/login')
    assert response.status_code == 429
    data = response.get_json()
    assert data['success'] is False
    assert data['error_code'] == 'RATE_LIMIT_EXCEEDED'

def test_rate_limit_user_based(app, client):
    """测试基于有效 JWT 的 User ID 限流"""
    
    # 构造一个有效的测试 Token
    with app.app_context():
        token = create_access_token(identity="test_user_99")
    
    headers = {"Authorization": f"Bearer {token}"}
    
    # 该接口限制为 "2 per minute"
    # 第 1 次
    res1 = client.get('/api/v1/user/profile', headers=headers)
    assert res1.status_code == 200
    
    # 第 2 次
    res2 = client.get('/api/v1/user/profile', headers=headers)
    assert res2.status_code == 200
    
    # 第 3 次应当被拦截
    res3 = client.get('/api/v1/user/profile', headers=headers)
    assert res3.status_code == 429
    assert res3.get_json()['error_code'] == 'RATE_LIMIT_EXCEEDED'
