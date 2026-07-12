#!/usr/bin/env bash
# update.sh — 更新 VPS Dashboard（生产环境）
# 用法：sudo ./update.sh
# 环境变量：
#   VPS Dashboard 默认使用 GHCR 镜像部署；本脚本只拉取源码中的 compose/脚本更新和最新镜像。
# shellcheck disable=SC1091

set -Eeuo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# 常量
# ─────────────────────────────────────────────────────────────────────────────
SECRETS_FILE="/etc/vps-dashboard/secrets.env"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_FILE="/var/log/vps-dashboard/update.log"

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
    die "请以 root 身份运行：sudo ./update.sh"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 日志目录
# ─────────────────────────────────────────────────────────────────────────────
setup_log() {
  mkdir -p "$(dirname "${LOG_FILE}")"
  exec > >(tee -a "${LOG_FILE}") 2>&1
  log_info "更新日志：${LOG_FILE}"
  log_info "更新时间：$(date '+%Y-%m-%d %H:%M:%S')"
}

# ─────────────────────────────────────────────────────────────────────────────
# 前置检查
# ─────────────────────────────────────────────────────────────────────────────
preflight() {
  log_section "前置检查"

  command -v docker &>/dev/null   || die "docker 命令不可用，请先运行 sudo ./install.sh"
  docker compose version &>/dev/null || die "docker compose plugin 不可用，请先运行 sudo ./install.sh"
  log_ok "Docker 环境正常"

  [[ -f "${SECRETS_FILE}" ]] || die "Secrets 文件不存在：${SECRETS_FILE}，请先运行 sudo ./install.sh"
  log_ok "Secrets 文件：${SECRETS_FILE}"

  [[ -d "${REPO_DIR}/.git" ]] || die "当前目录不是 Git 仓库：${REPO_DIR}"
  log_ok "Git 仓库：${REPO_DIR}"
}

# ─────────────────────────────────────────────────────────────────────────────
# 记录当前版本（用于回滚提示）
# ─────────────────────────────────────────────────────────────────────────────
record_current_version() {
  cd "${REPO_DIR}"
  BEFORE_SHA="$(git rev-parse HEAD)"
  log_info "当前版本：${BEFORE_SHA}"
}

# ─────────────────────────────────────────────────────────────────────────────
# git pull 更新代码
# ─────────────────────────────────────────────────────────────────────────────
git_pull() {
  log_section "更新代码"

  cd "${REPO_DIR}"

  local branch
  branch="$(git rev-parse --abbrev-ref HEAD)"
  log_info "当前分支：${branch}"

  # 优先使用 rebase，失败时回退普通 merge pull
  if git pull --rebase origin "${branch}" 2>/dev/null; then
    log_ok "git pull --rebase 成功"
  else
    log_warn "rebase 失败，回退到普通 git pull..."
    git rebase --abort 2>/dev/null || true
    git pull origin "${branch}" || die "git pull 失败，请手动处理冲突后重新运行 sudo ./update.sh"
    log_ok "git pull（merge）成功"
  fi

  local after_sha
  after_sha="$(git rev-parse HEAD)"
  if [[ "${BEFORE_SHA}" == "${after_sha}" ]]; then
    log_info "代码无变化（${after_sha:0:8}），继续重建服务..."
  else
    log_ok "代码已更新：${BEFORE_SHA:0:8} → ${after_sha:0:8}"
  fi
}

# ─────────────────────────────────────────────────────────────────────────────
# 拉取镜像并拉起服务
# ─────────────────────────────────────────────────────────────────────────────
restart_services() {
  log_section "拉取 GHCR 镜像并拉起服务"

  cd "${REPO_DIR}"

  log_info "拉取最新 GHCR 镜像..."
  docker compose \
    --env-file "${SECRETS_FILE}" \
    --profile production \
    pull

  log_info "使用镜像启动服务（不在本机构建）..."
  docker compose \
    --env-file "${SECRETS_FILE}" \
    --profile production \
    up -d --no-build

  log_ok "镜像更新完成。"
}

# ─────────────────────────────────────────────────────────────────────────────
# 同步宿主机 Agent
# ─────────────────────────────────────────────────────────────────────────────
sync_host_agent() {
  log_section "同步宿主机 Agent"

  if [[ ! -x "${REPO_DIR}/scripts/install-master-agent.sh" ]]; then
    log_warn "缺少 scripts/install-master-agent.sh，跳过宿主机 Agent 同步。"
    return
  fi

  REPO_DIR="${REPO_DIR}" SECRETS_FILE="${SECRETS_FILE}" COMPOSE_FILES="docker-compose.yml" \
    "${REPO_DIR}/scripts/install-master-agent.sh"
  log_ok "宿主机 Agent 已同步并重启。"
}


# ─────────────────────────────────────────────────────────────────────────────
# 展示状态
# ─────────────────────────────────────────────────────────────────────────────
show_status() {
  log_section "服务状态"

  cd "${REPO_DIR}"

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

  local after_sha
  after_sha="$(git -C "${REPO_DIR}" rev-parse HEAD)"

  echo ""
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}${GREEN}  ✅ VPS Dashboard 更新完成！${RESET}"
  echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo ""
  echo -e "  ${BOLD}更新前版本：${RESET} ${BEFORE_SHA:0:8}"
  echo -e "  ${BOLD}当前版本：  ${RESET} ${after_sha:0:8}"
  echo ""
  echo -e "  ${BOLD}回滚命令：${RESET}"
  echo -e "    cd ${REPO_DIR} && git checkout ${BEFORE_SHA}"
  echo -e "    sudo ./update.sh"
  echo ""
  echo -e "  ${BOLD}常用命令：${RESET}"
  echo -e "    查看状态：  docker compose --env-file ${SECRETS_FILE} --profile production ps"
  echo -e "    查看日志：  docker compose --env-file ${SECRETS_FILE} --profile production logs -f"
  echo -e "    停止服务：  docker compose --env-file ${SECRETS_FILE} --profile production down"
  echo ""
}

# ─────────────────────────────────────────────────────────────────────────────
# 主流程
# ─────────────────────────────────────────────────────────────────────────────
main() {
  echo -e "${BOLD}${CYAN}"
  echo "╔═══════════════════════════════════════════════════════╗"
  echo "║        VPS Dashboard — 更新脚本                      ║"
  echo "╚═══════════════════════════════════════════════════════╝"
  echo -e "${RESET}"

  check_root
  setup_log
  preflight
  record_current_version
  git_pull
  restart_services
  sync_host_agent
  show_status
}

main "$@"
