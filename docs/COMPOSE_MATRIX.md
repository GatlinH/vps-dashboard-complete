# Docker Compose Usage Matrix

This project uses `docker-compose.yml` as the complete base stack. The other
Compose files are overrides and are not intended to be run by themselves.
Compose applies files from left to right, so later files replace or extend the
matching service settings from earlier files.

## Quick decision table

| If you want to... | Compose files and command |
|---|---|
| Run the normal Linux production deployment from GHCR images | `docker compose --env-file /etc/vps-dashboard/secrets.env -f docker-compose.yml up -d --no-build` |
| Keep using an older command that explicitly names the GHCR override | `docker compose --env-file /etc/vps-dashboard/secrets.env -f docker-compose.yml -f docker-compose.ghcr.yml up -d --no-build` (same result as base only) |
| Build the application image from the current checkout | `docker compose --env-file /etc/vps-dashboard/secrets.env -f docker-compose.yml -f docker-compose.build.yml up -d --build` |
| Put an Nginx frontend on port 4500 while keeping the API internal | `docker compose --env-file /etc/vps-dashboard/secrets.env -f docker-compose.yml -f docker-compose.frontend.yml --profile split-frontend up -d --no-build` |
| Build locally and use the split Nginx frontend | `docker compose --env-file /etc/vps-dashboard/secrets.env -f docker-compose.yml -f docker-compose.build.yml -f docker-compose.frontend.yml --profile split-frontend up -d --build` |
| Run the Dashboard containers with Docker Desktop on Windows | `$env:VPS_DASHBOARD_SECRETS_FILE = (Resolve-Path C:\VpsDashboard\secrets.env).Path; docker compose -f docker-compose.yml -f docker-compose.windows.yml up -d --no-build` |
| Run Watchtower on Windows as an explicit opt-in | Add `--profile watchtower` to the Windows command. This is normally unnecessary because the Windows update script pulls and recreates containers directly. |

For a private GHCR package, run `docker login ghcr.io` with a token that has
`read:packages` before using an image-based combination.

## File matrix

| File | Purpose | Services defined or overridden | Published host ports | Required configuration | How it combines |
|---|---|---|---|---|---|
| `docker-compose.yml` | Complete base stack and default Linux/GHCR production deployment. The API image contains both the Flask API and built frontend. | Defines `mysql`, one-shot `schema_init`, `redis`, `api`, `agent_consumer`, and `watchtower`; also defines `mysql_data`, `redis_data`, and `vps-network`. | `api`: `${PUBLIC_BIND_ADDRESS:-0.0.0.0}:4500` to container `5000`. `mysql`: `127.0.0.1:3306` to container `3306`. Redis and Watchtower are network-only. | Requires `/etc/vps-dashboard/secrets.env`. `WATCHTOWER_HTTP_API_TOKEN` is a hard Compose-time requirement. The secrets file must provide the application/database secrets described below. | Use alone for normal Linux deployment. Always place it first when applying an override. |
| `docker-compose.build.yml` | Development or emergency rollback using a locally built application image instead of GHCR. | Overrides `schema_init`, `api`, and `agent_consumer` to use `vps-dashboard-complete-backend:local`, built from `Dockerfile` in the repository root. | Adds no ports; inherits the base API and MySQL publications. | Adds no variables. It inherits all base requirements and requires the local source tree plus a working Docker build environment. | Use after the base: `-f docker-compose.yml -f docker-compose.build.yml`, normally with `--build`. It may be followed by the frontend override. |
| `docker-compose.frontend.yml` | Optional split frontend/edge deployment. Nginx serves the frontend and proxies API traffic instead of exposing the unified API container directly. | Overrides `api` by removing all published ports and retaining proxy trust. Defines profile-gated `frontend`. Gives `vps-network` the explicit name `vps-dashboard-network`. | `frontend`: `0.0.0.0:4500` to container `4500`. The base API port is removed. The base MySQL loopback port remains. | Inherits base requirements. `FRONTEND_DIST_HOST_DIR` is optional and defaults to `/var/lib/vps-dashboard/frontend-dist-live`; that directory must contain a frontend bundle matching the API image. | Use after the base and include `--profile split-frontend`; without the profile, `frontend` does not start and the API has no published HTTP port. Compatible with the build override when ordered base, build, frontend. |
| `docker-compose.ghcr.yml` | Backward-compatible placeholder for older deployment commands. GHCR images are already the base-file default. | Defines no services and changes nothing. | Adds or removes no ports. | Adds no variables; all base requirements still apply. | Optional no-op after the base. New commands should omit it. |
| `docker-compose.windows.yml` | Docker Desktop override for Windows hosts running Linux containers. Replaces Linux host data/log bind mounts with Docker named volumes and makes Watchtower opt-in. | Overrides `env_file` for `mysql`, `schema_init`, `redis`, `api`, and `agent_consumer`; overrides API/consumer storage mounts; adds `watchtower` profile `watchtower`; defines `dashboard_logs` and `dashboard_data`. | Adds no ports; inherits base `4500` and loopback `3306` publications. | `VPS_DASHBOARD_SECRETS_FILE` is a hard Compose-time requirement and must be an absolute path to the secrets file. `WATCHTOWER_HTTP_API_TOKEN` must also be available for base-file interpolation even when Watchtower is not started; the supplied Windows scripts read it from the secrets file into the process environment. | Use after the base: `-f docker-compose.yml -f docker-compose.windows.yml`. Do not use Linux-only `install.sh` or `update.sh`; use the PowerShell scripts documented in `WINDOWS_DEPLOYMENT.md`. Add `--profile watchtower` only to opt in to Watchtower. |

