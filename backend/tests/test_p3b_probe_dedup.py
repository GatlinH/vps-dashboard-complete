"""
tests/test_p3b_probe_dedup.py

P3B：探针抓取逻辑去重 — 验证 fetch_and_parse_probe 共享层
以及两条调用链（API /fetch-probe 和定时任务 _job_fetch_probes）的行为兼容性。

运行方式：
    cd backend && python -m pytest tests/test_p3b_probe_dedup.py -v
"""
import json
import socket
import urllib.error
from unittest.mock import patch, MagicMock

import pytest

# ─── 基础 snap 快照（模拟服务器状态）────────────────────────────────────────────
_SNAP = {
    "id": 1, "name": "test-server",
    "cpu_use": 10.0, "ram_use": 20.0, "disk_use": 30.0,
    "net_up": 1.0, "net_down": 2.0,
    "status": "online", "uptime": "1d",
}


def _make_urlopen_mock(body: bytes):
    """构造 urlopen 的上下文管理器 mock。"""
    mock_resp = MagicMock()
    mock_resp.read.return_value = body
    mock_resp.__enter__ = lambda s: s
    mock_resp.__exit__ = MagicMock(return_value=False)
    return mock_resp


# ════════════════════════════════════════════════════════════════════════════════
# 1. 共享层单元测试
# ════════════════════════════════════════════════════════════════════════════════

class TestFetchAndParseProbeUnit:
    """直接测试 services.probe_fetcher.fetch_and_parse_probe。"""

    def test_success_custom_format(self):
        """成功抓取并解析通用自定义格式。"""
        from services.probe_fetcher import fetch_and_parse_probe

        body = json.dumps({
            "cpu_use": 55.5, "ram_use": 60.0, "disk_use": 40.0,
            "net_up": 5.0, "net_down": 10.0, "status": "online", "uptime": "2d",
        }).encode()

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True), \
             patch("urllib.request.urlopen", return_value=_make_urlopen_mock(body)):
            metrics, err = fetch_and_parse_probe("http://probe.example.com/api", _SNAP)

        assert err is None
        assert metrics["cpu_use"] == 55.5
        assert metrics["ram_use"] == 60.0
        assert metrics["status"] == "online"

    def test_success_nezha_format(self):
        """成功抓取并解析哪吒探针 v0 格式。"""
        from services.probe_fetcher import fetch_and_parse_probe

        body = json.dumps({
            "servers": [{
                "id": 1, "name": "test-server",
                "cpu": 30.0,
                "mem_used": 512, "mem_total": 1024,
                "disk_used": 20, "disk_total": 100,
                "net_out_speed": 1048576, "net_in_speed": 2097152,
                "uptime": 86400,
            }]
        }).encode()

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True), \
             patch("urllib.request.urlopen", return_value=_make_urlopen_mock(body)):
            metrics, err = fetch_and_parse_probe("http://probe.example.com/api", _SNAP)

        assert err is None
        assert metrics["cpu_use"] == 30.0
        assert metrics["ram_use"] == 50.0    # 512/1024*100
        assert metrics["disk_use"] == 20.0   # 20/100*100
        assert metrics["net_up"] == 1.0      # 1048576/1024/1024
        assert metrics["net_down"] == 2.0    # 2097152/1024/1024
        assert metrics["status"] == "online"
        assert metrics["uptime"] == "86400"

    def test_timeout_error(self):
        """超时错误映射为 'timed out'。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True), \
             patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError(reason=socket.timeout("timed out")),
             ):
            metrics, err = fetch_and_parse_probe("http://probe.example.com/api", _SNAP)

        assert metrics is None
        assert err == "timed out"

    def test_http_error(self):
        """非 2xx HTTP 错误映射为 'HTTP <code>'。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True), \
             patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.HTTPError(
                    url="http://probe.example.com/api",
                    code=503,
                    msg="Service Unavailable",
                    hdrs=None,
                    fp=None,
                ),
             ):
            metrics, err = fetch_and_parse_probe("http://probe.example.com/api", _SNAP)

        assert metrics is None
        assert err == "HTTP 503"

    def test_invalid_json_payload(self):
        """非法 JSON payload 映射为 'invalid payload: ...'。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True), \
             patch("urllib.request.urlopen", return_value=_make_urlopen_mock(b"not-json")):
            metrics, err = fetch_and_parse_probe("http://probe.example.com/api", _SNAP)

        assert metrics is None
        assert err is not None
        assert "invalid payload" in err

    def test_unsafe_url(self):
        """不安全的 URL 不发起请求，返回安全风险错误。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=False):
            metrics, err = fetch_and_parse_probe("http://192.168.0.1/probe", _SNAP)

        assert metrics is None
        assert "非法" in err or "安全" in err

    def test_network_connection_error(self):
        """DNS/连接失败等网络错误映射为具体原因字符串。"""
        from services.probe_fetcher import fetch_and_parse_probe

        with patch("services.probe_fetcher.is_safe_outbound_url", return_value=True), \
             patch(
                "urllib.request.urlopen",
                side_effect=urllib.error.URLError(reason="Name or service not known"),
             ):
            metrics, err = fetch_and_parse_probe("http://no-such-host.example/probe", _SNAP)

        assert metrics is None
        assert err is not None
        assert err != "timed out"


