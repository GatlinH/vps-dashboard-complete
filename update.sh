#!/usr/bin/env bash
# update.sh — 更新 VPS Dashboard（生产环境）
# 用法：sudo ./update.sh
# 环境变量：
#   SKIP_FRONTEND_BUILD=1  跳过前端构建（默认：0）
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

  if ! command -v node &>/dev/null || ! command -v npm &>/dev/null; then
    die "未找到 node/npm，请先运行 sudo ./install.sh 或手动安装 Node.js 20 LTS"
  fi

  log_info "安装前端依赖..."
  if ! (cd "${src_dir}" && npm ci --prefer-offline 2>/dev/null); then
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
# 重建并拉起服务
# ─────────────────────────────────────────────────────────────────────────────
restart_services() {
  log_section "重建并拉起服务"

  cd "${REPO_DIR}"

  log_info "重建并启动（production profile）..."
  docker compose \
    --env-file "${SECRETS_FILE}" \
    --profile production \
    up -d --build

  log_ok "服务重建完成。"
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
  build_frontend
  restart_services
  show_status
}

main "$@"
