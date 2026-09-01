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

def test_write_mkstemp_failure_does_not_touch_existing_file(settings_env, monkeypatch):
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text("original")
    def fail_mkstemp(**kwargs):
        raise OSError("mkstemp failure")
    monkeypatch.setattr(app_settings.tempfile, "mkstemp", fail_mkstemp)
    with pytest.raises(OSError, match="mkstemp failure"):
        app_settings._write({"site": {"site_name": "replacement"}})
    assert settings_env.read_text() == "original"


def test_write_does_not_close_fd_after_fdopen_takes_ownership(settings_env, monkeypatch):
    def fail_rename(source, destination):
        raise OSError("simulated rename failure")

    def fail_close(fd):
        raise AssertionError(f"unexpected os.close({fd})")

    monkeypatch.setattr(app_settings.os, "rename", fail_rename)
    monkeypatch.setattr(app_settings.os, "close", fail_close)

    with pytest.raises(OSError, match="simulated rename failure"):
        app_settings._write({"site": {"site_name": "private"}})


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


def test_redacted_legacy_login_api_key_uses_explicit_metadata_without_placeholder(settings_env):
    encrypted = app_settings._crypto().encrypt("plain-text-secret")
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text(json.dumps({"login": {"api_key": encrypted}}))

    result = app_settings.get_admin_settings(redact=True)

    assert result["login"]["api_key_set"] is True
    assert result["login"]["api_key_masked"] == ""
    assert "api_key" not in result["login"]
    assert "******" not in json.dumps(result)
    assert "plain-text-secret" not in json.dumps(result)


def test_empty_api_key_update_preserves_existing_ciphertext(settings_env):
    app_settings.update_admin_settings("login", {"api_key": "secret-A"})
    original = json.loads(settings_env.read_text())["login"]["api_key"]
    app_settings.update_admin_settings("login", {"api_key": ""})
    stored = json.loads(settings_env.read_text())["login"]["api_key"]
    assert stored == original


def test_api_key_can_be_cleared_explicitly(settings_env):
    app_settings.update_admin_settings("login", {"api_key": "secret-A"})
    app_settings.update_admin_settings("login", {"api_key": "", "clear_api_key": True})
    stored = json.loads(settings_env.read_text())["login"]
    assert stored["api_key"] == ""
    assert stored["api_key_masked"] == ""


def test_redacted_login_api_key_returns_mask(settings_env):
    encrypted = app_settings._crypto().encrypt("plain-text-secret")
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text(
        json.dumps(
            {"login": {"api_key": encrypted, "api_key_masked": "plai****cret"}}
        )
    )

    result = app_settings.get_admin_settings(redact=True)

    assert result["login"]["api_key_masked"] == "plai****cret"
    assert result["login"]["api_key_set"] is True


def test_login_api_key_mask_round_trip_preserves_ciphertext(settings_env):
    app_settings.update_admin_settings("login", {"api_key": "secret-A"})
    original_ciphertext = json.loads(settings_env.read_text())["login"]["api_key"]
    masked = app_settings.get_admin_settings(redact=True)["login"]["api_key_masked"]

    app_settings.update_admin_settings("login", {"api_key": masked})

    stored_ciphertext = json.loads(settings_env.read_text())["login"]["api_key"]
    assert stored_ciphertext == original_ciphertext
    assert app_settings._crypto().decrypt(stored_ciphertext) == "secret-A"

def test_tampered_mask_is_ignored_and_rejected_on_write(settings_env):
    app_settings.update_admin_settings("login", {"api_key": "secret-A"})
    original = json.loads(settings_env.read_text())["login"]["api_key"]
    data = json.loads(settings_env.read_text())
    data["login"]["api_key_masked"] = "attacker-mask"
    settings_env.write_text(json.dumps(data))
    result = app_settings.get_admin_settings(redact=True)
    assert result["login"]["api_key_masked"] == "********"
    with pytest.raises(ValueError):
        app_settings.update_admin_settings("login", {"api_key": "bad**mask"})
    assert json.loads(settings_env.read_text())["login"]["api_key"] == original

def test_api_key_enabled_is_independent_of_secret_state(settings_env):
    app_settings.update_admin_settings("login", {"api_key": "secret-A", "api_key_enabled": False})
    result = app_settings.get_admin_settings(redact=True)["login"]
    assert result["api_key_set"] is True
    assert result["api_key_enabled"] is False

def test_legacy_api_key_get_put_round_trip_preserves_ciphertext(settings_env):
    encrypted = app_settings._crypto().encrypt("legacy-secret")
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text(json.dumps({"login": {"api_key": encrypted}}))
    result = app_settings.get_admin_settings(redact=True)
    app_settings.update_admin_settings("login", {"api_key_enabled": True})
    stored = json.loads(settings_env.read_text())["login"]
    assert stored["api_key"] == encrypted
    assert "******" not in settings_env.read_text()

def test_legacy_masked_placeholder_cannot_change_ciphertext(settings_env):
    encrypted = app_settings._crypto().encrypt("legacy-secret")
    settings_env.parent.mkdir(parents=True)
    settings_env.write_text(json.dumps({"login": {"api_key": encrypted}}))
    app_settings.update_admin_settings("login", {"api_key": "******"})
    assert json.loads(settings_env.read_text())["login"]["api_key"] == encrypted

def test_write_finally_permission_error_does_not_fail_success(settings_env, monkeypatch):
    real_unlink = app_settings.os.unlink
    calls = {"n": 0}
    def unlink(path):
        calls["n"] += 1
        if calls["n"] > 1:
            raise PermissionError("cleanup denied")
        return real_unlink(path)
    monkeypatch.setattr(app_settings.os, "unlink", unlink)
    app_settings._write({"site": {"site_name": "ok"}})


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
