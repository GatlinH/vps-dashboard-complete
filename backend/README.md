# VPS 星图 · Flask 后端

## 依赖管理

本项目使用 `pip-tools` 管理 Python 依赖版本：

- **`requirements.in`**：直接依赖的宽松约束（`>=`），是人工维护的源文件
- **`requirements.txt`**：精确版本锁定（`==`），由 `pip-compile` 自动生成，不应手动修改

如需添加或升级依赖：
1. 修改 `requirements.in`
2. 运行以下命令重新生成 `requirements.txt`：
   ```bash
   pip install pip-tools
   pip-compile requirements.in -o requirements.txt
   ```
3. 提交 `requirements.in` 和 `requirements.txt` 的变更

---

## 数据库迁移（Flask-Migrate）

首次初始化（已有数据库时只需执行一次）：
```bash
flask db init
flask db migrate -m "initial schema"
flask db upgrade
```

新增字段时：
```bash
flask db migrate -m "描述变更内容"
flask db upgrade    # 应用到数据库
flask db downgrade  # 回滚（如需要）
```

---

## 目录结构

```
backend/
├── app.py                  # Flask 入口 & create_app()
├── config.py               # 配置（MySQL / Redis / JWT / CORS）
├── extensions.py           # db / jwt / redis_client 共享实例
├── requirements.txt        # Python 依赖
├── init_db.sql             # MySQL 初始化脚本
├── .env.example            # 环境变量模板 → 复制为 .env
├── Dockerfile              # 容器镜像
├── docker-compose.yml      # MySQL + Redis + Flask + Nginx
├── nginx.conf              # Nginx 反向代理配置
│
├── api/
│   ├── auth.py             # /api/auth   — 登录/JWT/修改密码
│   ├── servers.py          # /api/servers — CRUD + 实时指标推送
│   ├── probe.py            # /api/probe  — TCP Ping / IP查询 / 探针抓取
│   ├── telegram.py         # /api/telegram — Bot配置/发消息/告警规则
│   └── geo.py              # /api/geo    — 瓦片代理 / 坐标查询
│
├── models/
│   └── models.py           # SQLAlchemy 数据模型
│
└── services/
    └── scheduler.py        # APScheduler 后台定时任务
```

## 快速启动

### 1. 环境准备

```bash
cd backend
cp .env.example .env
# 编辑 .env，填入 MySQL / Redis 密码和密钥
```

### 2. 本地开发

```bash
# 创建虚拟环境
python3 -m venv venv && source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 初始化数据库（确保 MySQL 已启动）
mysql -u root -p < init_db.sql

# 启动 Flask
python app.py
# API 运行在 http://localhost:5000
```

### 3. Docker 一键部署（推荐）

```bash
# 修改 docker-compose.yml 中的密码
docker compose up -d

# 带 Nginx（生产）
docker compose --profile production up -d

# 查看日志
docker compose logs -f api
```

### 4. 并发配置说明

