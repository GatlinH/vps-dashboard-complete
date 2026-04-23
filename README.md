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

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/你的用户名/vps-dashboard.git
cd vps-dashboard
```

### 2. 前端构建

```bash
cd frontend-vite
npm ci
npm run build
# 产物输出到 ../frontend-dist
```

### 3. 配置后端环境变量

```bash
cd ../backend
cp .env.example .env
nano .env
```

### 4. 启动服务

```bash
docker compose up -d
```

### 5. 访问

- 公开页：`http://服务器IP/`
- 管理后台：`http://服务器IP/admin.html` 或 `http://服务器IP/admin`
- API：`http://服务器IP:5000`

## 安全配置提醒（生产环境）

- 请务必替换 `SECRET_KEY` 与 `JWT_SECRET_KEY`，且两者不得相同。
- `ADMIN_DEFAULT_PASSWORD` 建议设置为强密码；若留空，系统会在首次启动时随机生成并输出到日志，需立即登录修改。
- `JWT_BLOCKLIST_FAIL_OPEN` 默认为 `1`（Redis 异常时放行，优先高可用）；如你的场景更重视安全一致性，建议改为 `0`（异常即拒绝）。

## GitHub Actions 自动部署

在仓库 Settings → Secrets → Actions 添加：

| Secret | 说明 |
|--------|------|
| `VPS_HOST` | 服务器 IP |
| `VPS_USER` | SSH 用户名（如 root）|
| `VPS_SSH_KEY` | SSH 私钥（`cat ~/.ssh/id_rsa`）|

配置后，每次 `git push main` 自动触发：
1. 运行后端测试 + 前端构建检查
2. 远程执行 `frontend-vite` 构建，产出 `frontend-dist/`
3. 重启 `backend/docker-compose.yml` 服务完成部署

## 技术栈

**前端**: Vite + JavaScript + Workbox PWA + Chart.js  
**后端**: Flask · SQLAlchemy · PyMySQL · Redis · APScheduler · JWT · Gunicorn  
**基础设施**: MySQL 8 · Redis 7 · Docker Compose · Nginx · Let's Encrypt
