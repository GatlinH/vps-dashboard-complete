"""扩展服务器 API 测试"""
from datetime import datetime, timedelta
from unittest.mock import patch, MagicMock

from extensions import db
from models.models import ProbeResult


class TestServersExtended:
    def test_server_list_with_cache(self, client, auth_headers, test_server):
        """测试服务器列表缓存"""
        # test_server 现在是 int ID，直接使用
        response1 = client.get('/api/v1/servers/', headers=auth_headers)
        assert response1.status_code == 200
        assert response1.get_json()['from_cache'] is False

        response2 = client.get('/api/v1/servers/', headers=auth_headers)
        assert response2.status_code == 200
        assert response2.get_json()['from_cache'] is True

        assert response1.get_json()['count'] == response2.get_json()['count']

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
        assert 'VALIDATION_ERROR' in response.get_json()['error_code']

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
        assert len(data['data']) >= 10


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
        data = response.get_json()
        assert str(server_id) in data['results']

    def test_probe_fetch(self, client, auth_headers, test_server, app):
        """测试探针数据抓取"""
        server_id = test_server  # ✅
        with app.app_context():  # ✅ 在 app_context 内操作 ORM
            from models.models import Server as ServerModel
            s = ServerModel.query.get(server_id)
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
            assert str(server_id) in response.get_json()['updated']


class TestAlerts:
    def test_alert_threshold_check(self, client, auth_headers, test_server):
        """测试告警阈值检查"""
        server_id = test_server  # ✅
        client.post(
            f'/api/v1/servers/{server_id}/metrics',
            headers=auth_headers,
            json={'cpu_use': 95}
        )

        from services.alert_service import AlertService
        alert_service = AlertService()

    def test_alert_cooldown(self, client, auth_headers):
        """测试告警冷却机制"""
        pass
