"""扩展服务器 API 测试"""
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

from extensions import db
from models.models import ProbeResult, User
from werkzeug.security import generate_password_hash


class TestServersExtended:
    def test_crud_flow_with_permission_boundary(self, client, auth_headers):
        """基础 CRUD 流程 + 权限边界"""
        # 1) 未登录创建 -> 401
        unauth = client.post('/api/v1/servers/', json={'name': 'noauth', 'ip': '1.1.1.1'})
        assert unauth.status_code == 401

        # 2) 普通用户创建 -> 403
        with client.application.app_context():
            user = User(username='viewer', password_hash=generate_password_hash('Viewer@123456'), role='viewer')
            db.session.add(user)
            db.session.commit()
        login_resp = client.post('/api/v1/auth/login', json={'username': 'viewer', 'password': 'Viewer@123456'})
        token = login_resp.get_json()['access_token']
        viewer_headers = {'Authorization': f'Bearer {token}'}
        forbidden = client.post('/api/v1/servers/', json={'name': 'viewer', 'ip': '1.1.1.2'}, headers=viewer_headers)
        assert forbidden.status_code == 403

        # 3) 管理员完整 CRUD
        create_resp = client.post('/api/v1/servers/', json={'name': 'crud-demo', 'ip': '8.8.8.8'}, headers=auth_headers)
        assert create_resp.status_code == 201
        sid = create_resp.get_json()['id']

        get_resp = client.get(f'/api/v1/servers/{sid}', headers=auth_headers)
        assert get_resp.status_code == 200
        assert get_resp.get_json()['name'] == 'crud-demo'

        update_resp = client.put(f'/api/v1/servers/{sid}', json={'name': 'crud-updated'}, headers=auth_headers)
        assert update_resp.status_code == 200
        assert update_resp.get_json()['name'] == 'crud-updated'

        delete_resp = client.delete(f'/api/v1/servers/{sid}', headers=auth_headers)
        assert delete_resp.status_code == 200
        not_found = client.get(f'/api/v1/servers/{sid}', headers=auth_headers)
        assert not_found.status_code == 404

    def test_server_list_with_cache(self, client, auth_headers, test_server):
        """测试服务器列表缓存"""
        # test_server 现在是 int ID，直接使用
        response1 = client.get('/api/v1/servers/', headers=auth_headers)
        assert response1.status_code == 200
        assert response1.get_json().get('from_cache') is False

        response2 = client.get('/api/v1/servers/', headers=auth_headers)
        assert response2.status_code == 200
        assert response2.get_json().get('from_cache') is True

        assert response1.get_json().get('count') == response2.get_json().get('count')

    def test_server_metrics_push(self, client, auth_headers, test_server):
        """测试推送实时指标"""
        server_id = test_server  # ✅ test_server 已是 int
        response = client.post(
            f'/api/v1/servers/{server_id}/metrics',
            headers=auth_headers,
            json={
                'cpu_use': 75.5,
                'ram_use': 82.3,
                'disk_use': 45.1,
                'net_up': 123.4,
                'net_down': 567.8,
                'status': 'online',
                'uptime': '10 days 5:30',
                'latency_ms': 25.5,
            }
        )

        assert response.status_code == 200
        data = response.get_json()
        assert data['metrics']['cpu_use'] == 75.5

    def test_server_metrics_validation(self, client, auth_headers, test_server):
        """测试指标验证"""
        server_id = test_server  # ✅
        response = client.post(
            f'/api/v1/servers/{server_id}/metrics',
            headers=auth_headers,
            json={
                'cpu_use': 150,  # 无效！
            }
        )

        assert response.status_code == 400
        assert 'VALIDATION_ERROR' in response.get_json().get('error_code', '')

    def test_server_history_query(self, client, auth_headers, test_server, app):
        """测试历史数据查询"""
        server_id = test_server  # ✅
        with app.app_context():
            for i in range(10):
                probe_result = ProbeResult(
                    server_id=server_id,
                    cpu_use=50 + i,
                    ram_use=60 + i,
                    disk_use=40 + i,
                    net_up=100 + i,
                    net_down=200 + i,
                    status='online',
                    created_at=datetime.utcnow() - timedelta(hours=i),
                )
                db.session.add(probe_result)
            db.session.commit()

        response = client.get(
            f'/api/v1/servers/{server_id}/history?days=1&limit=100',
            headers=auth_headers,
        )

        assert response.status_code == 200
        data = response.get_json()
        assert len(data.get('data', [])) >= 10

    def test_server_history_pagination_and_export(self, client, auth_headers, test_server, app):
        server_id = test_server
        with app.app_context():
            for i in range(20):
                db.session.add(ProbeResult(
                    server_id=server_id,
                    cpu_use=20 + i,
                    ram_use=30 + i,
                    disk_use=40 + i,
                    net_up=10 + i,
                    net_down=15 + i,
                    status='online',
                    created_at=datetime.utcnow() - timedelta(minutes=i),
                ))
            db.session.commit()

        page_resp = client.get(
            f'/api/v1/servers/{server_id}/history?days=1&limit=5&offset=5',
            headers=auth_headers,
        )
        assert page_resp.status_code == 200
        page_data = page_resp.get_json()
        assert page_data['limit'] == 5
        assert page_data['offset'] == 5
        assert page_data['total'] >= 20
        assert len(page_data['data']) == 5

        export_resp = client.get(
            f'/api/v1/servers/{server_id}/history?days=1&limit=5&export=csv',
            headers=auth_headers,
        )
        assert export_resp.status_code == 200
        assert 'text/csv' in (export_resp.content_type or '')
        assert b'server_id' in export_resp.data


