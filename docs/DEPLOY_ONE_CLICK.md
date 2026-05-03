# VPS Dashboard — 一键部署指南

本文档说明如何在主流 Linux 发行版上使用 `install.sh` 一键部署 VPS Dashboard，以及各发行版特有的注意事项和安全建议。

---

## 目录

1. [支持的操作系统](#支持的操作系统)
2. [首次安装](#首次安装)
3. [各发行版注意事项](#各发行版注意事项)
4. [更新](#更新)
5. [停止 / 重启 / 日志](#停止--重启--日志)
6. [回滚](#回滚)
7. [安全建议](#安全建议)

---

## 支持的操作系统

| 发行版 | 版本 | 包管理器 | 状态 |
|--------|------|----------|------|
| Ubuntu | 20.04 / 22.04 / 24.04 | apt | ✅ 推荐 |
| Debian | 11 / 12 | apt | ✅ 推荐 |
| CentOS Stream | 8 / 9 | dnf | ✅ 支持 |
| RHEL | 8 / 9 | dnf | ✅ 支持 |
| Rocky Linux | 8 / 9 | dnf | ✅ 支持 |
| AlmaLinux | 8 / 9 | dnf | ✅ 支持 |
| Fedora | 38 / 39 / 40 | dnf | ✅ 支持 |

---

## 首次安装

### 步骤 1：克隆仓库

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
```

### 步骤 2：首次运行（生成配置模板）

```bash
sudo ./install.sh
```

首次运行时，脚本会：
1. 检测并安装 Docker
2. 在 `/etc/vps-dashboard/secrets.env` 生成配置模板
3. 提示你编辑配置后退出

### 步骤 3：填写 Secrets

```bash
sudo nano /etc/vps-dashboard/secrets.env
```

**必填项（所有 `CHANGE_ME` 占位符均需替换）：**

| 变量 | 说明 | 生成命令 |
|------|------|----------|
| `SECRET_KEY` | Flask 会话密钥（≥32位） | `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `JWT_SECRET_KEY` | JWT 密钥（与 SECRET_KEY 不同） | 同上 |
| `MYSQL_ROOT_PASSWORD` | MySQL root 密码 | 强密码（≥16位含特殊字符） |
| `MYSQL_USER` | MySQL 应用用户名 | 例如 `vps_user` |
| `MYSQL_PASSWORD` | MySQL 应用用户密码 | 强密码 |
| `MYSQL_DB` | 数据库名 | 例如 `vps_dashboard` |
| `REDIS_PASSWORD` | Redis 认证密码（≥16位） | `python3 -c "import secrets; print(secrets.token_hex(24))"` |
| `MASTER_ENCRYPTION_KEY` | 敏感字段加密密钥（≥32位） | `python3 -c "import secrets; print(secrets.token_hex(32))"` |
| `CORS_ORIGINS` | 允许跨域的域名 | 例如 `https://yourdomain.com` |

### 步骤 4：正式安装

```bash
sudo ./install.sh
```

安装完成后，输出包含：
- 各容器健康状态
- API 关键日志
- 访问地址

---

## 各发行版注意事项

### Ubuntu / Debian

- 推荐使用 **Ubuntu 22.04 LTS** 或 **Debian 12**
- 脚本会自动添加 Docker 官方 apt 源（`download.docker.com`）
- 需要能访问 `download.docker.com`；中国大陆服务器可能需要配置镜像加速

**中国大陆镜像加速（可选）：**

```bash
# 在 /etc/docker/daemon.json 添加
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json <<'EOF'
{
  "registry-mirrors": [
    "https://mirror.gcr.io",
    "https://dockerproxy.com"
  ]
}
EOF
sudo systemctl restart docker
```

---

### CentOS / RHEL / Rocky / AlmaLinux

- **CentOS 7 不受支持**（EOL，Docker 安装方式差异较大）
- 脚本使用 CentOS 官方 Docker CE 仓库（适用于 RHEL 系列 8/9）
- RHEL 系统可能需要先关闭 SELinux 或配置合适的 SELinux 策略：

```bash
# 临时关闭（测试用）
sudo setenforce 0
# 永久关闭（生产环境建议保持 enforcing，配置 Docker SELinux 策略）
sudo sed -i 's/^SELINUX=enforcing/SELINUX=permissive/' /etc/selinux/config
```

- 防火墙配置（若使用 firewalld）：

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

---

### Fedora

- 脚本同样使用 CentOS Docker CE 仓库；Fedora 版本号较新时可能需要手动指定 OS 版本
- 若 Docker CE 仓库安装失败，脚本会自动回退到 `get.docker.com` 官方安装脚本

---

## 更新

```bash
cd /path/to/vps-dashboard-complete
sudo ./update.sh
```

**跳过前端构建**（适用于仅更新后端的场景）：

```bash
sudo SKIP_FRONTEND_BUILD=1 ./update.sh
```

---

## 停止 / 重启 / 日志

```bash
# 查看所有容器状态
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production ps

# 查看实时日志
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production logs -f

# 查看特定服务日志
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production logs -f api

# 停止所有服务（保留数据卷）
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production down

# 重启所有服务
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production restart

# 重启特定服务
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production restart api
```

---

## 回滚

### 代码回滚

```bash
# 查看提交历史
git log --oneline -10

# 回滚到指定版本
git checkout <commit-sha>

# 重新部署
sudo ./update.sh
```

### 数据库备份与恢复

详见 [backend/BACKUP_AND_ROLLBACK.md](../backend/BACKUP_AND_ROLLBACK.md)。

**快速备份：**

```bash
docker exec vps_mysql mysqldump \
  -u root -p"${MYSQL_ROOT_PASSWORD}" \
  --all-databases > /backup/vps_dump_$(date +%Y%m%d).sql
```

---

## 安全建议

### 1. Secrets 文件权限

`/etc/vps-dashboard/secrets.env` 默认权限为 `600`（仅 root 可读），**切勿修改**。

```bash
# 验证权限
ls -la /etc/vps-dashboard/secrets.env
# 应显示：-rw------- 1 root root ...
```

### 2. 禁止将 Secrets 写入仓库

- `.env` 文件已在 `.gitignore` 中排除
- `/etc/vps-dashboard/secrets.env` 位于仓库目录外，天然隔离
- 每次提交前检查：`git diff --cached | grep -i password`

### 3. 密钥轮换

**轮换 SECRET_KEY / JWT_SECRET_KEY：**
```bash
# 生成新密钥
python3 -c "import secrets; print(secrets.token_hex(32))"

# 编辑 secrets 文件
sudo nano /etc/vps-dashboard/secrets.env

# 重启服务（会使所有已登录用户的 JWT 失效）
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production restart api
```

**轮换 MASTER_ENCRYPTION_KEY：**
> ⚠️ 此操作需要重新加密数据库中的敏感字段，请参考 backend 文档。

**轮换 MySQL/Redis 密码：**
```bash
# 1. 更新 secrets.env 中的密码
sudo nano /etc/vps-dashboard/secrets.env

# 2. 更新 MySQL 用户密码
docker exec -it vps_mysql mysql -u root -p \
  -e "ALTER USER 'vps_user'@'%' IDENTIFIED BY 'NEW_PASSWORD';"

# 3. 更新 Redis 密码（需重建容器）
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production \
  up -d --build redis

# 4. 重启依赖服务
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production \
  restart api agent_consumer
```

### 4. 网络安全

- MySQL（3306）和 API（5000）仅绑定 `127.0.0.1`，不对公网暴露
- Redis 仅通过 Docker 内部网络（`vps-network`）通信
- Nginx 是唯一对外暴露的服务（80/443）
- 建议配置防火墙，仅开放 80/443 端口

```bash
# Ubuntu/Debian（ufw）
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
sudo ufw enable

# RHEL 系列（firewalld）
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

### 5. TLS / HTTPS

生产环境强烈建议配置 HTTPS：

```bash
# 安装 certbot（Ubuntu/Debian）
sudo apt install certbot python3-certbot-nginx

# 申请证书
sudo certbot --nginx -d yourdomain.com

# 证书会自动挂载到 nginx 容器（/etc/letsencrypt 已在 docker-compose.yml 中挂载）
```

### 6. 管理后台 IP 白名单

编辑 `backend/admin-allowlist.conf` 限制管理后台访问 IP：

```nginx
allow 203.0.113.10/32;   # 你的办公室 IP
allow 10.0.0.0/8;        # 内网/VPN
deny all;
```

然后重载 Nginx：

```bash
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production exec nginx nginx -s reload
```

### 7. 日志监控

```bash
# 安装日志（脚本执行过程）
cat /var/log/vps-dashboard/install.log

# 更新日志
cat /var/log/vps-dashboard/update.log

# 应用日志
docker compose --env-file /etc/vps-dashboard/secrets.env --profile production logs api

# Nginx 访问日志
cat ./nginx-logs/access.log
```

### 8. 定期备份

建议配置 cron 定期备份数据库：

```bash
# 添加 cron 任务（每天凌晨2点备份）
(crontab -l 2>/dev/null; echo "0 2 * * * docker exec vps_mysql mysqldump -u root -p\$(grep MYSQL_ROOT_PASSWORD /etc/vps-dashboard/secrets.env | cut -d= -f2) --all-databases > /backup/vps_\$(date +\%Y\%m\%d).sql 2>/dev/null") | crontab -
```
