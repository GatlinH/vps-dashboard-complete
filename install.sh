#!/usr/bin/env bash
# install.sh — 一键安装 VPS Dashboard（生产环境）
# 支持：Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Fedora
# 用法：sudo ./install.sh
# shellcheck disable=SC1091

set -Eeuo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# 常量
# ─────────────────────────────────────────────────────────────────────────────
SECRETS_DIR="/etc/vps-dashboard"
SECRETS_FILE="${SECRETS_DIR}/secrets.env"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/vps-dashboard/install.log"

REQUIRED_VARS=(
  SECRET_KEY
  JWT_SECRET_KEY
  MYSQL_ROOT_PASSWORD
  MYSQL_PASSWORD
  MYSQL_USER
  MYSQL_DB
  REDIS_PASSWORD
  MASTER_ENCRYPTION_KEY
  CORS_ORIGINS
  FRONTEND_URL        # ← 新增
)

# ─────────────────────────────────────────────────────────────────────────────
# 彩色日志
# ─────────────────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

log_info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
log_ok()      { echo -e "${GREEN}[OK]${RESET}    $*"; }
log_warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
log_error()   { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
log_section() { echo -e "\n${BOLD}${CYAN}══ $* ══${RESET}"; }

die() {
  log_error "$*"
  exit 1
}

# ─────────────────────────────────────────────────────────────────────────────
# 权限检查
# ─────────────────────────────────────────────────────────────────────────────
check_root() {
  if [[ "${EUID}" -ne 0 ]]; then
    die "请以 root 身份运行：sudo ./install.sh"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 日志目录
# ─────────────────────────────────────────────────────────────────────────────
setup_log() {
  mkdir -p "$(dirname "${LOG_FILE}")"
  # 同时写到日志文件
  exec > >(tee -a "${LOG_FILE}") 2>&1
  log_info "安装日志：${LOG_FILE}"
}

# ─────────────────────────────────────────────────────────────────────────────
# 发行版检测
# ─────────────────────────────────────────────────────────────────────────────
detect_distro() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    DISTRO_ID="${ID:-unknown}"
    DISTRO_ID_LIKE="${ID_LIKE:-}"
  else
    die "无法读取 /etc/os-release，无法识别发行版。"
  fi

  case "${DISTRO_ID}" in
    ubuntu|debian|raspbian)
      PKG_FAMILY="debian"
      ;;
    centos|rhel|rocky|almalinux|fedora)
      PKG_FAMILY="rhel"
      ;;
    *)
      # 尝试 ID_LIKE 回退
      if echo "${DISTRO_ID_LIKE}" | grep -qE "(debian|ubuntu)"; then
        PKG_FAMILY="debian"
      elif echo "${DISTRO_ID_LIKE}" | grep -qE "(rhel|centos|fedora)"; then
        PKG_FAMILY="rhel"
      else
        die "不支持的发行版：${DISTRO_ID}（ID_LIKE=${DISTRO_ID_LIKE}）。请手动安装 Docker 后重新运行。"
      fi
      ;;
  esac

  log_info "发行版：${DISTRO_ID}（${PKG_FAMILY} 系列）"
}

# ─────────────────────────────────────────────────────────────────────────────
# Docker 安装 — Debian/Ubuntu
# ─────────────────────────────────────────────────────────────────────────────
install_docker_debian() {
  log_info "（Debian/Ubuntu）通过官方 apt 仓库安装 Docker..."

  apt-get update -y
  apt-get install -y ca-certificates curl gnupg lsb-release

  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" \
    -o /etc/apt/keyrings/docker.asc 2>/dev/null \
    || curl -fsSL "https://download.docker.com/linux/ubuntu/gpg" \
        -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc

  local arch
  arch="$(dpkg --print-architecture)"
  local codename
  codename="$(. /etc/os-release && echo "${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}")"

  if [[ -z "${codename}" ]]; then
    codename="$(lsb_release -cs 2>/dev/null || echo "")"
  fi

  [[ -n "${codename}" ]] || die "无法确定发行版代号（VERSION_CODENAME）。"

  echo \
    "deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/${DISTRO_ID} ${codename} stable" \
    > /etc/apt/sources.list.d/docker.list

  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
}

