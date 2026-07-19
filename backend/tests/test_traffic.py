"""流量 API 测试"""


def test_get_traffic_summary(client, auth_headers):
    """获取流量汇总"""
    response = client.get('/api/v1/traffic/', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'total_limit_gb' in data
    assert 'total_used_gb' in data
    assert 'server_count' in data


def test_list_traffic_servers(client, auth_headers):
    """获取服务器流量列表"""
    response = client.get('/api/v1/traffic/servers', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'servers' in data
    assert isinstance(data['servers'], list)


def test_get_server_traffic(client, auth_headers, test_server):
    """获取单个服务器流量详情"""
    response = client.get(f'/api/v1/traffic/{test_server}', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert data['id'] == test_server
    assert 'used_gb' in data
    assert 'limit_gb' in data
    assert 'next_reset_date' in data


def test_get_server_traffic_not_found(client, auth_headers):
    """不存在的服务器返回 404"""
    response = client.get('/api/v1/traffic/99999', headers=auth_headers)
    assert response.status_code == 404


def test_update_server_traffic(client, auth_headers, test_server):
    """更新服务器流量限额"""
    response = client.post(
        f'/api/v1/traffic/{test_server}',
        json={'limit_gb': 500.0, 'reset_day': 15},
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.get_json()
    assert 'msg' in data or 'message' in data


def test_get_traffic_history(client, auth_headers, test_server):
    """获取流量历史数据"""
    response = client.get(
        f'/api/v1/traffic/{test_server}/history?days=7',
        headers=auth_headers,
    )
    assert response.status_code == 200
    data = response.get_json()
    assert 'data' in data
    assert isinstance(data['data'], list)


def test_traffic_requires_auth(client):
    """未认证时流量接口返回 401"""
    response = client.get('/api/v1/traffic/')
    assert response.status_code == 401


def test_public_traffic_history_accepts_full_21600_raw_window(client, test_server):
    response = client.get(f'/api/v1/traffic/public/{test_server}/history?days=1&limit=21600')
    assert response.status_code == 200
    assert response.get_json()['limit'] == 21600
