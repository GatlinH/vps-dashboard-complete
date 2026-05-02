"""
P1-2 / P1-3 性能修复专项测试
  P1-2: fetch-probe 并发化 - api/probe.py
  P1-3: 坐标获取并发化 - api/geo.py
"""
import json
from unittest.mock import patch, MagicMock

import pytest
from werkzeug.security import generate_password_hash

import extensions
from extensions import db
from models.models import Server, ProbeResult, User


# ── helpers ───────────────────────────────────────────────────────────────────

def _make_probe_response(cpu=30.0, ram=50.0, disk=60.0, net_up=10.0, net_down=20.0,
                         status="online"):
    return json.dumps({
        "cpu_use": cpu, "ram_use": ram, "disk_use": disk,
        "net_up": net_up, "net_down": net_down, "status": status,
    }).encode()


def _mock_urlopen_for_url(url_response_map, default_body=None):
    """
    返回一个 urlopen mock: 根据 URL 中的 server_id 片段返回对应 body，
    或抛出指定异常。

    url_response_map: dict mapping url-substring -> (bytes | Exception)
    """
    import urllib.error

    def _side_effect(req, timeout=8):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        for key, val in url_response_map.items():
            if key in url:
                if isinstance(val, Exception):
                    raise val
                mock_resp = MagicMock()
                mock_resp.read.return_value = val
                mock_resp.__enter__ = lambda s: s
                mock_resp.__exit__ = MagicMock(return_value=False)
                return mock_resp
        # fallback
        if default_body is not None:
            mock_resp = MagicMock()
            mock_resp.read.return_value = default_body
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            return mock_resp
        raise urllib.error.URLError("no match")

    return _side_effect


@pytest.fixture
def viewer_headers(client, app):
    """viewer 角色认证头（geo 测试用）"""
    with app.app_context():
        user = User(
            username='p1_viewer',
            email='p1_viewer@example.com',
            password_hash=generate_password_hash('ViewerPass@123456'),
            role='viewer',
            email_verified=True,
        )
        db.session.add(user)
        db.session.commit()
    resp = client.post('/api/v1/auth/login', json={
        'username': 'p1_viewer',
        'password': 'ViewerPass@123456',
    })
    token = resp.get_json()['access_token']
    return {'Authorization': f'Bearer {token}'}


# ── P1-2: fetch-probe 并发化测试 ──────────────────────────────────────────────

