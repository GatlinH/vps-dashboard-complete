#!/usr/bin/env bash
# Install/register the dashboard host as the readonly master Agent node.
# Works with both source-build compose and GHCR/Watchtower compose overrides.

set -Eeuo pipefail

SECRETS_FILE="${SECRETS_FILE:-/etc/vps-dashboard/secrets.env}"
REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
AGENT_DIR="${AGENT_DIR:-/opt/vps-agent}"
AGENT_ENV="${AGENT_ENV:-${AGENT_DIR}/agent.env}"
AGENT_INTERVAL="${AGENT_INTERVAL:-2}"
AGENT_API_ROOT="${AGENT_API_ROOT:-http://127.0.0.1:5000}"
AUTO_INSTALL_AGENT="${AUTO_INSTALL_AGENT:-1}"
AUTO_AGENT_NAME="${AUTO_AGENT_NAME:-}"
AUTO_AGENT_HOST_IP="${AUTO_AGENT_HOST_IP:-}"

log_info() { echo "[INFO] $*"; }
log_ok() { echo "[OK] $*"; }
log_warn() { echo "[WARN] $*"; }
die() { echo "[ERROR] $*" >&2; exit 1; }

if [[ "${AUTO_INSTALL_AGENT}" != "1" ]]; then
  log_warn "AUTO_INSTALL_AGENT=${AUTO_INSTALL_AGENT}，跳过本机 Agent 自动安装。"
  exit 0
fi

[[ ${EUID} -eq 0 ]] || die "请以 root 身份运行：sudo ./scripts/install-master-agent.sh"
[[ -f "${SECRETS_FILE}" ]] || die "Secrets 文件不存在：${SECRETS_FILE}"
[[ -d "${REPO_DIR}" ]] || die "项目目录不存在：${REPO_DIR}"
[[ -f "${REPO_DIR}/scripts/vps-agent.py" ]] || die "缺少 Agent 模板：${REPO_DIR}/scripts/vps-agent.py"
command -v docker >/dev/null 2>&1 || die "docker 命令不可用"
docker compose version >/dev/null 2>&1 || die "docker compose plugin 不可用"

cd "${REPO_DIR}"

compose_args=(--env-file "${SECRETS_FILE}" -f docker-compose.yml)
if [[ -n "${COMPOSE_FILES:-}" ]]; then
  compose_args=(--env-file "${SECRETS_FILE}")
  IFS=':' read -r -a _files <<< "${COMPOSE_FILES}"
  for f in "${_files[@]}"; do
    [[ -n "${f}" ]] && compose_args+=(-f "${f}")
  done
else
  [[ -f docker-compose.ghcr.yml ]] && compose_args+=(-f docker-compose.ghcr.yml)
  [[ -f docker-compose.local.yml ]] && compose_args+=(-f docker-compose.local.yml)
fi

host_ip="${AUTO_AGENT_HOST_IP}"
if [[ -z "${host_ip}" ]]; then
  host_ip="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
fi
if [[ -z "${host_ip}" ]]; then
  host_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
fi
[[ -n "${host_ip}" ]] || host_ip="127.0.0.1"

mkdir -p "${AGENT_DIR}"
chmod 700 "${AGENT_DIR}"
install -m 0755 "${REPO_DIR}/scripts/vps-agent.py" "${AGENT_DIR}/agent.py"

log_info "等待 API 容器就绪..."
ready=0
for _ in {1..45}; do
  if docker compose "${compose_args[@]}" exec -T -e DISABLE_SCHEDULER=1 api python - <<'PY' >/dev/null 2>&1
from app import create_app
app = create_app()
print('ok')
PY
  then
    ready=1
    break
  fi
  sleep 2
done
[[ "${ready}" == "1" ]] || die "API 容器未就绪，无法自动登记本机 Agent。"

existing_agent_uuid=""
existing_agent_key=""
existing_server_id=""
if [[ -f "${AGENT_ENV}" ]]; then
  existing_agent_uuid="$(grep -E '^AGENT_UUID=' "${AGENT_ENV}" | tail -1 | cut -d= -f2- || true)"
  existing_agent_key="$(grep -E '^AGENT_KEY=' "${AGENT_ENV}" | tail -1 | cut -d= -f2- || true)"
  existing_server_id="$(grep -E '^SERVER_ID=' "${AGENT_ENV}" | tail -1 | cut -d= -f2- || true)"
fi

provision_json="$(mktemp /tmp/vps-dashboard-agent-provision.XXXXXX.json)"
trap 'rm -f "${provision_json}"' EXIT

log_info "创建/复用本机主控节点并生成 Agent 凭据..."
HOST_IP="${host_ip}" \
MASTER_NAME="${AUTO_AGENT_NAME}" \
EXISTING_AGENT_UUID="${existing_agent_uuid}" \
EXISTING_AGENT_KEY="${existing_agent_key}" \
EXISTING_SERVER_ID="${existing_server_id}" \
docker compose "${compose_args[@]}" exec -T \
  -e DISABLE_SCHEDULER=1 \
  -e HOST_IP -e MASTER_NAME -e EXISTING_AGENT_UUID -e EXISTING_AGENT_KEY -e EXISTING_SERVER_ID \
  api python - <<'PY' > "${provision_json}"
import contextlib
import json
import os
import secrets
import uuid as uuidlib
from datetime import datetime, timezone

