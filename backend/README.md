# VPS 星图 · Flask 后端

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

## API 端点速览

| 方法   | 路径                          | 说明                       |
|--------|-------------------------------|----------------------------|
| POST   | /api/auth/login               | 登录，返回 JWT             |
| POST   | /api/auth/refresh             | 刷新 Access Token          |
| GET    | /api/auth/me                  | 当前用户信息               |
| GET    | /api/servers/                 | 服务器列表（Redis 缓存）    |
| POST   | /api/servers/                 | 添加服务器 *               |
| PUT    | /api/servers/<id>             | 更新服务器 *               |
| DELETE | /api/servers/<id>             | 删除服务器 *               |
| POST   | /api/servers/<id>/metrics     | 推送实时指标 *             |
| GET    | /api/servers/<id>/history     | 历史探针数据 *             |
| POST   | /api/probe/ping               | TCP Ping *                 |
| POST   | /api/probe/ping/batch         | 批量 TCP Ping *            |
| POST   | /api/probe/fetch-probe        | 抓取探针数据 *             |
| GET    | /api/probe/ip-info?ip=x.x.x.x | IP 地理信息               |
| GET    | /api/telegram/config          | Telegram 配置 *            |
| POST   | /api/telegram/config          | 保存 Bot 配置 *            |
| POST   | /api/telegram/test            | 发送测试消息 *             |
| POST   | /api/telegram/send            | 手动推送消息 *             |
| GET    | /api/geo/tile/<z>/<x>/<y>.png | 地图瓦片代理               |
| GET    | /api/geo/countries            | TopoJSON 矢量地图          |
| GET    | /api/geo/servers/coords       | 服务器经纬度列表           |

*标记需要 JWT Authorization: Bearer <token> 请求头*

## 前端对接

```js
// 登录
const { access_token } = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' })
}).then(r => r.json());

// 获取服务器列表
const { servers } = await fetch('/api/servers/', {
  headers: { Authorization: `Bearer ${access_token}` }
}).then(r => r.json());

// 3D 星图瓦片（直接替换 CARTO URL）
// 将前端 fetch tile 的 URL 改为：
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