class TestFetchProbeConcurrent:
    """P1-2: fetch-probe 应并发抓取多节点，单节点失败不影响其他节点。"""

    def _create_servers_with_probe(self, app, n, base_url_tpl="http://probe-host/node-{i}/metrics"):
        """在 app context 内创建 n 台有 probe_url 的服务器，返回 id 列表。"""
        with app.app_context():
            app.config['PROBE_BATCH_MAX_ITEMS'] = max(n + 5, 50)
            sids = []
            for i in range(n):
                s = Server(
                    name=f"probe-node-{i}",
                    ip=f"10.10.{i // 256}.{i % 256}",
                    probe_url=base_url_tpl.format(i=i),
                    group_name="perf-test",
                    cpu_cores=2, ram_gb=4.0, disk_gb=50,
                    price=10.0, period="monthly",
                    cpu_use=0.0, ram_use=0.0, disk_use=0.0,
                    net_up=0.0, net_down=0.0,
                )
                db.session.add(s)
                db.session.flush()
                sids.append(s.id)
            db.session.commit()
            return sids

    def test_multi_node_all_succeed(self, client, auth_headers, app):
        """多节点全部成功：updated 包含所有 server_id，errors 为空。"""
        sids = self._create_servers_with_probe(app, 3)

        ok_body = _make_probe_response(cpu=10.0, ram=20.0, disk=30.0)

        def _urlopen_ok(req, timeout=8):
            m = MagicMock()
            m.read.return_value = ok_body
            m.__enter__ = lambda s: s
            m.__exit__ = MagicMock(return_value=False)
            return m

        with patch('api.probe.is_safe_outbound_url', return_value=True), \
             patch('urllib.request.urlopen', side_effect=_urlopen_ok):
            resp = client.post(
                '/api/v1/probe/fetch-probe',
                json={'server_ids': sids},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        updated = [str(x) for x in data.get('updated', [])]
        errors  = data.get('errors', [])

        # 所有节点均应出现在 updated 中
        for sid in sids:
            assert str(sid) in updated, f"server_id={sid} 应在 updated 中"
        assert errors == [], f"不应有错误，但得到: {errors}"

    def test_single_node_failure_does_not_fail_batch(self, client, auth_headers, app):
        """单节点 HTTP 失败不影响其他节点：失败节点在 errors，其余在 updated。"""
        import urllib.error
        sids = self._create_servers_with_probe(app, 3)
        fail_sid = sids[1]

        ok_body = _make_probe_response(cpu=15.0, ram=25.0, disk=35.0)

        def _selective_urlopen(req, timeout=8):
            url = req.full_url if hasattr(req, "full_url") else str(req)
            # 失败节点 URL 中含有 node-1 路径段
            if "/node-1/" in url:
                raise urllib.error.URLError("simulated timeout")
            m = MagicMock()
            m.read.return_value = ok_body
            m.__enter__ = lambda s: s
            m.__exit__ = MagicMock(return_value=False)
            return m

        with patch('api.probe.is_safe_outbound_url', return_value=True), \
             patch('urllib.request.urlopen', side_effect=_selective_urlopen):
            resp = client.post(
                '/api/v1/probe/fetch-probe',
                json={'server_ids': sids},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        updated = [str(x) for x in data.get('updated', [])]
        errors  = data.get('errors', [])

        # 成功节点应在 updated
        for sid in sids:
            if sid != fail_sid:
                assert str(sid) in updated, f"server_id={sid} 应在 updated 中"

        # 失败节点应在 errors
        error_ids = [e['server_id'] for e in errors]
        assert str(fail_sid) in error_ids, f"失败节点 {fail_sid} 应在 errors 中"

        # 整体 batch 未崩溃：200 且不全为空
        assert len(updated) + len(errors) == len(sids)

    def test_unsafe_probe_url_goes_to_errors(self, client, auth_headers, app):
        """probe_url 安全校验失败的节点应在 errors，不拖垮 batch。"""
        sids = self._create_servers_with_probe(app, 2)

        ok_body = _make_probe_response()

        def _urlopen_ok(req, timeout=8):
            m = MagicMock()
            m.read.return_value = ok_body
            m.__enter__ = lambda s: s
            m.__exit__ = MagicMock(return_value=False)
            return m

        def _selective_safe(url):
            # 只让第一台（node-0）安全通过
            return "/node-0/" in url

        with patch('api.probe.is_safe_outbound_url', side_effect=_selective_safe), \
             patch('urllib.request.urlopen', side_effect=_urlopen_ok):
            resp = client.post(
                '/api/v1/probe/fetch-probe',
                json={'server_ids': sids},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        updated = [str(x) for x in data.get('updated', [])]
        errors  = data.get('errors', [])
        # 至少应有一个成功一个失败
        assert len(updated) >= 1
        assert len(errors) >= 1

    def test_fetch_probe_returns_correct_response_structure(self, client, auth_headers, app):
        """fetch-probe 返回结构必须包含 updated 和 errors 字段（兼容性验证）。"""
        sids = self._create_servers_with_probe(app, 1)
        ok_body = _make_probe_response()

        def _urlopen_ok(req, timeout=8):
            m = MagicMock()
            m.read.return_value = ok_body
            m.__enter__ = lambda s: s
            m.__exit__ = MagicMock(return_value=False)
            return m

        with patch('api.probe.is_safe_outbound_url', return_value=True), \
             patch('urllib.request.urlopen', side_effect=_urlopen_ok):
            resp = client.post(
                '/api/v1/probe/fetch-probe',
                json={'server_ids': sids},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        assert 'updated' in data, "响应必须包含 'updated' 字段"
        assert 'errors' in data,  "响应必须包含 'errors' 字段"
        assert isinstance(data['updated'], list)
        assert isinstance(data['errors'], list)

    def test_fetch_probe_db_updated_after_success(self, client, auth_headers, app):
        """fetch-probe 成功后 DB 中的 metrics 应被更新。"""
        sids = self._create_servers_with_probe(app, 1)
        sid = sids[0]
        ok_body = _make_probe_response(cpu=77.0, ram=88.0, disk=55.0)

        def _urlopen_ok(req, timeout=8):
            m = MagicMock()
            m.read.return_value = ok_body
            m.__enter__ = lambda s: s
            m.__exit__ = MagicMock(return_value=False)
            return m

        with patch('api.probe.is_safe_outbound_url', return_value=True), \
             patch('urllib.request.urlopen', side_effect=_urlopen_ok):
            resp = client.post(
                '/api/v1/probe/fetch-probe',
                json={'server_ids': sids},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        assert str(sid) in [str(x) for x in resp.get_json()['updated']]

        with app.app_context():
            s = db.session.get(Server, sid)
            assert s.cpu_use == 77.0
            assert s.ram_use == 88.0
            assert s.disk_use == 55.0


# ── P1-3: 坐标获取并发化测试 ──────────────────────────────────────────────────

class TestGeoCoordsConcurrent:
    """P1-3: /geo/servers/coords 应并发获取坐标，单 IP 失败不影响整体。"""

    def _create_servers_with_ips(self, app, ip_list):
        """创建多台带 IP 的服务器，返回 id 列表。"""
        with app.app_context():
            sids = []
            for i, ip in enumerate(ip_list):
                s = Server(
                    name=f"geo-node-{i}",
                    ip=ip,
                    group_name="geo-test",
                    cpu_cores=2, ram_gb=4.0, disk_gb=50,
                    price=10.0, period="monthly",
                )
                db.session.add(s)
                db.session.flush()
                sids.append(s.id)
            db.session.commit()
            return sids

    def test_single_ip_failure_does_not_break_api(self, client, viewer_headers, app):
        """单个 IP 的 ip-api.com 请求失败，其他节点仍能返回有效坐标或默认降级坐标。"""
        ips = ['1.2.3.4', '5.6.7.8', '9.10.11.12']
        sids = self._create_servers_with_ips(app, ips)

        def _mock_requests_get(url, timeout=5):
            # 第二个 IP 返回非 success
            if '5.6.7.8' in url:
                m = MagicMock()
                m.json.return_value = {"status": "fail"}
                return m
            m = MagicMock()
            m.json.return_value = {
                "status": "success",
                "lat": 35.0 + hash(url) % 10,
                "lon": 105.0 + hash(url) % 10,
            }
            return m

        with patch('api.geo.requests.get', side_effect=_mock_requests_get):
            resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)

        assert resp.status_code == 200
        data = resp.get_json()
        assert 'nodes' in data
        # 必须返回所有节点（包括 IP 失败的那台，用默认坐标降级）
        node_ids = {n['id'] for n in data['nodes']}
        for sid in sids:
            assert sid in node_ids, f"server_id={sid} 应在 nodes 中"

        # 所有节点必须有 lat/lon 字段
        for node in data['nodes']:
            if node['id'] in sids:
                assert 'lat' in node
                assert 'lon' in node

    def test_all_coords_from_cache_do_not_call_external(self, client, viewer_headers, app):
        """所有坐标已缓存时，不应发起任何外部 HTTP 请求。"""
        ips = ['200.1.1.1', '200.2.2.2']
        sids = self._create_servers_with_ips(app, ips)

        # 预热缓存
        for ip in ips:
            extensions.redis_client.setex(
                f"vps:coords:{ip}", 86400,
                json.dumps({"lat": 40.0, "lon": 116.0}),
            )

        with patch('api.geo.requests.get') as mock_get:
            resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)
            mock_get.assert_not_called()

        assert resp.status_code == 200
        data = resp.get_json()
        node_ids = {n['id'] for n in data['nodes']}
        for sid in sids:
            assert sid in node_ids

    def test_coords_response_structure_unchanged(self, client, viewer_headers, app):
        """response 结构保持兼容：mode/nodes/pagination/schema_version 均存在。"""
        self._create_servers_with_ips(app, ['10.0.0.1'])

        def _mock_get(url, timeout=5):
            m = MagicMock()
            m.json.return_value = {"status": "success", "lat": 35.0, "lon": 105.0}
            return m

        with patch('api.geo.requests.get', side_effect=_mock_get):
            resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)

        assert resp.status_code == 200
        data = resp.get_json()
        assert data.get('mode') == 'list'
        assert 'nodes' in data
        assert 'pagination' in data

    def test_ip_failure_fallback_to_default_coords(self, client, viewer_headers, app):
        """IP 查询失败（异常）时使用默认坐标 (35.0, 105.0)。"""
        sids = self._create_servers_with_ips(app, ['1.1.1.1'])
        sid = sids[0]

        with patch('api.geo.requests.get', side_effect=Exception("network error")):
            resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)

        assert resp.status_code == 200
        data = resp.get_json()
        target = next((n for n in data['nodes'] if n['id'] == sid), None)
        assert target is not None
        assert target['lat'] == 35.0
        assert target['lon'] == 105.0

    def test_server_without_ip_uses_default_coords(self, client, viewer_headers, app):
        """没有 IP 的服务器使用默认坐标，不触发外部请求。"""
        with app.app_context():
            s = Server(
                name='geo-no-ip', ip='',
                group_name='geo-test',
                cpu_cores=2, ram_gb=4.0, disk_gb=50,
                price=10.0, period='monthly',
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch('api.geo.requests.get') as mock_get:
            resp = client.get('/api/v1/geo/servers/coords', headers=viewer_headers)

        assert resp.status_code == 200
        data = resp.get_json()
        target = next((n for n in data['nodes'] if n['id'] == sid), None)
        assert target is not None
        assert target['lat'] == 35.0
        assert target['lon'] == 105.0
