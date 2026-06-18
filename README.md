# VPS Dashboard Complete

一套面向 VPS 资产的监控、展示与运维管理平台。项目包含公开访问的 3D 地球/星图首页、VPS 详情页、管理员后台、探针采集、Telegram 告警、站点外观资源管理，以及 Docker Compose 部署方案。

> 目标：把分散的 VPS 节点、性能指标、网络探针、到期信息、展示资产和后台运维流程整合到一个可自托管的面板里。

## 核心功能

- **公开 3D 首页**：Three.js / Cesium 相关组件支撑地球、节点、星图、背景视觉与 VPS 落点展示。
- **VPS 详情页**：展示 CPU、内存、磁盘、网络吞吐、PING、探针、资产记录和节点状态。
- **管理后台**：账号登录、用户/角色、服务器管理、探针工具、Telegram 配置、运维设置与站点外观管理。
- **站点外观管理**：后台配置 Logo、背景、地球纹理、云层纹理、页脚 HTML、展示宽度等资源。
- **安全边界**：JWT、RBAC、审计/限流、安全头、后台 IP allowlist 示例、敏感配置隔离。
- **探针与 Agent**：支持 agent 安装/回传、探针数据采集、调度任务和队列消费。
- **告警通知**：Telegram 告警、离线/资源/到期类通知能力。
- **PWA/前端构建**：Vite 构建，Workbox PWA，构建产物默认不入库。

## 技术栈

- Node.js 22 LTS / npm：前端构建工具链
- **前端**：Vite、JavaScript、React、Three.js、Cesium、Chart.js、Pixi.js、Workbox
- **后端**：Flask、SQLAlchemy、PyMySQL、Redis、APScheduler、JWT、Gunicorn
- **基础设施**：Docker Compose、MySQL 8、Redis 7、Nginx / Caddy 反向代理均可接入
- **CI/CD**：GitHub Actions、Dependabot、前端构建检查

## 项目结构

```text
.
├── backend/                    # Flask API、模型、服务、测试、后端 Dockerfile
│   ├── api/                    # Blueprint API：auth / servers / ops / probe / traffic 等
│   ├── middleware/             # RBAC、安全中间件、审计等
│   ├── models/                 # SQLAlchemy 数据模型
│   ├── services/               # 设置、调度、邮件、探针等业务服务
│   ├── tests/                  # 后端测试
│   ├── app.py                  # Flask 应用入口
│   ├── config.py               # 环境变量配置
│   └── requirements.txt        # Python 依赖
├── frontend-vite/              # Vite 前端源码
│   ├── public/                 # 站点静态资源、地球/星舰/背景资产
│   ├── src/                    # 页面、组件、API、样式、PWA 逻辑
│   ├── admin.html              # 管理后台入口
│   ├── index.html              # 公开首页入口
│   └── package.json            # 前端依赖与脚本
├── scripts/                    # Agent / 运维脚本
├── docs/                       # 部署、安全、API、探针等文档
├── .github/workflows/          # CI 工作流
├── docker-compose.yml          # MySQL / Redis / API / agent_consumer
├── install.sh                  # 一键安装脚本
├── update.sh                   # 更新脚本
└── README.md
```

> `frontend-dist/` 是 Vite 构建产物，默认由 CI/CD 或部署环境生成，不提交进仓库。

## 页面入口

| 页面 | 路径 | 说明 |
| --- | --- | --- |
| 公开首页 | `/` 或 `/index.html` | VPS 地球/星图展示，无需登录 |
| VPS 详情页 | `/?server=<id>` | 单节点详情、图表和探针数据 |
| 管理后台 | `/admin.html` 或 `/admin` | 需要登录，按角色授权 |
| 健康检查 | `/health` | API 健康状态 |


## 一键 Docker 安装（推荐）

适合全新 VPS。脚本会自动安装 Docker / Docker Compose Plugin、准备目录、读取 `/etc/vps-dashboard/secrets.env`，然后用 Docker Compose 启动 MySQL、Redis、API 和 agent consumer。

### 方式 A：curl 远程一键安装

可以直接下载 GitHub Raw 脚本执行：

```bash
curl -L https://raw.githubusercontent.com/GatlinH/vps-dashboard-complete/main/install.sh -o vps-dashboard.sh && chmod +x vps-dashboard.sh && sudo ./vps-dashboard.sh
```

首次运行如果发现 `/etc/vps-dashboard/secrets.env` 不存在，脚本会生成配置模板并提示你填写。填写后再次执行：

```bash
sudo nano /etc/vps-dashboard/secrets.env
sudo ./vps-dashboard.sh
```

### 方式 B：克隆仓库后安装

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
sudo ./install.sh
```

安装完成后访问：

```text
http://<服务器IP>/
http://<服务器IP>/admin.html
```

### 方式 C：克隆仓库一行安装

如果你只想在新机器上快速拉起：

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git && cd vps-dashboard-complete && sudo ./install.sh
```

> 生产环境不要跳过 secrets 填写。`SECRET_KEY`、`JWT_SECRET_KEY`、数据库密码、Redis 密码、管理员密码都必须换成强随机值。

## 快速开始：Docker Compose