# ─────────────────────────────────────────────────────────────────────────────
# Docker 安装 — RHEL/CentOS/Rocky/Alma/Fedora
# ─────────────────────────────────────────────────────────────────────────────
install_docker_rhel() {
  log_info "（RHEL 系列）通过官方 dnf/yum 仓库安装 Docker..."

  local pm
  if command -v dnf &>/dev/null; then
    pm="dnf"
  else
    pm="yum"
  fi

  ${pm} install -y yum-utils || true
  ${pm}-config-manager --add-repo \
    https://download.docker.com/linux/centos/docker-ce.repo 2>/dev/null \
    || yum-config-manager --add-repo \
        https://download.docker.com/linux/centos/docker-ce.repo

  ${pm} install -y docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
}

# ─────────────────────────────────────────────────────────────────────────────
# Fallback：官方一键安装脚本
# ─────────────────────────────────────────────────────────────────────────────
install_docker_fallback() {
  log_warn "主安装流程失败，尝试官方一键安装脚本 get.docker.com ..."
  if ! curl -fsSL https://get.docker.com -o /tmp/get-docker.sh; then
    die "无法下载 Docker 安装脚本。请手动安装：https://docs.docker.com/engine/install/"
  fi
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
}

# ─────────────────────────────────────────────────────────────────────────────
# 安装 Docker（带 fallback）
# ─────────────────────────────────────────────────────────────────────────────
install_docker() {
  log_section "安装 Docker"

  if command -v docker &>/dev/null; then
    log_ok "Docker 已存在，跳过安装。"
    return
  fi

  local installed=false
  if [[ "${PKG_FAMILY}" == "debian" ]]; then
    if install_docker_debian; then
      installed=true
    fi
  else
    if install_docker_rhel; then
      installed=true
    fi
  fi

  if ! ${installed} || ! command -v docker &>/dev/null; then
    install_docker_fallback
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 启用并启动 Docker 服务
# ─────────────────────────────────────────────────────────────────────────────
enable_docker_service() {
  log_section "启用 Docker 服务"

  if command -v systemctl &>/dev/null; then
    systemctl enable --now docker
    log_ok "Docker 服务已启用并启动。"
  else
    log_warn "未找到 systemctl，请手动启动 Docker 服务。"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 校验命令可用性
# ─────────────────────────────────────────────────────────────────────────────
verify_commands() {
  log_section "校验命令"

  docker --version || die "docker 命令不可用。"
  log_ok "$(docker --version)"

  docker compose version || die "docker compose plugin 不可用。请确认已安装 docker-compose-plugin。"
  log_ok "$(docker compose version)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 校验仓库结构
# ─────────────────────────────────────────────────────────────────────────────
verify_repo() {
  log_section "校验仓库结构"

  local required_paths=(
    "docker-compose.yml"
    "backend/Dockerfile"
    "backend/init_db.sql"
    "backend/nginx.conf"
    "backend/nginx-main.conf"
    "backend/admin-allowlist.conf.example"
    "frontend-vite/package.json"
  )

  for p in "${required_paths[@]}"; do
    if [[ ! -e "${REPO_DIR}/${p}" ]]; then
      die "必要文件缺失：${REPO_DIR}/${p}"
    fi
    log_ok "  ✓ ${p}"
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# 管理 Secrets 文件
# ─────────────────────────────────────────────────────────────────────────────
manage_secrets() {
  log_section "Secrets 管理"

  mkdir -p "${SECRETS_DIR}"
  chmod 700 "${SECRETS_DIR}"

  if [[ ! -f "${SECRETS_FILE}" ]]; then
    log_warn "Secrets 文件不存在，正在自动生成安全配置：${SECRETS_FILE}"
    cat > "${SECRETS_FILE}" <<EOF
SECRET_KEY=$(openssl rand -hex 32)
JWT_SECRET_KEY=$(openssl rand -hex 32)
MYSQL_ROOT_PASSWORD=$(openssl rand -base64 24)
MYSQL_USER=vps_user
MYSQL_PASSWORD=$(openssl rand -hex 16)
MYSQL_DB=vps_dashboard
REDIS_PASSWORD=$(openssl rand -hex 16)
MASTER_ENCRYPTION_KEY=$(openssl rand -hex 32)
CORS_ORIGINS=http://127.0.0.1
FRONTEND_URL=http://127.0.0.1
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
PROBE_TIMEOUT_S=5
PROBE_CACHE_TTL=15
TILE_CACHE_TTL=86400
GUNICORN_WORKERS=1
GUNICORN_THREADS=4
TRUST_PROXY=1
AGENT_REQUIRE_TLS=1
AGENT_PUSH_RATE_LIMIT=60 per minute
AGENT_POLL_RATE_LIMIT=120 per minute
EOF
    chmod 600 "${SECRETS_FILE}"
    log_ok "已自动生成安全 Secrets 文件（权限 600）：${SECRETS_FILE}"
  fi

  chmod 600 "${SECRETS_FILE}"
  log_ok "Secrets 文件：${SECRETS_FILE}（权限 600）"
}
# /etc/vps-dashboard/secrets.env
# ⚠️  本文件包含敏感信息，请勿提交到版本库。
# 确认所有 CHANGE_ME 字段后，重新运行 sudo ./install.sh

# ─────────────────────────────────────────────────────────────────────────────
# 校验必填环境变量
# ─────────────────────────────────────────────────────────────────────────────
validate_secrets() {
  log_section "校验必填变量"

  # 加载 secrets（只导出非空行、非注释行）
  set -o allexport
  while IFS= read -r line; do
    # 跳过空行和注释
    [[ -z "${line}" || "${line}" =~ ^[[:space:]]*# ]] && continue
    # 仅处理 KEY=VALUE 格式，且 VALUE 部分不为空
    if [[ "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.+)$ ]]; then
      export "${line?}"
    fi
  done < "${SECRETS_FILE}"
  set +o allexport

  local missing=()
  for var in "${REQUIRED_VARS[@]}"; do
    local val="${!var:-}"
    if [[ -z "${val}" ]]; then
      missing+=("${var}（未设置）")
    elif [[ "${val}" == CHANGE_ME* ]]; then
      missing+=("${var}（仍为占位符）")
    fi
  done

  if [[ ${#missing[@]} -gt 0 ]]; then
    log_error "以下必填变量未正确配置，请编辑 ${SECRETS_FILE}："
    for m in "${missing[@]}"; do
      log_error "  ✗ ${m}"
    done
    die "修正后重新运行 sudo ./install.sh"
  fi

  for var in "${REQUIRED_VARS[@]}"; do
    log_ok "  ✓ ${var}"
  done
}

# ─────────────────────────────────────────────────────────────────────────────
# 准备 admin-allowlist.conf
# ─────────────────────────────────────────────────────────────────────────────
prepare_allowlist() {
  log_section "准备 admin-allowlist.conf"

  local example="${REPO_DIR}/backend/admin-allowlist.conf.example"
  local target="${REPO_DIR}/backend/admin-allowlist.conf"

  if [[ ! -f "${target}" ]]; then
    cp "${example}" "${target}"
    log_warn "已从 example 复制 admin-allowlist.conf。"
    log_warn "默认配置为 deny all（所有 IP 均被拒绝访问管理后台）。"
    log_warn "如需允许特定 IP，请编辑：${target}"
  else
    log_ok "admin-allowlist.conf 已存在，跳过复制。"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 安装 Node.js（若缺失）
# ─────────────────────────────────────────────────────────────────────────────
ensure_node() {
  if command -v node &>/dev/null && command -v npm &>/dev/null; then
    log_ok "Node.js 已存在：$(node --version)"
    return
  fi

  log_info "未检测到 Node.js，尝试安装..."

  if [[ "${PKG_FAMILY}" == "debian" ]]; then
    # 使用 NodeSource 脚本安装 Node.js 20 LTS
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    # RHEL 系列
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    local pm
    pm="$(command -v dnf &>/dev/null && echo dnf || echo yum)"
    ${pm} install -y nodejs
  fi

  log_ok "Node.js 安装完成：$(node --version)"
}

# ─────────────────────────────────────────────────────────────────────────────
# 构建前端
# ─────────────────────────────────────────────────────────────────────────────
build_frontend() {
  log_section "构建前端"

  local dist_dir="${REPO_DIR}/frontend-dist"
  local src_dir="${REPO_DIR}/frontend-vite"

  if [[ "${SKIP_FRONTEND_BUILD:-0}" == "1" ]]; then
    log_warn "SKIP_FRONTEND_BUILD=1，跳过前端构建。"
    if [[ ! -d "${dist_dir}" || -z "$(ls -A "${dist_dir}" 2>/dev/null)" ]]; then
      die "SKIP_FRONTEND_BUILD=1 但 frontend-dist/ 不存在或为空，无法继续。"
    fi
    log_ok "使用已有构建产物：${dist_dir}"
    return
  fi

  ensure_node

  log_info "安装前端依赖..."
  if ! (cd "${src_dir}" && npm ci --prefer-offline 2>/dev/null); then
    log_warn "离线缓存未命中，切换到在线安装..."
    (cd "${src_dir}" && npm ci)
  fi

  log_info "构建前端..."
  (cd "${src_dir}" && npm run build)

  if [[ ! -d "${dist_dir}" || -z "$(ls -A "${dist_dir}" 2>/dev/null)" ]]; then
    die "前端构建失败：frontend-dist/ 目录不存在或为空。"
  fi

  log_ok "前端构建完成：${dist_dir}"
}

# ─────────────────────────────────────────────────────────────────────────────
# 准备日志目录
# ─────────────────────────────────────────────────────────────────────────────
prepare_log_dir() {
  mkdir -p /var/log/vps-dashboard
  log_ok "/var/log/vps-dashboard 目录就绪"
}

# ─────────────────────────────────────────────────────────────────────────────
# 启动服务
# ─────────────────────────────────────────────────────────────────────────────
setup_env_symlink() {
  log_section "配置 .env 软链接"
  ln -sf "${SECRETS_FILE}" "${REPO_DIR}/.env"
  log_ok ".env → ${SECRETS_FILE}"
}
start_services() {
  log_section "启动服务"

  cd "${REPO_DIR}"

  log_info "拉取/构建镜像并启动（production profile）..."
  docker compose \
    --env-file "${SECRETS_FILE}" \
    --profile production \
    up -d --build

  log_ok "服务启动命令已执行。"
}

# ─────────────────────────────────────────────────────────────────────────────
# 等待并展示状态
# ─────────────────────────────────────────────────────────────────────────────
show_status() {
  log_section "服务状态"

  cd "${REPO_DIR}"

  # 等待健康检查（最多 90 秒）
  log_info "等待容器健康检查（最多 90 秒）..."
  local elapsed=0
  local interval=10
  while [[ ${elapsed} -lt 90 ]]; do
    sleep ${interval}
    elapsed=$((elapsed + interval))

    local unhealthy
    unhealthy="$(docker compose \
      --env-file "${SECRETS_FILE}" \
      --profile production \
      ps --format json 2>/dev/null \
      | python3 -c "
import sys, json
lines = sys.stdin.read().strip().splitlines()
bad = [
    line for line in lines
    if line.strip()
    for container in [json.loads(line)]
    if container.get('Health') in ('unhealthy', 'starting')
]
print(len(bad))
" 2>/dev/null || echo "0")"

    if [[ "${unhealthy}" == "0" ]]; then
      break
    fi
    log_info "  还有 ${unhealthy} 个容器尚未就绪（${elapsed}s）..."
  done

  docker compose \
    --env-file "${SECRETS_FILE}" \
    --profile production \
    ps

  echo ""
  log_info "关键日志（最近 20 行）："
  docker compose \
    --env-file "${SECRETS_FILE}" \
    --profile production \
    logs --tail=20 api 2>/dev/null || true

  # 获取本机 IP
  local server_ip
  server_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<服务器IP>")"

  echo ""
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${GREEN}  ✅ VPS Dashboard 安装完成！${RESET}"
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  ${BOLD}公开展示页：${RESET} http://${server_ip}/"
  echo -e "  ${BOLD}管理后台：  ${RESET} http://${server_ip}/admin"
  echo ""
  echo -e "  ${BOLD}常用命令：${RESET}"
  echo -e "    查看状态：  docker compose --env-file ${SECRETS_FILE} --profile production ps"
  echo -e "    查看日志：  docker compose --env-file ${SECRETS_FILE} --profile production logs -f"
  echo -e "    停止服务：  docker compose --env-file ${SECRETS_FILE} --profile production down"
  echo -e "    更新部署：  sudo ./update.sh"
  echo ""
  echo -e "  ${YELLOW}⚠️  首次访问管理后台，请查看 API 日志获取初始密码：${RESET}"
  echo -e "    docker compose --env-file ${SECRETS_FILE} logs api | grep -i password"
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────
main() {
  echo -e "${BOLD}${CYAN}"
  echo "╔═══════════════════════════════════════════════════════╗"
  echo "║        VPS Dashboard — 一键安装脚本                  ║"
  echo "╚═══════════════════════════════════════════════════════╝"
  echo -e "${RESET}"

  check_root
  setup_log
  detect_distro
  install_docker
  enable_docker_service
  verify_commands
  verify_repo
  manage_secrets
  validate_secrets
  prepare_allowlist
  prepare_log_dir
  build_frontend
  setup_env_symlink
  start_services
  show_status
}

main "$@"
