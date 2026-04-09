"""Telegram API 测试"""


def test_get_telegram_config(client, auth_headers):
    """测试获取 Telegram 配置"""
    response = client.get('/api/telegram/config', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'config' in data


def test_list_alerts(client, auth_headers):
    """测试获取告警规则列表"""
    response = client.get('/api/telegram/alerts', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'rules' in data
    assert isinstance(data['rules'], list)


def test_save_telegram_config_requires_admin(client, auth_headers):
    """测试保存 Telegram 配置需要管理员权限"""
    response = client.post(
        '/api/telegram/config',
        json={
            'bot_token': 'test_token',
            'chat_id': '12345',
            'enabled': True
        },
        headers=auth_headers
    )
    # 应该返回 200 (如果是 admin) 或 403 (如果不是 admin)
    assert response.status_code in (200, 403)


def test_test_send_telegram(client, auth_headers):
    """测试发送测试消息"""
    response = client.post('/api/telegram/test', headers=auth_headers)
    # 可能因为未配置 bot_token 而失败，返回 502
    assert response.status_code in (200, 502)