### 1. 克隆项目

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
```

### 2. 准备环境变量

复制模板并填写生产密钥：

```bash
cp backend/.env.example .env
```

至少需要设置：

```env
SECRET_KEY=CHANGE_ME_USE_python_secrets_token_hex_32
JWT_SECRET_KEY=CHANGE_ME_USE_python_secrets_token_hex_32_different
MYSQL_PASSWORD=CHANGE_ME_STRONG_MYSQL_PASSWORD
MYSQL_ROOT_PASSWORD=CHANGE_ME_STRONG_MYSQL_ROOT_PASSWORD
REDIS_PASSWORD=CHANGE_ME_STRONG_REDIS_PASSWORD
ADMIN_DEFAULT_USERNAME=admin
ADMIN_DEFAULT_PASSWORD=CHANGE_ME_STRONG_ADMIN_PASSWORD
```

生成密钥示例：

```bash
python3 -c "import secrets; print(secrets.token_hex(32))"
```

### 3. 启动服务

```bash
docker compose up -d --build
```

查看状态：

```bash
docker compose ps
docker compose logs -f api
```

### 4. 构建前端

```bash
cd frontend-vite
npm ci
npm run build
```

默认输出到仓库根目录的 `frontend-dist/`。

## 一键安装脚本

生产环境可以使用安装脚本：

```bash
sudo ./install.sh
```

脚本会检查 Docker、生成/读取部署配置，并启动服务。生产部署建议把真实 secrets 放在服务器专用环境文件中，不要提交 `.env`。

更多部署细节见：

- `docs/DEPLOY_ONE_CLICK.md`
- `docs/deployment.md`
- `DEPLOY_CHECKLIST.md`

## 开发环境

### 前端开发

```bash
cd frontend-vite
npm ci
npm run dev
```

常用脚本：

```bash
npm run build
npm run preview
```

### 后端开发

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
flask run
```

后端测试：

```bash
cd backend
pytest
```

## 管理后台能力

后台入口：`/admin.html`

主要模块：

- **总览**：平台状态、核心指标、运行摘要
- **服务器管理**：VPS 节点、分组、展示配置、真实坐标字段
- **账号管理**：用户、角色、权限边界
- **探针工具**：PING / TCP 探测与诊断
- **Telegram**：告警配置与通知测试
- **运维设置**：登录、安全、系统级配置
- **站点外观**：Logo、背景、纹理、页脚与展示宽度

### 站点外观输入规则

站点外观资源字段允许：

- 空值
- `/assets/custom/...`
- `/assets/...`
- `/static/...`
- `/favicon.ico`
- `https://...`

后端会拒绝高风险输入：

- `http://...`
- `javascript:`
- `data:`
- `file:`
- `ftp:` / `blob:`
- 协议相对 URL：`//example.com/a.png`
- 路径穿越：`/assets/custom/../secret.png`
- 页脚中的 `<script>`、事件属性、`iframe`、`object`、`embed` 等危险 HTML

建议生产长期资源使用站内路径，例如：

```text
/assets/custom/logo.png
/assets/custom/mobile-background.webp
/assets/custom/earth-texture.jpg
```

## 安全说明

请不要提交以下内容：

- `.env`
- 真实 `backend/admin-allowlist.conf`
- 私钥、证书、token、数据库备份
- `frontend-dist/` 构建产物
- `_archive/`、`backups/`、`.bak` 热修备份

仓库中的 `.gitignore` 已默认排除这些文件，但推送前仍建议执行：

```bash
git status --short
git diff --cached --name-only
```

生产安全建议：

- `SECRET_KEY` 和 `JWT_SECRET_KEY` 必须不同
- 管理员默认密码必须改为强密码
- Redis / MySQL 必须设置强密码
- Telegram bot token 建议启用加密密钥
- 管理后台建议放在反向代理、IP allowlist、HTTPS 之后
- 外链图片只建议使用可信 HTTPS CDN，长期资源优先站内托管

## CI 与构建产物

GitHub Actions 负责：

- 后端测试
- 前端构建检查
- Dependabot 依赖更新
- 可选部署流程

前端构建产物不入库，原因：

- 避免提交大体积衍生文件
- 避免 hash 文件造成无意义 diff
- 保证部署时由源码可重复构建

如需部署静态产物，请在目标环境运行：

```bash
cd frontend-vite
npm ci
npm run build
```

## Agent / 探针

仓库包含 `scripts/vps-agent.py`，用于 VPS 节点侧采集/回传。实际生产安装应使用认证后的安装流程和受控配置，不要把服务器 token 写入仓库。

相关接口和运维文档：

- `docs/README_API.md`
- `docs/probe_partition_ops.md`

## 更新与回滚

更新：

```bash
git pull --ff-only
sudo ./update.sh
```

回滚：

```bash
git log --oneline -10
git checkout <commit-sha>
sudo ./update.sh
```

Docker Compose 手动操作：

```bash
docker compose ps
docker compose logs -f
docker compose restart api
docker compose down
```

## 许可证

当前仓库未声明开源许可证。公开发布或开放协作前，建议补充明确的 `LICENSE` 文件。
