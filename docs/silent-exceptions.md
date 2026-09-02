# Silent exception gate

Ruff is configured in `backend/ruff.toml` for Python 3.11 and scans production code under `backend/`; virtualenvs, migrations, caches, and tests are excluded. The repository-root `scripts/check-silent-exceptions.py` anchors paths independently of the current working directory and uses `.github/quality/silent-exception-baseline.json` as a ratchet.
