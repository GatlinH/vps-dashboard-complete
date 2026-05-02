"""
P2-1 权限检查风格统一 — 最小必要测试

验证 api/telegram.py 和 api/traffic.py 中权限装饰器替换后的语义等价性：
- admin 仍可访问所有原本允许的端点
- viewer 可访问只读端点，不可访问写端点
- user 角色被拒绝访问后台 dashboard 端点（只读或写）
- 未认证请求仍被拒绝（401）
"""
import pytest
from werkzeug.security import generate_password_hash
from models.models import User
from extensions import db as _db


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest.fixture
def viewer_headers(client, app):
    """以 viewer 角色用户登录，返回认证头"""
    with app.app_context():
        if not User.query.filter_by(username='p21_viewer').first():
            user = User(
                username='p21_viewer',
                password_hash=generate_password_hash('Viewer@123456'),
                role='viewer',
            )
            _db.session.add(user)
            _db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'p21_viewer',
        'password': 'Viewer@123456',
    })
    data = resp.get_json()
    assert 'access_token' in data, f"viewer 登录失败: {data}"
    return {'Authorization': f'Bearer {data["access_token"]}'}


@pytest.fixture
def user_headers(client, app):
    """以 user 角色用户登录，返回认证头"""
    with app.app_context():
        if not User.query.filter_by(username='p21_user').first():
            u = User(
                username='p21_user',
                password_hash=generate_password_hash('User@123456'),
                role='user',
            )
            _db.session.add(u)
            _db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'p21_user',
        'password': 'User@123456',
    })
    data = resp.get_json()
    assert 'access_token' in data, f"user 登录失败: {data}"
    return {'Authorization': f'Bearer {data["access_token"]}'}


# ── telegram.py 权限测试 ──────────────────────────────────────────────────────

class TestTelegramPermissions:
    """telegram.py 各端点替换后的权限语义验证"""

    # GET /config — viewer_or_admin_required

    def test_get_config_unauthenticated(self, client):
        """未认证 → 401"""
        resp = client.get('/api/v1/telegram/config')
        assert resp.status_code == 401

    def test_get_config_admin(self, client, auth_headers):
        """admin 可读取配置"""
        resp = client.get('/api/v1/telegram/config', headers=auth_headers)
        assert resp.status_code == 200
        assert 'config' in resp.get_json()

    def test_get_config_viewer(self, client, viewer_headers):
        """viewer 可读取配置（只读后台角色）"""
        resp = client.get('/api/v1/telegram/config', headers=viewer_headers)
        assert resp.status_code == 200
        assert 'config' in resp.get_json()

    def test_get_config_user_role_rejected(self, client, user_headers):
        """普通 user 角色不得访问后台配置接口 → 403"""
        resp = client.get('/api/v1/telegram/config', headers=user_headers)
        assert resp.status_code == 403

    # POST /config — admin_required

    def test_post_config_unauthenticated(self, client):
        """未认证 → 401"""
        resp = client.post('/api/v1/telegram/config', json={'enabled': False})
        assert resp.status_code == 401

    def test_post_config_admin(self, client, auth_headers):
        """admin 可保存配置"""
        resp = client.post('/api/v1/telegram/config', json={
            'chat_id': '77777',
            'prefix': '【P2-1】',
            'enabled': False,
        }, headers=auth_headers)
        assert resp.status_code == 200

    def test_post_config_viewer_rejected(self, client, viewer_headers):
        """viewer 不得修改配置 → 403"""
        resp = client.post('/api/v1/telegram/config', json={'enabled': False},
                           headers=viewer_headers)
        assert resp.status_code == 403

    def test_post_config_user_rejected(self, client, user_headers):
        """user 不得修改配置 → 403"""
        resp = client.post('/api/v1/telegram/config', json={'enabled': False},
                           headers=user_headers)
        assert resp.status_code == 403

    # GET /alerts — viewer_or_admin_required (already using decorator; verify still works after changes)

    def test_get_alerts_admin(self, client, auth_headers):
        """admin 可列出告警规则"""
        resp = client.get('/api/v1/telegram/alerts', headers=auth_headers)
        assert resp.status_code == 200

    def test_get_alerts_viewer(self, client, viewer_headers):
        """viewer 可列出告警规则"""
        resp = client.get('/api/v1/telegram/alerts', headers=viewer_headers)
        assert resp.status_code == 200

    def test_get_alerts_unauthenticated(self, client):
        """未认证 → 401"""
        resp = client.get('/api/v1/telegram/alerts')
        assert resp.status_code == 401

    # POST /alerts — admin_required

    def test_post_alerts_unauthenticated(self, client):
        """未认证 → 401"""
        resp = client.post('/api/v1/telegram/alerts', json={'rules': []})
        assert resp.status_code == 401

    def test_post_alerts_admin(self, client, auth_headers):
        """admin 可保存告警规则"""
        resp = client.post('/api/v1/telegram/alerts', json={'rules': []},
                           headers=auth_headers)
        assert resp.status_code == 200

    def test_post_alerts_viewer_rejected(self, client, viewer_headers):
        """viewer 不得修改告警规则 → 403"""
        resp = client.post('/api/v1/telegram/alerts', json={'rules': []},
                           headers=viewer_headers)
        assert resp.status_code == 403

    def test_post_alerts_user_rejected(self, client, user_headers):
        """user 不得修改告警规则 → 403"""
        resp = client.post('/api/v1/telegram/alerts', json={'rules': []},
                           headers=user_headers)
        assert resp.status_code == 403


