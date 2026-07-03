# VPS Dashboard Complete

VPS Dashboard Complete 是一套自托管 VPS 资产展示、监控和运维管理平台。它把公开的星图/地球展示页、节点详情页、管理员后台、Agent 数据采集、探针延迟、流量历史和 Telegram 告警整合在一个项目中，适合用于个人或小团队管理多台 VPS。

## 功能概览

- **公开展示页**：3D 地球、星图背景、VPS 节点落点、状态摘要和移动端适配。
- **节点详情页**：CPU、内存、磁盘、网络吞吐、PING、数据新鲜度、全球探针延迟和节点资产信息。
- **管理员后台**：服务器管理、用户/角色、登录设置、通知规则、站点外观、GeoIP、备份和审计日志。
- **Agent 采集**：安装脚本自动注册 Agent，定时回传系统指标、网络指标和探针结果。
- **通知告警**：Telegram Bot 配置、告警规则、测试发送和手动通知。
- **安全基线**：JWT/RBAC、限速、安全响应头、CSRF、审计记录、敏感配置隔离和发布前安全扫描。
- **部署弹性**：项目不绑定 Caddy/Nginx；安装人可以选择 Caddy、Nginx、云负载均衡或内置静态代理。

## 架构

```text
浏览器 / 移动端
   │
   ├─ /                  公开首页
   ├─ /?server=<id>      VPS 详情页
   └─ /admin.html        管理后台
          │
          ▼
HTTP 入口 :80/:443，按部署选择 Caddy/Nginx/静态代理
          │
          ├─ 静态文件 frontend-dist/
          └─ /api/* → Flask/Gunicorn API，默认只绑定 127.0.0.1:5000 或容器内网
                         │
                         ├─ MySQL 8
                         ├─ Redis 7
                         ├─ APScheduler
                         └─ Agent consumer
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | Vite、JavaScript、React、Three.js、Cesium、Chart.js、Pixi.js、Workbox PWA |
| 后端 | Flask、SQLAlchemy、PyMySQL、Redis、APScheduler、JWT、Gunicorn |
| 部署 | Docker Compose、MySQL、Redis、可选 Caddy/Nginx/静态代理 |
| 通知 | Telegram Bot API |
| 安全 | RBAC、限速、CSRF、安全头、审计日志、发布扫描脚本 |

## 目录结构

```text
.
├── backend/                 # Flask API、模型、服务、测试和后端镜像
├── frontend-vite/           # Vite 前端源码
├── scripts/                 # Agent 和安全扫描脚本
├── deploy/                  # 部署后自检脚本
├── docs/                    # 部署/API/安全文档
├── docker-compose.yml       # API、MySQL、Redis、Agent consumer
├── install.sh               # 一键安装脚本
├── update.sh                # 更新脚本
└── README.md
```

> `frontend-dist/` 是构建产物，默认不提交到 Git，由部署或 CI 生成。

## 快速部署

### 一键安装

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
sudo ./install.sh
```

安装脚本会检查 Docker、准备 `/etc/vps-dashboard/secrets.env`、启动 Docker Compose 服务，并在需要时生成初始配置模板。

### 手动 Docker Compose

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
cp backend/.env.example .env
# 编辑 .env，填入强随机密钥和数据库/Redis 密码
docker compose up -d --build
```

前端构建：

```bash
cd frontend-vite
npm ci
npm run build
```

## 访问入口

| 页面 | 路径 | 权限 |
|---|---|---|
| 公开首页 | `/` 或 `/index.html` | 公开 |
| VPS 详情 | `/?server=<id>` | 公开展示字段 |
| 管理后台 | `/admin.html` 或 `/admin` | 登录/RBAC |
| API 健康检查 | `/health` | 公开/本地检查 |

HTTP 默认端口是 `80`，所以 `http://服务器IP/` 等价于 `http://服务器IP:80/`。

## 安全要求

生产环境至少满足：

- API 只监听 `127.0.0.1:5000` 或容器私有网络，不直接暴露公网。
- MySQL、Redis 不暴露公网。
- `.env`、`secrets.env`、真实 allowlist、备份、数据库 dump 和构建产物不入库。
- 管理、备份、Telegram 配置、用户管理等接口必须登录并按角色授权。
- 发布前运行安全扫描和部署边界检查。

验证：

```bash
python3 scripts/security-scan.py --include-dist
PUBLIC_URL=http://your-host API_LOCAL_URL=http://127.0.0.1:5000 deploy/security-check.sh
```

更多见：[`docs/SECURITY_DEPLOYMENT.md`](docs/SECURITY_DEPLOYMENT.md)。

## 开发

前端：

```bash
cd frontend-vite
npm ci
npm run dev
```

后端：

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
flask run
```

测试/检查：

```bash
cd backend && pytest
cd ../frontend-vite && npm run build
python3 scripts/security-scan.py
```

## 运维说明

- 是否安装 Caddy/Nginx 由安装人决定；项目只要求公网入口与内部 API/数据库之间有明确边界。
- 公网只应开放必要端口。Dashboard 常见入口是 `80/443`，其他业务端口应按用途加防火墙或白名单。
- Agent key、Telegram token、JWT secret、数据库密码等只放在服务器环境文件或密钥管理系统中。
- 如误把 token 发到聊天或日志中，应立即在 GitHub/BotFather 等平台轮换。

## License

按仓库实际许可证为准；如果计划公开发布，请在发布前补充明确的 `LICENSE` 文件。
