#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RUNNER_SRC="${REPO_DIR}/scripts/update-runner.py"
RUNNER_DIR="/opt/vps-dashboard-updater"
RUNNER_BIN="${RUNNER_DIR}/update-runner.py"
SOCKET_DIR="/run/vps-dashboard-updater"
LOG_DIR="/var/log/vps-dashboard"
SERVICE_FILE="/etc/systemd/system/vps-dashboard-updater.service"

log() { echo "[updater] $*"; }
die() { echo "[updater][ERROR] $*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "请以 root 身份运行"
[[ -f "${RUNNER_SRC}" ]] || die "缺少 ${RUNNER_SRC}"
command -v python3 >/dev/null 2>&1 || die "python3 不可用"
command -v systemctl >/dev/null 2>&1 || die "systemctl 不可用"

mkdir -p "${RUNNER_DIR}" "${SOCKET_DIR}" "${LOG_DIR}"
install -m 0755 "${RUNNER_SRC}" "${RUNNER_BIN}"
chmod 0777 "${SOCKET_DIR}"

cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=VPS Dashboard GitHub Source Update Runner
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Environment=VPS_DASHBOARD_REPO_DIR=${REPO_DIR}
Environment=VPS_DASHBOARD_UPDATE_SCRIPT=${REPO_DIR}/update.sh
Environment=VPS_DASHBOARD_UPDATE_SOCKET=${SOCKET_DIR}/updater.sock
Environment=VPS_DASHBOARD_UPDATE_LOG=${LOG_DIR}/update-runner.log
ExecStart=/usr/bin/env python3 ${RUNNER_BIN}
Restart=always
RestartSec=3
UMask=0000

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now vps-dashboard-updater.service >/dev/null
systemctl restart vps-dashboard-updater.service
sleep 1
systemctl is-active --quiet vps-dashboard-updater.service || {
  systemctl status vps-dashboard-updater.service --no-pager -l || true
  die "vps-dashboard-updater.service 启动失败"
}
log "vps-dashboard-updater.service 已运行：${SOCKET_DIR}/updater.sock"