# ── traffic.py 权限测试 ───────────────────────────────────────────────────────

class TestTrafficPermissions:
    """traffic.py 各端点替换后的权限语义验证"""

    # GET / — viewer_or_admin_required

    def test_summary_unauthenticated(self, client):
        """未认证 → 401"""
        resp = client.get('/api/v1/traffic/')
        assert resp.status_code == 401

    def test_summary_admin(self, client, auth_headers):
        """admin 可获取流量汇总"""
        resp = client.get('/api/v1/traffic/', headers=auth_headers)
        assert resp.status_code == 200

    def test_summary_viewer(self, client, viewer_headers):
        """viewer 可获取流量汇总"""
        resp = client.get('/api/v1/traffic/', headers=viewer_headers)
        assert resp.status_code == 200

    def test_summary_user_rejected(self, client, user_headers):
        """普通 user 角色不得访问流量汇总 → 403"""
        resp = client.get('/api/v1/traffic/', headers=user_headers)
        assert resp.status_code == 403

    # GET /servers — viewer_or_admin_required

    def test_servers_unauthenticated(self, client):
        resp = client.get('/api/v1/traffic/servers')
        assert resp.status_code == 401

    def test_servers_admin(self, client, auth_headers):
        resp = client.get('/api/v1/traffic/servers', headers=auth_headers)
        assert resp.status_code == 200

    def test_servers_viewer(self, client, viewer_headers):
        resp = client.get('/api/v1/traffic/servers', headers=viewer_headers)
        assert resp.status_code == 200

    def test_servers_user_rejected(self, client, user_headers):
        resp = client.get('/api/v1/traffic/servers', headers=user_headers)
        assert resp.status_code == 403

    # GET /<int:sid> — viewer_or_admin_required

    def test_server_detail_unauthenticated(self, client, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}')
        assert resp.status_code == 401

    def test_server_detail_admin(self, client, auth_headers, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}', headers=auth_headers)
        assert resp.status_code == 200

    def test_server_detail_viewer(self, client, viewer_headers, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}', headers=viewer_headers)
        assert resp.status_code == 200

    def test_server_detail_user_rejected(self, client, user_headers, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}', headers=user_headers)
        assert resp.status_code == 403

    # POST /<int:sid> — admin_required

    def test_update_unauthenticated(self, client, test_server):
        resp = client.post(f'/api/v1/traffic/{test_server}', json={'limit_gb': 100})
        assert resp.status_code == 401

    def test_update_admin(self, client, auth_headers, test_server):
        resp = client.post(f'/api/v1/traffic/{test_server}',
                           json={'limit_gb': 200.0},
                           headers=auth_headers)
        assert resp.status_code == 200

    def test_update_viewer_rejected(self, client, viewer_headers, test_server):
        """viewer 不得修改流量统计 → 403"""
        resp = client.post(f'/api/v1/traffic/{test_server}',
                           json={'limit_gb': 200.0},
                           headers=viewer_headers)
        assert resp.status_code == 403

    def test_update_user_rejected(self, client, user_headers, test_server):
        """user 不得修改流量统计 → 403"""
        resp = client.post(f'/api/v1/traffic/{test_server}',
                           json={'limit_gb': 200.0},
                           headers=user_headers)
        assert resp.status_code == 403

    # GET /<int:sid>/history — viewer_or_admin_required

    def test_history_unauthenticated(self, client, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}/history')
        assert resp.status_code == 401

    def test_history_admin(self, client, auth_headers, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}/history', headers=auth_headers)
        assert resp.status_code == 200

    def test_history_viewer(self, client, viewer_headers, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}/history', headers=viewer_headers)
        assert resp.status_code == 200

    def test_history_user_rejected(self, client, user_headers, test_server):
        resp = client.get(f'/api/v1/traffic/{test_server}/history', headers=user_headers)
        assert resp.status_code == 403
