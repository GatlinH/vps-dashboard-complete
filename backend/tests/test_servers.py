"""服务器 API 测试"""

from extensions import db
from models.models import Server


def test_list_servers_authenticated(client, auth_headers):
    """测试已认证用户可获取服务器列表"""
    response = client.get('/api/v1/servers/', headers=auth_headers)
    assert response.status_code == 200
    data = response.get_json()
    assert 'servers' in data or isinstance(data, list)


def test_create_server(client, auth_headers):
    """测试创建服务器"""
    payload = {
        'name': '测试服务器',
        'ip': '192.168.1.100',
        'location': '上海',
        'provider': 'Test Provider',
        'group': '测试组',
    }
    response = client.post('/api/v1/servers/', json=payload, headers=auth_headers)
    assert response.status_code in (200, 201)
    data = response.get_json()
    assert (
        data.get('name') == '测试服务器'
        or data.get('server', {}).get('name') == '测试服务器'
    )


def test_create_server_missing_required_field(client, auth_headers):
    """测试缺少必填字段时返回 400"""
    payload = {'location': '上海'}  # 缺少 name 和 ip
    response = client.post('/api/v1/servers/', json=payload, headers=auth_headers)
    assert response.status_code == 400


def test_get_server_not_found(client, auth_headers):
    """测试获取不存在的服务器返回 404"""
    response = client.get('/api/v1/servers/99999', headers=auth_headers)
    assert response.status_code == 404


def test_create_server_rejects_invalid_name_and_ip(client, auth_headers):
    resp_name = client.post(
        '/api/v1/servers/',
        json={'name': 'a', 'ip': '1.2.3.4'},
        headers=auth_headers,
    )
    assert resp_name.status_code == 400

    resp_ip = client.post(
        '/api/v1/servers/',
        json={'name': 'valid-name', 'ip': 'http://1.2.3.4/path'},
        headers=auth_headers,
    )
    assert resp_ip.status_code == 400


def test_public_detail_preserves_exact_agent_reported_cpu_model(app):
    cpu_model = "Intel(R) Xeon(R) Platinum 8573C CPU @ 2.30GHz (GenuineIntel)"
    with app.app_context():
        server = Server(
            name='public-cpu-model',
            ip='203.0.113.10',
            agent_config={'inventory_meta': {'cpu_model': cpu_model}},
        )
        db.session.add(server)
        db.session.commit()

        public_detail = server.to_dict(public_only=True)

    assert public_detail['cpu_model'] == cpu_model
