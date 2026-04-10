# VPS 星图 · 服务器监控管理平台

一个功能完整的 VPS 监控与管理平台，包含前端单页应用和 Flask + MySQL + Redis 后端。

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

```
vps-dashboard/
├── frontend/
│   ├── public.html         # 公开展示页（无需登录）
│   ├── admin.html          # 管理后台页（需 JWT 登录）
│   ├── index.html          # 兼容入口，自动跳转到 public.html
│   ├── api-public.js       # 公开接口封装（无鉴权）
│   ├── api-admin.js        # 管理接口封装（JWT + 401/403 处理）
│   ├── service-worker.js   # PWA Service Worker（管理路径不缓存）
│   └── ...                 # 其他模块脚本
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
│   │   ├── auth.py         # 登录 / JWT
│   │   ├── servers.py      # 服务器 CRUD（写操作需 admin 角色）
│   │   ├── probe.py        # TCP Ping / 探针（需 admin 角色）
│   │   ├── telegram.py     # Bot 配置 / 推送（需 admin 角色）
│   │   └── geo.py          # 地图瓦片代理（公开）
│   ├── middleware/
│   │   └── rbac.py         # RBAC 角色校验装饰器
│   ├── models/
│   │   └── models.py       # SQLAlchemy 数据模型
│   └── services/
│       └── scheduler.py    # APScheduler 后台定时任务
└── .github/
    └── workflows/
        └── deploy.yml      # GitHub Actions 自动部署
```

## 访问方式

| 页面 | URL | 说明 |
|------|-----|------|
| 公开展示页 | `http://服务器IP/` 或 `/public.html` | 无需登录，可公开访问 |
| 管理后台 | `http://服务器IP/admin.html` 或 `/admin` | 需要管理员账号登录 |

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/你的用户名/vps-dashboard.git
cd vps-dashboard
```

### 2. 配置环境变量

```bash
cd backend
cp .env.example .env
nano .env   # 填入 MySQL 密码、JWT 密钥等
```

### 3. 启动服务

```bash
docker compose up -d
```

### 4. 访问

- 前端：打开 `frontend/public.html` 或访问 `http://服务器IP`（公开展示页）
- 管理后台：访问 `http://服务器IP/admin.html` 或 `http://服务器IP/admin`（需登录）
- API：`http://服务器IP:5000`
- 默认账号：`admin`，密码在 `.env` 的 `ADMIN_DEFAULT_PASSWORD` 中设置（留空则首次启动时随机生成并打印到容器日志）

> ⚠️ **安全警告：首次部署后必须立即登录并修改管理员密码，严禁使用 `admin123` 等弱密码上线生产环境。**

## VPS 部署

详见 [backend/README.md](backend/README.md)

## GitHub Actions 自动部署

在仓库 Settings → Secrets → Actions 添加：

| Secret | 说明 |
|--------|------|
| `VPS_HOST` | 服务器 IP |
| `VPS_USER` | SSH 用户名（如 root）|
| `VPS_SSH_KEY` | SSH 私钥（`cat ~/.ssh/id_rsa`）|

配置后，每次 `git push main` 自动部署到 VPS。

## 默认账号

> ⚠️ **安全警告：首次部署后必须立即修改管理员密码，严禁将弱密码（如 `admin123`）用于生产环境。**

通过 `.env` 中的 `ADMIN_DEFAULT_PASSWORD` 字段设置初始密码；若留空，系统首次启动时将自动生成随机强密码并打印到容器日志中。

| 账号 | 密码 | 说明 |
|------|------|------|
| admin | *(见容器日志或 .env)* | 管理员，**首次登录后请立即修改密码** |

## 技术栈

**前端**: 原生 HTML / CSS / JavaScript，Canvas 3D 渲染，CARTO 地图瓦片

**后端**: Flask · SQLAlchemy · PyMySQL · Redis · APScheduler · JWT · Gunicorn

**基础设施**: MySQL 8 · Redis 7 · Docker Compose · Nginx · Let's Encrypt
