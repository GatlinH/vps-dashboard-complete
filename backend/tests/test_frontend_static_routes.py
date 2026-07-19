from pathlib import Path

from app import create_app
from tests.conftest import _TEST_CONFIG


def test_frontend_routes_serve_assets_and_spa_without_shadowing_api(tmp_path, monkeypatch):
    frontend = tmp_path / "frontend-dist"
    (frontend / "assets").mkdir(parents=True)
    (frontend / "index.html").write_text("dashboard")
    (frontend / "admin.html").write_text("admin")
    (frontend / "assets" / "app-123.js").write_text("console.log('ok')")
    (frontend / "sw.js").write_text("self.skipWaiting()")
    (frontend / "manifest.webmanifest").write_text("{}")
    monkeypatch.setenv("FRONTEND_DIST_DIR", str(frontend))
    app = create_app(**_TEST_CONFIG, DISABLE_SCHEDULER=True)
    client = app.test_client()

    assert client.get("/").data == b"dashboard"
    assert client.get("/detail/42").data == b"dashboard"
    assert client.get("/admin.html").data == b"admin"
    assert client.get("/assets/app-123.js").headers["Cache-Control"] == "public, max-age=31536000, immutable"
    assert client.get("/sw.js").headers["Cache-Control"] == "no-cache"
    assert client.get("/api/not-a-route").status_code == 404
    assert client.get("/health").is_json
