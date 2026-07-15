#!/usr/bin/env bash
# Run Docker Compose with the dashboard secrets file without exposing values.
set -Eeuo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SECRETS_FILE="${VPS_DASHBOARD_SECRETS_FILE:-/etc/vps-dashboard/secrets.env}"
[[ -r "${SECRETS_FILE}" ]] || { echo "Secrets file is not readable: ${SECRETS_FILE}" >&2; exit 1; }
exec docker compose --env-file "${SECRETS_FILE}" -f "${REPO_DIR}/docker-compose.yml" "$@"