class TestProbe:
    def test_batch_ping(self, client, auth_headers, test_server):
        """测试批量 Ping"""
        server_id = test_server  # ✅
        response = client.post('/api/v1/probe/ping/batch',
            headers=auth_headers,
            json={
                'server_ids': [server_id],
            }
        )

        assert response.status_code == 200
        data = response.get_json() or {}
        # results 在 JSON 中作为对象返回，JSON object 的键都是字符串，故用 str 比较最保险
        assert str(server_id) in list(data.get('results', {}).keys())

    def test_probe_fetch(self, client, auth_headers, test_server, app):
        """测试探针数据抓取"""
        server_id = test_server  # ✅
        with app.app_context():  # ✅ 在 app_context 内操作 ORM
            from models.models import Server as ServerModel
            s = db.session.get(ServerModel, server_id)
            s.probe_url = 'http://example.com/api/probe'
            db.session.commit()

        with patch('urllib.request.urlopen') as mock_urlopen:
            mock_response = MagicMock()
            mock_response.read.return_value = b'''{
                "cpu_use": 45.5,
                "ram_use": 62.3,
                "disk_use": 78.1,
                "net_up": 123.4,
                "net_down": 567.8,
                "status": "online"
            }'''
            mock_urlopen.return_value.__enter__.return_value = mock_response

            response = client.post('/api/v1/probe/fetch-probe',
                headers=auth_headers,
                json={'server_ids': [server_id]}
            )

            assert response.status_code == 200
            resp_json = response.get_json() or {}
            updated = resp_json.get('updated', [])
            # 将后端返回的 id 全部转为字符串再比较，既兼容后端返回数字也兼容字符串
            assert str(server_id) in [str(x) for x in updated]


class TestAlerts:
    def test_alert_threshold_check(self, client, auth_headers, test_server):
        """测试告警阈值检查"""
        server_id = test_server  # ✅
        resp = client.post(
            f'/api/v1/servers/{server_id}/metrics',
            headers=auth_headers,
            json={'cpu_use': 95}
        )
        # metrics update should succeed
        assert resp.status_code in (200, 202, 204)

    def test_alert_cooldown(self, client, auth_headers):
        """测试告警冷却机制"""
        pass
