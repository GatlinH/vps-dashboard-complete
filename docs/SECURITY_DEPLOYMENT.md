# Production security baseline

This project does **not** require a specific edge server. Installers may choose Caddy, Nginx, a cloud load balancer, or the bundled static proxy. The security boundary is the same in all cases.

## Required deployment properties

- Exactly one HTTP(S) entrypoint is public, usually `:80` or `:443`.
- Flask/Gunicorn API binds to `127.0.0.1:5000` or a private container network only.
- MySQL and Redis are not internet-facing.
- `/api/v1/ops/*`, `/api/v1/telegram/*`, backup/export, account, and admin write routes require authenticated admin cookies/JWT.
- Public APIs expose only display-safe fields; raw tokens, agent keys, password hashes, encrypted secrets, and backup archives must never be returned unauthenticated.
- Generated install commands must pass secrets through POST responses or shell-quoted arguments, never through reusable query-string secrets.
- Production builds must pass `scripts/security-scan.py --include-dist` before release.

## Optional edge choices

Caddy/Nginx are recommended for TLS, compression, logging, and IP allowlists, but they are deployment choices rather than project requirements. If the bundled Python static proxy is used, keep the API and databases loopback/private and place firewall rules in front of non-dashboard ports.

## Verification

```bash
PUBLIC_URL=http://your-host API_LOCAL_URL=http://127.0.0.1:5000 deploy/security-check.sh
python3 scripts/security-scan.py --include-dist
```

Expected:

- Public frontend returns 200/301/302.
- Sensitive unauthenticated API probes return 401/403.
- Backend health works only locally/private.
- Security scanner reports `TOTAL_PROBLEMS 0`.
