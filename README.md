# VPS 星图 · 服务器监控管理平台

一个功能完整的 VPS 监控与管理平台，包含 **Vite 前端构建产物（frontend-dist）** 与 Flask + MySQL + Redis 后端。

## 功能特性

- 📡 **监控总览** — 实时 CPU / 内存 / 磁盘 / 网速，支持分组筛选
- 💰 **剩余价值** — 自动计算每台服务器的剩余价值，鼠标悬浮显示详情
- 🌍 **3D 星图** — 可拖拽旋转的 3D 地球，支持缩放和 CARTO 实况底图
- 🛒 **AFF 市场** — VPS 推荐卡片，含库存、测评链接和一键购买
- 💹 **交易计算器** — 计算剩余价值和建议售价
- 🔐 **管理后台** — 登录后进入，支持添加服务器、TCP Ping、Telegram 告警、主题定制
- ✈ **Telegram 推送** — CPU / 内存 / 离线 / 到期告警
- 🎨 **主题系统** — 6 套预设主题 + 自定义 CSS 注入

## 项目结构

```text
vps-dashboard/
├── frontend-vite/          # 前端源码（Vite）
├── frontend-dist/          # 前端构建产物（部署目录，默认不提交）
├── backend/
│   ├── app.py              # Flask 入口
│   ├── config.py           # 配置（MySQL / Redis / JWT）
│   ├── extensions.py       # 扩展单例
│   ├── requirements.txt    # Python 依赖
│   ├── Dockerfile          # 容器镜像
│   ├── docker-compose.yml  # 一键启动 MySQL + Redis + Flask + Nginx
│   ├── nginx.conf          # 反向代理配置（含安全响应头）
│   ├── init_db.sql         # 数据库初始化
│   ├── .env.example        # 环境变量模板
│   ├── api/                # Flask Blueprint
│   ├── middleware/         # 中间件
│   ├── models/             # SQLAlchemy 数据模型
│   └── services/           # 调度与业务服务
└── .github/workflows/      # CI / CD
```

## 访问方式

| 页面 | URL | 说明 |
|------|-----|------|
| 公开展示页 | `http://服务器IP/` 或 `/index.html` | 无需登录，可公开访问 |
| 管理后台 | `http://服务器IP/admin.html` 或 `/admin` | 需要管理员账号登录 |

## 一键安装（推荐，生产环境）

支持 **Ubuntu / Debian / CentOS / RHEL / Rocky / AlmaLinux / Fedora**。

### 步骤 1：克隆仓库

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
```

### 步骤 2：首次运行（生成配置模板）

```bash
sudo ./install.sh
```

脚本会自动安装 Docker，并在 `/etc/vps-dashboard/secrets.env` 生成配置模板后退出。

> ⚠️ **敏感信息统一存放于 `/etc/vps-dashboard/secrets.env`，不得写入仓库任何 `.env` 文件。**

### 步骤 3：填写 Secrets

```bash
sudo nano /etc/vps-dashboard/secrets.env
```

将所有 `CHANGE_ME` 占位符替换为真实值，生成随机密钥：

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

### 步骤 4：正式安装

```bash
sudo ./install.sh
```

安装完成后访问：

| 页面 | URL |
|------|-----|
| 公开展示页 | `http://服务器IP/` |
| 管理后台 | `http://服务器IP/admin` |

---

## 更新

```bash
cd vps-dashboard-complete
sudo ./update.sh
```

跳过前端构建（仅更新后端）：

```bash
sudo SKIP_FRONTEND_BUILD=1 ./update.sh
```

---

## 停止 / 重启 / 日志

```bash
# 变量简写
ENV_FILE=/etc/vps-dashboard/secrets.env

# 查看状态
docker compose --env-file $ENV_FILE --profile production ps

# 实时日志
docker compose --env-file $ENV_FILE --profile production logs -f

# 停止（保留数据）
docker compose --env-file $ENV_FILE --profile production down

# 重启
docker compose --env-file $ENV_FILE --profile production restart
```

---

## 回滚

```bash
# 查看历史版本
git log --oneline -10

# 回滚到指定版本
git checkout <commit-sha>

# 重新部署
sudo ./update.sh
```

---

## 安全配置提醒（生产环境）

- `SECRET_KEY` 与 `JWT_SECRET_KEY` 必须不同，各不少于 32 位随机字符。
- `ADMIN_DEFAULT_PASSWORD` 建议显式设置强密码；若留空，系统首次启动时自动生成并输出到日志。
- `JWT_BLOCKLIST_FAIL_OPEN` 默认为 `1`（Redis 异常时放行，优先高可用）；如更重视安全一致性，建议改为 `0`。
- 详细安全建议见 [docs/DEPLOY_ONE_CLICK.md](docs/DEPLOY_ONE_CLICK.md)。

## CI 构建流水线（P3E）

### 前端构建 CI

仓库配置了两条 CI 流程来保证前端构建可用：

| Workflow | 触发条件 | 说明 |
|----------|----------|------|
| `ci.yml` → `Frontend Build Check` | 所有 push/PR（无 path 过滤） | 通用 CI 门控，`deploy.yml` 依赖此检查 |
| `frontend-ci.yml` → `Frontend Build (path-filtered)` | 仅 `frontend-vite/**` 或 workflow 文件变更时 | 资源优化版，自动上传构建产物 |

### 构建产物（Artifact）

每次前端相关变更的 CI 运行结束后，构建产物会以以下格式上传至 GitHub Actions Artifacts：

- **命名**：`frontend-dist-<git-sha>`
- **路径**：仓库根目录下的 `frontend-dist/`（`vite.config.js` 中 `outDir: '../frontend-dist'`）
- **保留期**：7 天

### 为什么不把 `frontend-dist/` 提交进仓库

- 构建产物是源码的衍生物，提交后会造成 diff 噪音，增加仓库体积
- CI 已保证每次变更均可自动重现构建，任何人均可从 artifact 获取最新产物
- 部署时应在目标环境执行同版本构建（参见下方部署步骤），或从 CI artifact 下载后解压到 `frontend-dist/`

## GitHub Actions 自动部署

在仓库 Settings → Secrets → Actions 添加：

| Secret | 说明 |
|--------|------|
| `VPS_HOST` | 服务器 IP |
| `VPS_USER` | SSH 用户名（如 root）|
| `VPS_SSH_KEY` | SSH 私钥（`cat ~/.ssh/id_rsa`）|

配置后，每次 `git push main` 自动触发：
1. 运行后端测试 + 前端构建检查（仅说明当前提交在 CI 环境中可通过测试并完成构建）
2. 在 VPS 上远程执行 `frontend-vite` 构建，产出 `frontend-dist/`（该步骤仍依赖服务器上的 Node/npm 环境；需与 CI 保持一致，或改为下载 CI artifact 部署）
3. 重启 `backend/docker-compose.yml` 服务完成部署

## 技术栈

**前端**: Vite + JavaScript + Workbox PWA + Chart.js  
**后端**: Flask · SQLAlchemy · PyMySQL · Redis · APScheduler · JWT · Gunicorn  
**基础设施**: MySQL 8 · Redis 7 · Docker Compose · Nginx · Let's Encrypt
