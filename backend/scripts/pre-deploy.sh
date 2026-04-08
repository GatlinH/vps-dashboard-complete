# backend/scripts/pre-deploy.sh - 部署前检查脚本

#!/bin/bash

set -e

echo "🔍 VPS Dashboard 部署前检查..."

# 1. 检查必需的环境变量
echo "✓ 检查环境变量..."
required_vars=("MYSQL_PASSWORD" "JWT_SECRET_KEY" "SECRET_KEY")
for var in "${required_vars[@]}"; do
    if [ -z "${!var}" ]; then
        echo "❌ 缺少环境变量: $var"
        exit 1
    fi
done

# 2. 检查 Docker
echo "✓ 检查 Docker..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker 未安装"
    exit 1
fi

# 3. 检查 Docker Compose
echo "✓ 检查 Docker Compose..."
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose 未安装"
    exit 1
fi

# 4. 验证 .env 文件
echo "✓ 验证 .env 文件..."
if [ ! -f .env ]; then
    echo "❌ .env 文件不存在"
    cp .env.example .env
    echo "⚠️ 已创建 .env.example，请修改后重试"
    exit 1
fi

# 5. 构建镜像（空运行检查）
echo "✓ 检查 Docker 镜像构建..."
docker-compose build --dry-run api > /dev/null 2>&1 || {
    echo "❌ Docker 镜像构建失败"
    exit 1
}

# 6. 检查端口
echo "✓ 检查端口占用..."
for port in 80 443 3306 6379 5000; do
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo "⚠️ 端口 $port 已被占用"
    fi
done

echo "✅ 所有检查通过！"
echo "运行命令启动应用:"
echo "  docker-compose up -d"
