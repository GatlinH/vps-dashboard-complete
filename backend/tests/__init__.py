# backend/tests/__init__.py

"""测试模块"""

# backend/tests/conftest.py - pytest 配置

import pytest
import sys
import os
from datetime import datetime

# 添加父目录到路径
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


@pytest.fixture
def runner(app):
    """创建命令行测试运行器"""
    return app.test_cli_runner()


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
        assert response.get_json()['msg'] == '用户名或密码错误'
    
    def test_login_nonexistent_user(self, client):
        """测试不存在的用户"""
        response = client.post('/api/auth/login', json={
            'username': 'nonexistent',
            'password': 'password123'
        })
        
        assert response.status_code == 401
    
    def test_get_user_info(self, client, auth_headers):
        """测试获取用户信息"""
        response = client.get('/api/auth/me', headers=auth_headers)
        
        assert response.status_code == 200
        assert response.get_json()['user']['username'] == 'testuser'
    
    def test_change_password(self, client, auth_headers):
        """测试修改密码"""
        response = client.post('/api/auth/change-password',
            headers=auth_headers,
            json={
                'old_password': 'password123',
                'new_password': 'newpassword123'
            }
        )
        
        assert response.status_code == 200
        
        # 验证新密码可以登录
        login_response = client.post('/api/auth/login', json={
            'username': 'testuser',
            'password': 'newpassword123'
        })
        assert login_response.status_code == 200
    
    def test_token_refresh(self, client, test_user):
        """测试 Token 刷新"""
        # 获取初始 token
        login_response = client.post('/api/auth/login', json={
            'username': 'testuser',
            'password': 'password123'
        })
        refresh_token = login_response.get_json()['refresh_token']
        
        # 刷新 token
        response = client.post('/api/auth/refresh',
            headers={'Authorization': f'Bearer {refresh_token}'}
        )
        
        assert response.status_code == 200
        assert 'access_token' in response.get_json()


# backend/tests/test_servers.py

import pytest
from models.models import Server

class TestServers:
    """服务器模块测试"""
    
    def test_list_servers(self, client, auth_headers, test_server):
        """测试获取服务器列表"""
        response = client.get('/api/servers/', headers=auth_headers)
        
        assert response.status_code == 200
        data = response.get_json()
        assert 'servers' in data
        assert len(data['servers']) > 0
    
    def test_get_server(self, client, auth_headers, test_server):
        """测试获取单个服务器"""
        response = client.get(f'/api/servers/{test_server.id}', headers=auth_headers)
        
        assert response.status_code == 200
        server = response.get_json()['server']
        assert server['name'] == 'Test Server'
    
    def test_create_server(self, client, auth_headers):
        """测试创建服务器"""
        response = client.post('/api/servers/',
            headers=auth_headers,
            json={
                'name': 'New Server',
                'group': 'Production',
                'ip': '10.0.0.1',
                'cpu': 8,
                'ram': 16.0,
                'disk': 256,
                'price': 200.0,
            }
        )
        
        assert response.status_code == 201
        assert response.get_json()['server']['name'] == 'New Server'
    
    def test_update_server(self, client, auth_headers, test_server):
        """测试更新服务器"""
        response = client.put(f'/api/servers/{test_server.id}',
            headers=auth_headers,
            json={
                'name': 'Updated Server',
                'cpu': 8,
            }
        )
        
        assert response.status_code == 200
        assert response.get_json()['server']['name'] == 'Updated Server'
    
    def test_delete_server(self, client, auth_headers, test_server):
        """测试删除服务器"""
        server_id = test_server.id
        
        response = client.delete(f'/api/servers/{server_id}', headers=auth_headers)
        assert response.status_code == 200
        
        # 验证已删除
        response = client.get(f'/api/servers/{server_id}', headers=auth_headers)
        assert response.status_code == 404
    
    def test_filter_by_group(self, client, auth_headers, app, test_server):
        """测试按分组筛选"""
        with app.app_context():
            # 创建其他分组的服务器
            other_server = Server(
                name='Other Server',
                group_name='Other Group',
                ip='192.168.1.2',
            )
            from extensions import db
            db.session.add(other_server)
            db.session.commit()
        
        response = client.get('/api/servers/?group=Test%20Group', headers=auth_headers)
        
        assert response.status_code == 200
        servers = response.get_json()['servers']
        assert all(s['group'] == 'Test Group' for s in servers)


# backend/tests/test_probe.py

class TestProbe:
    """探针���块测试"""
    
    def test_tcp_ping(self, client, auth_headers):
        """测试 TCP Ping"""
        response = client.post('/api/probe/ping',
            headers=auth_headers,
            json={
                'host': 'google.com',
                'port': 80,
                'count': 3,
            }
        )
        
        assert response.status_code == 200
        data = response.get_json()
        assert 'results' in data
        assert 'stats' in data
        assert len(data['results']) == 3
    
    def test_batch_ping(self, client, auth_headers, test_server):
        """测试批量 Ping"""
        response = client.post('/api/probe/ping/batch',
            headers=auth_headers,
            json={}
        )
        
        assert response.status_code == 200
        assert 'results' in response.get_json()
