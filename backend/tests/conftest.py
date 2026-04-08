# backend/tests/conftest.py

import pytest
import sys
import os
from datetime import datetime

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from app import create_app
from extensions import db
from models.models import User, Server, AlertRule, TelegramConfig
from werkzeug.security import generate_password_hash


@pytest.fixture(scope='session')
def app():
    """创建应用实例"""
    app = create_app()
    app.config['TESTING'] = True
    app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///:memory:'
    app.config['JWT_SECRET_KEY'] = 'test-secret-key'
    
    with app.app_context():
        db.create_all()
        yield app
        db.session.remove()
        db.drop_all()


@pytest.fixture
def client(app):
    """创建测试客户端"""
    return app.test_client()


@pytest.fixture(autouse=True)
def reset_db(app):
    """每个测试前重置数据库"""
    with app.app_context():
        db.create_all()
        yield
        db.session.remove()
        db.drop_all()


@pytest.fixture
def test_user(app):
    """创建测试用户"""
    with app.app_context():
        user = User(
            username='testuser',
            password_hash=generate_password_hash('password123'),
            role='admin'
        )
        db.session.add(user)
        db.session.commit()
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
        db.session.add(server)
        db.session.commit()
        return server


@pytest.fixture
def auth_headers(client, test_user):
    """获取认证头"""
    response = client.post('/api/auth/login', json={
        'username': 'testuser',
        'password': 'password123'
    })
    token = response.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


# backend/tests/test_auth.py

import pytest
from models.models import User


class TestAuth:
    """认证模块测试"""
    
    def test_login_success(self, client, test_user):
        """测试登录成功"""
        response = client.post('/api/auth/login', json={
            'username': 'testuser',
            'password': 'password123'
        })
        
        assert response.status_code == 200
        data = response.get_json()
        assert 'access_token' in data
        assert 'refresh_token' in data
        assert data['user']['username'] == 'testuser'
    
    def test_login_wrong_password(self, client, test_user):
        """测试错误密码"""
        response = client.post('/api/auth/login', json={
            'username': 'testuser',
            'password': 'wrongpassword'
        })
        
        assert response.status_code == 401
    
    def test_get_user_info(self, client, auth_headers):
        """测试获取用户信息"""
        response = client.get('/api/auth/me', headers=auth_headers)
        
        assert response.status_code == 200
        assert response.get_json()['user']['username'] == 'testuser'


# backend/tests/test_servers.py

class TestServers:
    """服务器模块测试"""
    
    def test_list_servers(self, client, auth_headers, test_server):
        """测试获取服务器列表"""
        response = client.get('/api/servers/', headers=auth_headers)
        
        assert response.status_code == 200
        data = response.get_json()
        assert 'servers' in data
    
    def test_create_server(self, client, auth_headers):
        """测试创建服务器"""
        response = client.post('/api/servers/',
            headers=auth_headers,
            json={
                'name': 'New Server',
                'ip': '10.0.0.1',
            }
        )
        
        assert response.status_code == 201
    
    def test_delete_server(self, client, auth_headers, test_server):
        """测试删除服务器"""
        response = client.delete(f'/api/servers/{test_server.id}', 
            headers=auth_headers
        )
        
        assert response.status_code == 200


# backend/tests/test_alerts.py

class TestAlerts:
    """告警系统测试"""
    
    def test_list_alerts(self, client, auth_headers):
        """测试获取告警规则"""
        response = client.get('/api/telegram/alerts', headers=auth_headers)
        assert response.status_code == 200
    
    def test_fire_alert(self, client, auth_headers, test_server):
        """测试触发告警"""
        response = client.post('/api/telegram/alert/fire',
            headers=auth_headers,
            json={
                'server_id': test_server.id,
                'rule_type': 'CPU_HIGH',
                'current_value': 95.0,
                'threshold': 90,
            }
        )
        
        # 由于未配置 Telegram，应该返回 502
        assert response.status_code in [200, 502]
