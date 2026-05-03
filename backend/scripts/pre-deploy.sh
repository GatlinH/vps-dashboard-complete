#!/bin/bash
# backend/scripts/pre-deploy.sh - 部署前检查脚本

set -Eeuo pipefail

# ─── 帮助 ──────────────────────────────────────────────────────────────────────
usage() {
  echo "用法: $0 [--env-file <path>]"
  echo "  --env-file  指定 secrets env 文件路径（默认 /etc/vps-dashboard/secrets.env）"
  exit 1
}

# ─── 参数解析 ─────────────────────────────────────────────────────────────────
ENV_FILE="/etc/vps-dashboard/secrets.env"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env-file) ENV_FILE="$2"; shift 2 ;;
    -h|--help)  usage ;;
    *) echo "未知参数: $1"; usage ;;
  esac
done

# ─── 加载 env 文件（若存在） ──────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  echo "📂 加载 env 文件: $ENV_FILE"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
else
  echo "ℹ️  env 文件不存在（$ENV_FILE），仅检查当前 shell 环境变量"
fi

echo "🔍 VPS Dashboard 部署前检查..."

# ─── 1. 检查必需的环境变量 ────────────────────────────────────────────────────
echo "✓ 检查环境变量..."
required_vars=(
  "SECRET_KEY"
  "JWT_SECRET_KEY"
  "MYSQL_ROOT_PASSWORD"
  "MYSQL_PASSWORD"
  "MYSQL_USER"
  "MYSQL_DB"
  "REDIS_PASSWORD"
  "MASTER_ENCRYPTION_KEY"
  "CORS_ORIGINS"
  "FRONTEND_URL"
)

missing=()
for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "❌ 缺少环境变量: $var"
    missing+=("$var")
  fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
  echo ""
  echo "❌ 共缺少 ${#missing[@]} 个必需环境变量，请在 .env 中配置后重试。"
  exit 1
fi

echo "✅ 所有必需环境变量已配置"

# ─── 2. 检查弱默认值 ──────────────────────────────────────────────────────────
echo "✓ 检查弱默认值..."
weak_found=0

check_weak() {
  local var="$1"; local val="${!var:-}"; shift
  for weak in "$@"; do
    if [[ "$val" == "$weak" ]]; then
      echo "❌ $var 仍为弱默认值（$val），请替换为随机强密钥"
      weak_found=1
      return
    fi
  done
}

check_weak SECRET_KEY        "change-me-in-production" "change-me-in-production-32chars!" "CHANGE_ME_USE_python_secrets_token_hex_32"
check_weak JWT_SECRET_KEY    "change-me-jwt-secret"    "change-me-in-production"          "CHANGE_ME_USE_python_secrets_token_hex_32_different"
check_weak MYSQL_PASSWORD    "vps_pass" "password" "root"
check_weak MYSQL_ROOT_PASSWORD "root_password" "root" "password"
check_weak REDIS_PASSWORD    "CHANGE_ME_STRONG_REDIS_PASSWORD"
check_weak MASTER_ENCRYPTION_KEY "CHANGE_ME_USE_python_secrets_token_hex_32"

if [[ $weak_found -ne 0 ]]; then
  echo ""
  echo "❌ 发现弱默认值，拒绝继续。请替换为随机强密钥后重试。"
  exit 1
fi

echo "✅ 未发现弱默认值"

# ─── 3. 检查 Docker ───────────────────────────────────────────────────────────
echo "✓ 检查 Docker..."
if ! command -v docker &>/dev/null; then
  echo "❌ Docker 未安装"
  exit 1
fi

# ─── 4. 检查 Docker Compose ───────────────────────────────────────────────────
echo "✓ 检查 Docker Compose..."
if ! docker compose version &>/dev/null 2>&1 && ! command -v docker-compose &>/dev/null; then
  echo "❌ Docker Compose 未安装（需要 docker compose 插件或 docker-compose 命令）"
  exit 1
fi

# ─── 5. 验证 .env 文件 ────────────────────────────────────────────────────────
echo "✓ 验证 .env 文件..."
if [[ ! -f .env ]]; then
  echo "⚠️  .env 文件不存在"
  if [[ -f .env.example ]]; then
    cp .env.example .env
    echo "⚠️  已从 .env.example 创建 .env，请修改其中 CHANGE_ME 项后重试"
  fi
  exit 1
fi

# ─── 6. 检查端口占用 ──────────────────────────────────────────────────────────
# Note: occupied ports are reported as warnings only. A port may already be bound
# by the running service containers (e.g. during a rolling redeploy). Docker
# Compose will fail fast with a clear error if a port conflict exists at startup.
echo "✓ 检查端口占用..."
for port in 80 443 3306 6379 5000; do
  if lsof -Pi :"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "⚠️  端口 $port 已被占用（启动前请确认是否冲突）"
  fi
done

echo ""
echo "✅ 所有检查通过！"
echo "运行命令启动应用:"
echo "  docker compose up -d"
