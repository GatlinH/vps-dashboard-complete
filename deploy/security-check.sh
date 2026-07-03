#!/usr/bin/env bash
set -euo pipefail
PUBLIC_URL="${PUBLIC_URL:-http://127.0.0.1}"
API_LOCAL_URL="${API_LOCAL_URL:-http://127.0.0.1:5000}"

echo '== Listener check =='
ss -ltnp | sed 's/users:.*//g' | sort || true

echo; echo '== Local backend health =='
curl -fsS "$API_LOCAL_URL/health" >/dev/null && echo 'backend_health OK' || echo 'backend_health WARN'

echo; echo '== Public unauthenticated API boundary =='
for path in /api/v1/ops/settings/site /api/v1/ops/settings/site/backup /api/v1/telegram/config /api/v1/auth/me; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_URL$path" || true)
  printf '%-45s %s\n' "$path" "$code"
  case "$code" in 401|403) ;; *) echo "SECURITY_CHECK_FAIL unexpected status for $path: $code"; exit 1;; esac
done

echo; echo '== Public frontend =='
code=$(curl -sS -o /dev/null -w '%{http_code}' "$PUBLIC_URL/" || true)
printf '/ %-44s %s\n' "" "$code"
case "$code" in 200|301|302) ;; *) echo "SECURITY_CHECK_FAIL frontend status: $code"; exit 1;; esac

echo; echo 'SECURITY_CHECK_OK'