## Base services

| Service | Role | Port behavior |
|---|---|---|
| `mysql` | MySQL 8 persistent database using `mysql_data`. | Publishes `3306` only on host loopback. |
| `schema_init` | One-shot application container that waits for MySQL and Redis, then creates the current SQLAlchemy schema. | No published port. |
| `redis` | Persistent Redis cache/queue using `redis_data`; password authentication is enabled when `REDIS_PASSWORD` is non-empty. | No published port. |
| `api` | Gunicorn/Flask application plus unified static frontend. | Publishes container port `5000` as host port `4500`, unless the frontend override removes it. |
| `agent_consumer` | Consumes queued Agent metrics using the same application image and configuration. | No published port. |
| `watchtower` | Label-scoped, HTTP-triggered image updater. | Port `8080` is only reachable on the Compose network; it is not published to the host. |
| `frontend` | Optional Nginx static frontend and API proxy, defined only by the frontend override. | Publishes host port `4500`; requires the `split-frontend` profile. |

## Environment variables

### Required secrets

The base file loads `/etc/vps-dashboard/secrets.env` into the application,
database, and Redis services. A production secrets file should at least contain:

| Variable | Why it is needed |
|---|---|
| `SECRET_KEY` | Flask session/signing secret; use a random value of at least 32 characters. |
| `JWT_SECRET_KEY` | JWT signing secret; use a separate random value of at least 32 characters. |
| `MASTER_ENCRYPTION_KEY` | Encrypts sensitive application settings; use a random value of at least 32 characters. |
| `CORS_ORIGINS` | Production allowlist of HTTP(S) browser origins; wildcard `*` is rejected. |
| `MYSQL_ROOT_PASSWORD` | Initializes and administers the MySQL container. |
| `MYSQL_USER` | Application database user consumed by the backend configuration. |
| `MYSQL_PASSWORD` | Password for the application database user. |
| `MYSQL_DB` | Application database name; Compose defaults it to `vps_dashboard`, but it should be explicit in managed secrets. |
| `REDIS_PASSWORD` | Redis authentication password. Empty is supported by the container but is not appropriate for production. |
| `WATCHTOWER_HTTP_API_TOKEN` | Required by Compose interpolation and used by the API to authenticate update requests to Watchtower. |