本项目使用 APScheduler 运行后台定时任务（TCP Ping、数据清理、告警等），**Gunicorn workers 必须保持为 1**，否则多个 worker 会重复执行调度器任务。提升并发请使用线程模式：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GUNICORN_WORKERS` | `1` | **不建议修改**，保持为 1 以避免调度器重复执行 |
| `GUNICORN_THREADS` | `4` | 可按服务器 CPU 核心数调整（推荐 2×CPU+1） |

```bash
# .env 中调整线程数（例如 4 核服务器）
GUNICORN_WORKERS=1
GUNICORN_THREADS=9
```

## API 端点速览

### 权限说明

| 标记 | 含义 |
|------|------|
| （公开） | 无需鉴权，匿名可访问 |
| `*JWT*` | 需要 `Authorization: Bearer <token>` 头（任意登录用户） |
| `**admin**` | 需要 JWT 且角色为 `admin` |

### 端点列表

| 方法   | 路径                          | 权限      | 说明                       |
|--------|-------------------------------|-----------|----------------------------|
| POST   | /api/auth/login               | 公开      | 登录，返回 JWT             |
| POST   | /api/auth/refresh             | *JWT*     | 刷新 Access Token          |
| GET    | /api/auth/me                  | *JWT*     | 当前用户信息               |
| GET    | /api/servers/                 | 公开      | 服务器列表（未登录时过滤敏感字段） |
| POST   | /api/servers/                 | **admin** | 添加服务器                 |
| PUT    | /api/servers/\<id\>           | **admin** | 更新服务器                 |
| DELETE | /api/servers/\<id\>           | **admin** | 删除服务器                 |
| POST   | /api/servers/\<id\>/metrics   | **admin** | 推送实时指标               |
| GET    | /api/servers/\<id\>/history   | **admin** | 历史探针数据               |
| POST   | /api/probe/ping               | **admin** | TCP Ping                   |
| POST   | /api/probe/ping/batch         | **admin** | 批量 TCP Ping              |
| POST   | /api/probe/fetch-probe        | **admin** | 抓取探针数据               |
| GET    | /api/probe/ip-info?ip=x.x.x.x | 公开     | IP 地理信息                |
| GET    | /api/telegram/config          | **admin** | Telegram 配置              |
| POST   | /api/telegram/config          | **admin** | 保存 Bot 配置              |
| POST   | /api/telegram/test            | **admin** | 发送测试消息               |
| POST   | /api/telegram/send            | **admin** | 手动推送消息               |
| GET    | /api/telegram/alerts          | **admin** | 获取告警规则               |
| POST   | /api/telegram/alerts          | **admin** | 保存告警规则               |
| GET    | /api/geo/tile/\<z\>/\<x\>/\<y\>.png | 公开 | 地图瓦片代理          |
| GET    | /api/geo/countries            | 公开      | TopoJSON 矢量地图          |
| GET    | /api/geo/servers/coords       | 公开      | 服务器经纬度列表           |

### 后台鉴权要求

- 所有写操作（添加/更新/删除服务器、Telegram 配置、推送消息等）均需 JWT 且 `role == "admin"`
- `backend/middleware/rbac.py` 中的 `@admin_required` 装饰器统一实现角色校验
- 严禁仅依赖前端隐藏按钮实现"权限控制"——后端会独立校验每个请求的角色

## Service Worker 缓存策略

| 路径 | 策略 | 说明 |
|------|------|------|
| 公开静态资源（.html/.js/.css等） | 缓存优先 | public.html 及 JS 模块可离线访问 |
| `/admin.html` | **network-only** | 管理页面不缓存，强制在线访问 |
| `/api/auth/*` | **network-only** | 鉴权接口不缓存 |
| `/api/servers/*` | **network-only** | 服务器数据不缓存 |
| `/api/probe/*` | **network-only** | 探针数据不缓存 |
| `/api/telegram/*` | **network-only** | Telegram 配置不缓存 |

## 前端对接

```js
// 公开展示页使用 api-public.js（无鉴权）
import { listServersPublic, getCountries } from './api-public.js';
const { servers } = await listServersPublic();

// 管理后台使用 api-admin.js（自动携带 JWT）
import { login, createServer } from './api-admin.js';
await login('admin', '<your-admin-password>');
await createServer({ name: 'my-vps', ip: '1.2.3.4', ... });

// 3D 星图瓦片（公开接口）
const tileUrl = `/api/geo/tile/${z}/${x}/${y}.png`;
```

## Redis 缓存键说明

| 键                          | 内容                | TTL    |
|-----------------------------|---------------------|--------|
| vps:servers:list            | 服务器列表 JSON      | 15s    |
| vps:server:{id}:metrics     | 单台实时指标         | 15s    |
| vps:tile:{z}:{x}:{y}        | 地图瓦片二进制       | 24h    |
| vps:geo:countries-110m      | TopoJSON 矢量数据   | 7d     |
| vps:ipgeo:{ip}              | IP 地理信息          | 1h     |
| vps:ipinfo:{ip}             | IP 详细信息          | 1h     |
| vps:coords:{ip}             | IP 经纬度            | 24h    |

## HTTPS 配置（Let's Encrypt）

```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx

# 申请证书（自动配置 Nginx）
certbot --nginx -d your-domain.com

# 验证自动续期
certbot renew --dry-run
```

详细步骤请参阅 [DEPLOY_CHECKLIST.md](../DEPLOY_CHECKLIST.md#https-配置lets-encrypt)。