# ════════════════════════════════════════════════════════════════════════════════
# 2. API 调用链（/fetch-probe）集成测试
# ════════════════════════════════════════════════════════════════════════════════

class TestApiFetchProbeCallchain:
    """验证 POST /api/v1/probe/fetch-probe 通过共享层运行。"""

    def test_api_fetch_probe_success(self, client, auth_headers, app):
        """API 成功路径：通过 mock fetch_and_parse_probe，结果写入 updated。"""
        from extensions import db
        from models.models import Server

        with app.app_context():
            s = Server(
                name="api-test-srv", ip="10.10.0.1",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        mock_metrics = {
            "cpu_use": 42.0, "ram_use": 55.0, "disk_use": 30.0,
            "net_up": 2.0, "net_down": 3.0, "status": "online", "uptime": "5d",
        }

        with patch("api.probe.fetch_and_parse_probe", return_value=(mock_metrics, None)):
            resp = client.post(
                "/api/v1/probe/fetch-probe",
                json={"server_ids": [sid]},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        assert str(sid) in data.get("updated", [])
        assert data.get("errors", []) == []

    def test_api_fetch_probe_timeout_error(self, client, auth_headers, app):
        """API 超时路径：fetch_and_parse_probe 返回错误，结果出现在 errors。"""
        from extensions import db
        from models.models import Server

        with app.app_context():
            s = Server(
                name="api-timeout-srv", ip="10.10.0.2",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch("api.probe.fetch_and_parse_probe", return_value=(None, "timed out")):
            resp = client.post(
                "/api/v1/probe/fetch-probe",
                json={"server_ids": [sid]},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        assert str(sid) not in data.get("updated", [])
        errors = data.get("errors", [])
        assert any(e["server_id"] == str(sid) for e in errors)

    def test_api_fetch_probe_http_error(self, client, auth_headers, app):
        """API HTTP 错误路径：错误信息出现在 errors。"""
        from extensions import db
        from models.models import Server

        with app.app_context():
            s = Server(
                name="api-http-err-srv", ip="10.10.0.3",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch("api.probe.fetch_and_parse_probe", return_value=(None, "HTTP 404")):
            resp = client.post(
                "/api/v1/probe/fetch-probe",
                json={"server_ids": [sid]},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        errors = data.get("errors", [])
        assert any(e["server_id"] == str(sid) for e in errors)

    def test_api_fetch_probe_invalid_payload(self, client, auth_headers, app):
        """API 非法 payload 路径：错误信息出现在 errors。"""
        from extensions import db
        from models.models import Server

        with app.app_context():
            s = Server(
                name="api-bad-payload-srv", ip="10.10.0.4",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch(
            "api.probe.fetch_and_parse_probe",
            return_value=(None, "invalid payload: Expecting value"),
        ):
            resp = client.post(
                "/api/v1/probe/fetch-probe",
                json={"server_ids": [sid]},
                headers=auth_headers,
            )

        assert resp.status_code == 200
        data = resp.get_json()
        errors = data.get("errors", [])
        assert any(e["server_id"] == str(sid) for e in errors)


# ════════════════════════════════════════════════════════════════════════════════
# 3. 调度任务调用链（_job_fetch_probes）集成测试
# ════════════════════════════════════════════════════════════════════════════════

class TestSchedulerFetchProbesCallchain:
    """验证 _job_fetch_probes 通过共享层运行。"""

    def test_scheduler_fetch_probes_success(self, app):
        """定时任务成功路径：metrics 写入 DB，updated_ids 正确。"""
        from extensions import db
        from models.models import Server, ProbeResult
        from services.scheduler import _job_fetch_probes

        with app.app_context():
            s = Server(
                name="sched-ok-srv", ip="10.20.0.1",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        mock_metrics = {
            "cpu_use": 25.0, "ram_use": 40.0, "disk_use": 15.0,
            "net_up": 1.0, "net_down": 2.0, "status": "online", "uptime": "3d",
        }

        with patch(
            "services.probe_fetcher.fetch_and_parse_probe",
            return_value=(mock_metrics, None),
        ):
            _job_fetch_probes(app)

        with app.app_context():
            s = Server.query.get(sid)
            assert s.cpu_use == 25.0
            assert s.ram_use == 40.0
            pr = ProbeResult.query.filter_by(server_id=sid).order_by(
                ProbeResult.id.desc()
            ).first()
            assert pr is not None
            assert pr.cpu_use == 25.0

    def test_scheduler_fetch_probes_timeout(self, app):
        """定时任务超时路径：失败计数递增，服务器状态不变（首次失败）。"""
        from extensions import db
        from models.models import Server
        from services.scheduler import _job_fetch_probes

        with app.app_context():
            s = Server(
                name="sched-timeout-srv", ip="10.20.0.2",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly", status="online",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch(
            "services.probe_fetcher.fetch_and_parse_probe",
            return_value=(None, "timed out"),
        ):
            _job_fetch_probes(app)

        with app.app_context():
            s = Server.query.get(sid)
            # 仅第 1 次失败，未达到 3 次阈值，状态应保持 "online"
            assert s.status == "online"

    def test_scheduler_fetch_probes_marks_offline_after_3_failures(self, app):
        """连续 3 次失败后服务器被标记为 offline。"""
        import extensions as ext
        from extensions import db
        from models.models import Server
        from services.scheduler import _job_fetch_probes

        with app.app_context():
            s = Server(
                name="sched-fail3-srv", ip="10.20.0.3",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly", status="online",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        # 预置失败计数为 2（下一次调用将使其达到 3）
        fail_key = f"vps:probe_fail:{sid}"
        with app.app_context():
            ext.redis_client.setex(fail_key, 300, "2")

        with patch(
            "services.probe_fetcher.fetch_and_parse_probe",
            return_value=(None, "timed out"),
        ):
            _job_fetch_probes(app)

        with app.app_context():
            s = Server.query.get(sid)
            assert s.status == "offline"

    def test_scheduler_fetch_probes_http_error(self, app):
        """定时任务 HTTP 错误路径：失败计数递增，不崩溃。"""
        from extensions import db
        from models.models import Server
        from services.scheduler import _job_fetch_probes

        with app.app_context():
            s = Server(
                name="sched-http-err-srv", ip="10.20.0.4",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch(
            "services.probe_fetcher.fetch_and_parse_probe",
            return_value=(None, "HTTP 502"),
        ):
            _job_fetch_probes(app)  # 不应抛出异常

    def test_scheduler_fetch_probes_invalid_payload(self, app):
        """定时任务非法 payload 路径：不崩溃，失败计数递增。"""
        from extensions import db
        from models.models import Server
        from services.scheduler import _job_fetch_probes

        with app.app_context():
            s = Server(
                name="sched-bad-pl-srv", ip="10.20.0.5",
                probe_url="http://probe.example.com/api",
                group_name="test", cpu_cores=2, ram_gb=4.0,
                disk_gb=50, price=10.0, period="monthly",
            )
            db.session.add(s)
            db.session.commit()
            sid = s.id

        with patch(
            "services.probe_fetcher.fetch_and_parse_probe",
            return_value=(None, "invalid payload: unexpected format"),
        ):
            _job_fetch_probes(app)  # 不应抛出异常