from werkzeug.security import check_password_hash, generate_password_hash

from app import create_app
from extensions import db
import extensions
from models.models import Server

host_ip = (os.environ.get('HOST_IP') or '').strip() or '127.0.0.1'
master_name = (os.environ.get('MASTER_NAME') or '').strip()

app = create_app()
with app.app_context():
    servers = Server.query.order_by(Server.id.asc()).all()
    server = None
    for item in servers:
        cfg = item.agent_config if isinstance(item.agent_config, dict) else {}
        if cfg.get('install_role') == 'master' or cfg.get('is_master') is True:
            server = item
            break
    if server is None and host_ip:
        server = Server.query.filter_by(ip=host_ip).first()
    if server is None and len(servers) == 1:
        server = servers[0]
    if server is None:
        server = Server(
            name=master_name or '主控节点',
            ip=host_ip,
            group_name='主控',
            flag='🧭',
            location='',
            cpu_cores=0,
            ram_gb=0,
            disk_gb=0,
            bandwidth='待 Agent 回填',
            provider='local-master',
            tags=['master', 'agent', 'auto-installed'],
            status='unknown',
            agent_config={},
        )
        db.session.add(server)
        db.session.flush()

    if master_name and server.name != master_name:
        server.name = master_name
    elif not server.name:
        server.name = '主控节点'
    if host_ip and (not server.ip or server.ip in {'127.0.0.1', 'localhost'}):
        server.ip = host_ip
    if not server.group_name or server.group_name == '默认分组':
        server.group_name = '主控'
    if not server.flag or server.flag == '🌐':
        server.flag = '🧭'
    if not server.provider:
        server.provider = 'local-master'

    cfg = dict(server.agent_config or {})
    cfg['install_role'] = 'master'
    cfg['is_master'] = True
    cfg['display_role'] = '主控节点'
    cfg['managed_by_install'] = True
    cfg['readonly'] = True
    caps = dict(cfg.get('capabilities') or {})
    caps.update({'exec': False, 'terminal': False, 'file_list': False})
    cfg['capabilities'] = caps
    server.agent_config = cfg

    if not server.uuid:
        server.uuid = str(uuidlib.uuid4())

    existing_key = os.environ.get('EXISTING_AGENT_KEY') or ''
    existing_uuid = os.environ.get('EXISTING_AGENT_UUID') or ''
    existing_sid = str(os.environ.get('EXISTING_SERVER_ID') or '')
    can_reuse = bool(
        existing_key and existing_uuid == server.uuid and existing_sid == str(server.id)
        and server.agent_key_hash and check_password_hash(server.agent_key_hash, existing_key)
    )
    if can_reuse:
        raw_key = existing_key
        rotated = False
    else:
        raw_key = secrets.token_urlsafe(32)
        server.agent_key_hash = generate_password_hash(raw_key)
        server.agent_key_prev_hash = None
        server.agent_key_prev_expires_at = None
        server.agent_key_created_at = datetime.now(timezone.utc)
        rotated = True

    db.session.commit()
    with contextlib.suppress(Exception):
        if extensions.redis_client:
            extensions.redis_client.delete('servers:list:public:v1', 'servers:list:admin:v1')
    print(json.dumps({
        'server_id': server.id,
        'server_name': server.name,
        'uuid': server.uuid,
        'agent_key': raw_key,
        'rotated': rotated,
        'host_ip': host_ip,
    }, ensure_ascii=False))
PY

python3 - "${provision_json}" "${AGENT_ENV}" "${AGENT_INTERVAL}" "${AGENT_API_ROOT}" <<'PY'
import json
import os
import sys

src, dst, interval, api_root = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
raw = open(src, 'r', encoding='utf-8').read().splitlines()
d = None
for line in reversed(raw):
    line = line.strip()
    if not line.startswith('{'):
        continue
    try:
        candidate = json.loads(line)
    except json.JSONDecodeError:
        continue
    if 'agent_key' in candidate and 'uuid' in candidate:
        d = candidate
        break
if d is None:
    raise SystemExit('provision output did not contain agent credentials JSON')
content = '\n'.join([
    f'API_ROOT={api_root.rstrip("/")}',
    f'AGENT_UUID={d["uuid"]}',
    f'AGENT_KEY={d["agent_key"]}',
    f'SERVER_ID={d["server_id"]}',
    f'INTERVAL={interval}',
    '',
])
os.makedirs(os.path.dirname(dst), exist_ok=True)
fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as f:
    f.write(content)
print(json.dumps({
    'server_id': d['server_id'],
    'server_name': d['server_name'],
    'host_ip': d['host_ip'],
    'rotated': d['rotated'],
}, ensure_ascii=False))
PY
chmod 600 "${AGENT_ENV}"

cat > /etc/systemd/system/vps-agent.service <<EOF
[Unit]
Description=VPS Readonly Metrics Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${AGENT_ENV}
ExecStart=/usr/bin/python3 ${AGENT_DIR}/agent.py
Restart=always
RestartSec=5
User=root
WorkingDirectory=${AGENT_DIR}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now vps-agent.service >/dev/null
systemctl restart vps-agent.service
sleep 3
if systemctl is-active --quiet vps-agent.service; then
  log_ok "本机 Agent 已安装并作为主控节点运行：vps-agent.service"
else
  systemctl status vps-agent.service --no-pager -l || true
  die "本机 Agent 启动失败"
fi
