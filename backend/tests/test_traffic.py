"""流量管理 API 测试"""
from datetime import date


def test_get_traffic_summary(client, auth_headers):
    """测试获取流量汇总"""
    response = client.get('/api/traffic/', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'total_limit_gb' in data
    assert 'total_used_gb' in data
    assert 'server_count' in data


def test_list_traffic_servers(client, auth_headers, test_server):
    """测试获取服务器流量列表"""
    response = client.get('/api/traffic/servers', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'servers' in data
    assert 'count' in data


def test_get_server_traffic(client, auth_headers, test_server):
    """测试获取单个服务器流量详情"""
    server_id = test_server
    response = client.get(f'/api/traffic/{server_id}', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'id' in data
    assert 'limit_gb' in data
    assert 'used_gb' in data
    assert 'reset_day' in data


def test_get_traffic_history(client, auth_headers, test_server):
    """测试获取流量历史"""
    server_id = test_server
    response = client.get(
        f'/api/traffic/{server_id}/history?days=7',
        headers=auth_headers
    )
    assert response.status_code == 200
    data = response.get_json()
    assert 'data' in data
    assert 'count' in data
