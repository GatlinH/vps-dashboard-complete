import json


def test_public_server_detail_aggregates_detail_payload(app, test_server, monkeypatch):
    cached = {}

    class FakeRedis:
        def get(self, key):
            return cached.get(key)

        def setex(self, key, ttl, value):
            assert ttl == 5
            cached[key] = value

    monkeypatch.setattr("extensions.redis_client", FakeRedis())

    client = app.test_client()
    response = client.get(f"/api/v1/servers/public/{test_server}/detail?days=1")

    assert response.status_code == 200
    payload = response.get_json()
    assert set(payload) == {
        "server", "live", "history", "resource_timeline", "process_history",
        "traffic", "ping_targets", "ping_history",
    }
    assert payload["server"]["id"] == test_server
    assert payload["live"]["server_id"] == test_server
    assert payload["history"]["days"] == 1
    assert payload["history"]["bucket_minutes"] == 5
    assert payload["history"]["limit"] == 288
    assert isinstance(payload["resource_timeline"], list)
    assert isinstance(payload["process_history"], list)
    assert payload["traffic"]["id"] == test_server

    cached_payload = json.loads(next(iter(cached.values())))
    assert cached_payload == payload


def test_public_server_detail_realtime_contract(app, test_server):
    response = app.test_client().get(
        f"/api/v1/servers/public/{test_server}/detail?days=0"
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["history"]["days"] == 1
    assert payload["history"]["limit"] == 3600
    assert payload["ping_history"]["hours"] == 6
