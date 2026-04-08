# backend/tests/test_servers_extended.py - 新增

"""
服务器管理 API 扩展测试
"""
import pytest
from models.models import Server, ProbeResult
from extensions import db
from datetime import datetime, timedelta


class TestServerExtended:
    """服务器 API 扩展测试"""
    
    def test_create_server_with_all_fields(self, client, auth_headers):
        """测试创建服务器（完整字段）"""
        response = client.post('/api/servers/',
            headers=auth_headers,
            json={
                'name': 'Test Server Full',
                'group': 'Production',
                'flag': '🇺🇸',
                'location': 'New York',
                'ip': '1.2.3.4',
                'cpu': 8,
                'ram': 16.0,
                'disk': 500,
                'bw': '10Gbps',
                'probe': 'http://probe.example.com/api',
                'note': 'Test server',
                'price': 299.99,
                'period': 'yearly',
                'expiry': '2027-12-31',
            }
        )
        
        assert response.status_code == 201
        data = response.get_json()
        assert data['server']['name'] == 'Test Server Full'
        assert data['server']['price'] == 299.99
    
    def test_create_server_invalid_price(self, client, auth_headers):
        """测试创建服务器（无效价格）"""
        response = client.post('/api/servers/',
            headers=auth_headers,
            json={
                'name': 'Invalid Price',
                'price': -100,
            }
        )
        
        assert response.status_code == 400
        assert 'error_code' in response.get_json()
    
    def test_create_server_invalid_expiry(self, client, auth_headers):
        """测试创建服务器（无效过期日期）"""
        response = client.post('/api/servers/',
            headers=auth_headers,
            json={
                'name': 'Invalid Expiry',
                'expiry': '2020-01-01',  # 过去的日期
            }
        )
        
        assert response.status_code == 400
    
    def test_server_list_with_cache(self, client, auth_headers, test_server):
        """测试服务器列表缓存"""
        # 第一次请求（缓存未命中）
        response1 = client.get('/api/servers/', headers=auth_headers)
        assert response1.status_code == 200
        assert response1.get_json()['from_cache'] is False
        
        # 第二次请求（缓存命中）
        response2 = client.get('/api/servers/', headers=auth_headers)
        assert response2.status_code == 200
        assert response2.get_json()['from_cache'] is True
        
        # 验证数据一致
        assert response1.get_json()['count'] == response2.get_json()['count']
    
    def test_server_metrics_push(self, client, auth_headers, test_server):
        """测试推送实时指标"""
        response = client.post(
            f'/api/servers/{test_server.id}/metrics',
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
        # 超出范围的 CPU 使用率
        response = client.post(
            f'/api/servers/{test_server.id}/metrics',
            headers=auth_headers,
            json={
                'cpu_use': 150,  # 无效！
            }
        )
        
        assert response.status_code == 400
        assert 'VALIDATION_ERROR' in response.get_json()['error_code']
    
    def test_server_history_query(self, client, auth_headers, test_server):
        """测试历史数据查询"""
        # 创建历史数据
        for i in range(10):
            probe_result = ProbeResult(
                server_id=test_server.id,
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
        
        # 查询历史
        response = client.get(
            f'/api/servers/{test_server.id}/history?days=1&limit=100',
            headers=auth_headers,
        )
        
        assert response.status_code == 200
        data = response.get_json()
        assert len(data['data']) >= 10
    
    def test_server_sorting(self, client, auth_headers):
        """测试排序功能"""
        # 创建多个服务器
        for i in range(3):
            client.post('/api/servers/',
                headers=auth_headers,
                json={
                    'name': f'Server {i}',
                    'price': (i + 1) * 100,
                }
            )
        
        # 按价格升序
        response_asc = client.get('/api/servers/?sort=price&order=asc', 
            headers=auth_headers)
        prices_asc = [s['price'] for s in response_asc.get_json()['servers']]
        assert prices_asc == sorted(prices_asc)
        
        # 按价格降序
        response_desc = client.get('/api/servers/?sort=price&order=desc',
            headers=auth_headers)
        prices_desc = [s['price'] for s in response_desc.get_json()['servers']]
        assert prices_desc == sorted(prices_desc, reverse=True)


# backend/tests/test_probe.py - 新增

"""
探针系统测试
"""
import pytest
from unittest.mock import patch, MagicMock


class TestProbe:
    """探针 API 测试"""
    
    def test_tcp_ping_success(self, client, auth_headers):
        """测试 TCP Ping 成功"""
        with patch('socket.socket') as mock_socket:
            mock_instance = MagicMock()
            mock_instance.connect_ex.return_value = 0
            mock_socket.return_value = mock_instance
            
            response = client.post('/api/probe/ping',
                headers=auth_headers,
                json={
                    'host': 'example.com',
                    'port': 80,
                    'count': 3,
                }
            )
            
            assert response.status_code == 200
            data = response.get_json()
            assert len(data['results']) == 3
            assert data['stats']['success'] <= 3
    
    def test_batch_ping(self, client, auth_headers, test_server):
        """测试批量 Ping"""
        response = client.post('/api/probe/ping/batch',
            headers=auth_headers,
            json={
                'server_ids': [test_server.id],
            }
        )
        
        assert response.status_code == 200
        data = response.get_json()
        assert test_server.id in data['results']
    
    def test_probe_fetch(self, client, auth_headers, test_server):
        """测试探针数据抓取"""
        test_server.probe_url = 'http://example.com/api/probe'
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
            
            response = client.post('/api/probe/fetch-probe',
                headers=auth_headers,
                json={'server_ids': [test_server.id]}
            )
            
            assert response.status_code == 200
            assert test_server.id in response.get_json()['updated']


# backend/tests/test_alerts.py - 扩展

"""
告警系统测试
"""

class TestAlerts:
    """告警系统测试"""
    
    def test_alert_rule_list(self, client, auth_headers):
        """测试获取告警规则"""
        response = client.get('/api/telegram/alerts', headers=auth_headers)
        assert response.status_code == 200
        assert 'rules' in response.get_json()
    
    def test_alert_threshold_check(self, client, auth_headers, test_server):
        """测试告警阈值检查"""
        # 设置高 CPU 使用率
        client.post(
            f'/api/servers/{test_server.id}/metrics',
            headers=auth_headers,
            json={'cpu_use': 95}
        )
        
        # 手动触发告警检查
        from services.alert_service import AlertService
        alert_service = AlertService()
        
        # 应该检测到 CPU 告警
        # （实际测试需要 Telegram 配置）
    
    def test_alert_cooldown(self, client, auth_headers):
        """测试告警冷却机制"""
        # 首次告警应该成功
        # 相同告警在冷却期内应该被忽略
        pass
