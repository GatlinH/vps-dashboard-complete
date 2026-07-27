"""Regression tests: production must never fall back to usable weak secrets."""
import pytest

from config import _is_strong_password


def test_installer_style_random_hex_is_accepted_as_strong_password():
    assert _is_strong_password("a" * 32) is True
    assert _is_strong_password("A1!secure-password-value") is True
    assert _is_strong_password("vps_pass") is False


def test_production_rejects_missing_or_legacy_weak_secrets(monkeypatch):
    monkeypatch.delenv("FLASK_ENV", raising=False)
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    monkeypatch.setenv("MYSQL_PASSWORD", "vps_pass")
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    from config import _validate_production_secrets
    with pytest.raises(SystemExit) as exc:
        _validate_production_secrets()
    assert exc.value.code == 1


def test_development_skips_production_secret_gate(monkeypatch):
    monkeypatch.setenv("FLASK_ENV", "development")
    monkeypatch.delenv("SECRET_KEY", raising=False)
    monkeypatch.delenv("JWT_SECRET_KEY", raising=False)
    monkeypatch.delenv("MYSQL_PASSWORD", raising=False)
    from config import _validate_production_secrets
    _validate_production_secrets()