The base file pins service discovery values such as `MYSQL_HOST=mysql`,
`MYSQL_PORT=3306`, `REDIS_HOST=redis`, `REDIS_PORT=6379`, and `REDIS_DB=0`, so
operators normally do not set those values themselves.

### Compose and deployment controls

These variables are optional unless marked required:

| Variable | Default or requirement | Effect |
|---|---|---|
| `VPS_DASHBOARD_SECRETS_FILE` | Required by the Windows override; `/etc/vps-dashboard/secrets.env` in `scripts/compose.sh` | Selects an alternate secrets file. |
| `PUBLIC_BIND_ADDRESS` | `0.0.0.0` | Host address used for the base API publication. Ignored for HTTP publication when the frontend override removes API ports. |
| `FRONTEND_DIST_HOST_DIR` | `/var/lib/vps-dashboard/frontend-dist-live` | Host directory mounted as the split frontend's Nginx document root. |
| `AGENT_RELEASE_HOST_DIR` | `/var/empty/vps-agent-releases` | Read-only host directory containing signed Agent releases. |
| `GUNICORN_BIND` | `0.0.0.0:5000` | API listen address inside the container. |
| `TRUST_PROXY` | `1` | Enables trusted reverse-proxy handling. |
| `FORCE_HTTPS`, `JWT_COOKIE_SECURE` | `0` | HTTPS and secure-cookie behavior; enable when the public route is HTTPS. |
| `JWT_COOKIE_SAMESITE` | `Lax` | JWT cookie SameSite policy. |
| `PROBE_TIMEOUT_S` | `5` | Probe timeout in seconds. |
| `PROBE_CACHE_TTL`, `PING_TARGETS_CACHE_TTL` | `15` | Probe and ping-target cache lifetimes. |
| `PING_TARGETS_JSON` | Empty | Explicit external ping targets; empty disables preset external targets. |
| `TILE_CACHE_TTL` | `86400` | Map tile cache lifetime. |
| `GUNICORN_WORKERS`, `GUNICORN_THREADS` | `1`, `4` | API process/thread concurrency. |
| `ADMIN_SETTINGS_FILE` | `/var/lib/vps-dashboard/admin-settings.json` | Persistent admin settings path. |
| `BREAKGLASS_USERNAMES` | Empty | Emergency administrator usernames. |
| `PUBLIC_OAUTH_PROVIDER_DISCOVERY` | `0` | Controls public OAuth provider discovery. |
| `AGENT_REQUIRE_TLS` | `1` | Requires TLS for Agent communication. |
| `AGENT_RELEASE_DIR`, `AGENT_RELEASE_VERSION`, `AGENT_ENROLLMENT_KEY` | Empty | Signed Agent release and optional enrollment controls. |
| `AGENT_PUSH_RATE_LIMIT`, `AGENT_POLL_RATE_LIMIT` | `60 per minute`, `120 per minute` | Agent endpoint limits. |
| `AGENT_METRICS_QUEUE_TIMEOUT`, `AGENT_METRICS_RETRY_SLEEP` | `5`, `1` | Agent consumer queue timing. |
| `AGENT_METRICS_ERROR_QUEUE` | `vps:agent:metrics_queue:error` | Failed metrics queue name. |
| `JWT_BLOCKLIST_FAIL_OPEN` | `0` | Controls authentication behavior if the JWT blocklist store fails. |

## Combination rules and caveats

1. Always list `docker-compose.yml` first. Overrides only describe their
   differences and do not define a runnable database/cache/application stack.
2. Use `--no-build` for GHCR deployments. Use `--build` when
   `docker-compose.build.yml` is present.
3. The frontend override needs both the file and `--profile split-frontend`.
   Merely adding the file removes the API's host port but does not start Nginx.
4. The split frontend's mounted distribution must match the backend version.
   For local builds, rebuild/provision that distribution as part of the same
   release.
5. The Windows override is for Docker Desktop in Linux-container mode. It does
   not convert the images to Windows containers.
6. `docker-compose.ghcr.yml` is intentionally empty. It exists only so older
   automation continues to parse and run.
