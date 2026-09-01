import json
import stat

import pytest

from middleware import rbac
from services import app_settings


@pytest.fixture
def settings_env(monkeypatch, tmp_path):
    settings_file = tmp_path / "private" / "admin-settings.json"
    monkeypatch.setenv("ADMIN_SETTINGS_FILE", str(settings_file))
    monkeypatch.setenv("MASTER_ENCRYPTION_KEY", "test-master-encryption-key")
    return settings_file


def test_write_uses_private_file_and_directory_permissions(settings_env):
    app_settings._write({"site": {"site_name": "private"}})

    assert stat.S_IMODE(settings_env.stat().st_mode) == 0o600
    assert stat.S_IMODE(settings_env.parent.stat().st_mode) == 0o700


def test_write_failure_does_not_truncate_existing_file(settings_env, monkeypatch):
    original = '{"site": {"site_name": "original"}}\n'
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text(original)

    def fail_rename(source, destination):
        raise OSError("simulated crash")

    monkeypatch.setattr(app_settings.os, "rename", fail_rename)

    with pytest.raises(OSError, match="simulated crash"):
        app_settings._write({"site": {"site_name": "replacement"}})

    assert settings_env.read_text() == original


def test_login_api_key_is_encrypted_at_rest(settings_env):
    app_settings.update_admin_settings("login", {"api_key": "plain-text-secret"})

    encrypted = app_settings._read_raw()["login"]["api_key"]
    assert encrypted != "plain-text-secret"
    assert app_settings._crypto().decrypt(encrypted) == "plain-text-secret"


def test_login_api_key_is_not_returned_as_plaintext(settings_env):
    section_data = app_settings.update_admin_settings(
        "login", {"api_key": "plain-text-secret"}
    )

    assert "plain-text-secret" not in str(section_data)


@pytest.mark.parametrize(
    ("unsafe_html", "forbidden"),
    [
        ('<img/src=x/onerror=alert(1)>', "onerror"),
        ('<a href="javascript:alert(1)">x</a>', "javascript:"),
    ],
)
def test_sanitize_html_removes_unsafe_content(unsafe_html, forbidden):
    assert forbidden not in app_settings._sanitize_html(unsafe_html).lower()


def test_sanitize_html_preserves_safe_paragraphs():
    assert app_settings._sanitize_html("<p>hello</p>") == "<p>hello</p>"


def test_crypto_rejects_missing_master_key(monkeypatch):
    monkeypatch.delenv("MASTER_ENCRYPTION_KEY", raising=False)

    with pytest.raises(ValueError, match="MASTER_ENCRYPTION_KEY"):
        app_settings._crypto()


def test_save_secret_rejects_missing_master_key(monkeypatch):
    monkeypatch.delenv("MASTER_ENCRYPTION_KEY", raising=False)

    with pytest.raises(ValueError, match="MASTER_ENCRYPTION_KEY"):
        app_settings._save_secret({}, {"secret": "value"}, "secret", "masked", "encrypted")


def test_read_raw_rejects_invalid_json(settings_env):
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text("not-json")

    with pytest.raises(ValueError):
        app_settings._read_raw()


def test_read_raw_rejects_non_object_root(settings_env):
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text(json.dumps([1, 2, 3]))

    with pytest.raises(ValueError):
        app_settings._read_raw()


@pytest.mark.parametrize(
    ("url", "expected"),
    [
        ("javascript:alert(1)", ""),
        ('https://example.com/a"b', ""),
        ("https://example.com/", "https://example.com/"),
        ("http://example.com/", ""),
        ("/local/path", "/local/path"),
    ],
)
def test_sanitize_url_uses_https_allowlist(url, expected):
    assert app_settings._sanitize_url(url) == expected


def test_owner_required_requires_fresh_jwt(monkeypatch):
    verify = pytest.importorskip("unittest.mock").Mock()
    monkeypatch.setattr(rbac, "verify_jwt_in_request", verify)
    monkeypatch.setattr(rbac, "get_jwt", lambda: {"role": rbac.OWNER_ROLE})

    wrapped = rbac.owner_required(lambda: "ok")

    assert wrapped() == "ok"
    verify.assert_called_once_with(fresh=True)
