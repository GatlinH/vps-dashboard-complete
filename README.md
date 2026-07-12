# VPS Dashboard Complete

VPS Dashboard Complete 是一套自托管 VPS 资产展示、监控和运维管理平台。默认部署方式已经切换为 **GHCR Docker 镜像部署**：VPS 不再本机构建前端/后端镜像，只拉取 GitHub Actions 发布好的镜像运行。

## 功能概览

- **公开展示页**：3D 地球、星图背景、VPS 节点落点、状态摘要和移动端适配。
- **节点详情页**：CPU、内存、磁盘、网络吞吐、PING、数据新鲜度、全球探针延迟、运行环境和节点资产信息。
- **管理员后台**：服务器管理、用户/角色、登录设置、通知规则、站点外观、GeoIP、备份、审计日志和版本更新。
- **Agent 采集**：安装脚本自动注册宿主机 Agent，定时回传系统指标、运行环境、网络指标、探针结果和 Agent 版本。
- **通知告警**：Telegram Bot 配置、告警规则、测试发送和手动通知。
- **安全基线**：JWT/RBAC、限速、安全响应头、CSRF、审计记录、敏感配置隔离和发布前安全扫描。

## 架构

```text
浏览器 / 移动端
   │
   ├─ /                  公开首页
   ├─ /?server=<id>      VPS 详情页
   └─ /admin.html        管理后台
          │
          ▼
Caddy/Nginx/静态代理 :80/:443
          │
          └─ frontend 容器 127.0.0.1:9119
                 │
                 └─ /api/* → api 容器 :5000
                              │
                              ├─ MySQL 8
                              ├─ Redis 7
                              ├─ Agent consumer
                              └─ Watchtower 手动镜像更新

宿主机 vps-agent.service → POST /api/v1/agent/push
```

## 默认镜像

| 服务 | 镜像 |
|---|---|
| API / schema_init / agent_consumer | `ghcr.io/gatlinh/vps-dashboard-complete-backend:latest` |
| 前端 | `ghcr.io/gatlinh/vps-dashboard-complete-frontend:latest` |
| MySQL | `mysql:8.0.33` |
| Redis | `redis:7-alpine` |
| Watchtower | `containrrr/watchtower:latest` |

GitHub Actions 工作流：

```text
.github/workflows/deploy.yml
```

每次 push 到 `main` 后会跑 CI，并发布 backend/frontend 镜像到 GHCR。

## 快速部署

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
sudo ./install.sh
```

安装脚本会：

1. 安装/检查 Docker 和 Compose；
2. 生成 `/etc/vps-dashboard/secrets.env`；
3. 生成 `WATCHTOWER_HTTP_API_TOKEN`；
4. `docker compose pull` 拉取 GHCR 镜像；
5. `docker compose up -d --no-build` 启动服务；
6. 配置 Caddy：公网 `:80` → `127.0.0.1:9119`；
7. 安装宿主机只读 Agent 并注册为主控节点。

> 重点：默认安装不再执行 `npm run build` 或 `docker compose build`。构建发生在 GitHub Actions，VPS 只拉镜像。

## 私有 GHCR 镜像

如果 GHCR package 是 private，需要在 VPS 上先登录一次：

```bash
echo '<GHCR_READ_TOKEN>' | docker login ghcr.io -u '<GITHUB_USER>' --password-stdin
```

Token 只需要：

```text
read:packages
```

也可以把 GHCR package visibility 改成 public，避免 VPS 持有 GitHub token。

## 手动启动/更新

### 启动

```bash
docker compose --env-file /etc/vps-dashboard/secrets.env pull
docker compose --env-file /etc/vps-dashboard/secrets.env up -d --no-build
```

### 更新

推荐：后台 `诊断 / 日志 → 版本更新 → 检查更新 / 更新容器镜像`。

后台更新功能现在语义是：

```text
检查更新：读取 GHCR 镜像 manifest，不重启服务
更新容器镜像：调用 Watchtower HTTP API 拉取最新镜像并滚动重启容器
```

命令行也可以：

```bash
cd /opt/vps-dashboard-complete
sudo ./update.sh
```

`update.sh` 会：

```text
git pull                  # 同步 compose、脚本、README 等仓库文件
docker compose pull       # 拉取 GHCR 镜像
docker compose up -d --no-build
同步宿主机 Agent
```

## 宿主机 Agent

Agent 仍运行在宿主机 systemd 中，用于读取主机指标：

```text
/opt/vps-agent/agent.py
/etc/systemd/system/vps-agent.service
```

安装/同步命令：

```bash
sudo ./scripts/install-master-agent.sh
```

Agent 会上报：

```text
agent_config.inventory_meta.agent_version
```

后台“检查更新”会展示宿主机 Agent 当前版本/期望版本。如果 Agent 需要同步，运行：

```bash
sudo ./scripts/install-master-agent.sh
# 或
sudo ./update.sh
```

## 本机源码构建/开发模式

默认生产部署不构建源码。需要开发或紧急回退到本机构建时，使用 override：

```bash
docker compose \
  --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml \
  -f docker-compose.build.yml \
  up -d --build
```

## 访问入口

| 页面 | 路径 | 权限 |
|---|---|---|
| 公开首页 | `/` 或 `/index.html` | 公开 |
| VPS 详情 | `/?server=<id>` | 公开展示字段，运行环境会做指纹脱敏 |
| 管理后台 | `/admin.html` 或 `/admin` | 登录/RBAC |
| API 健康检查 | `/health` | 公开/本地检查 |

HTTP 默认端口是 `80`，所以 `http://服务器IP/` 等价于 `http://服务器IP:80/`。

## 本次安装问题对应修复

- 初装缺字段：`schema_init` 使用当前 backend 镜像的 SQLAlchemy 模型 `db.create_all()` 初始化。
- 初装 Ping 目标：未配置时返回空目标结构，不再注入外部默认目标。
- 后台“服务器版本/Agent 版本”为空：Agent 上报 `agent_version`，后端保存到 `inventory_meta.agent_version`。
- Docker healthcheck 过频：健康检查间隔调大，避免安装后 CPU 被 healthcheck 打满。
- 后台更新语义混乱：默认改为 GHCR/Watchtower 镜像更新；源码构建仅作为开发/回退模式。
- 宿主机 Agent：由安装/更新脚本同步，后台展示版本状态。

## 安全要求

生产环境至少满足：

- API 只监听 `127.0.0.1:5000` 或容器私有网络，不直接暴露公网。
- MySQL、Redis 不暴露公网。
- `.env`、`secrets.env`、真实 allowlist、备份、数据库 dump 和构建产物不入库。
- 管理、备份、Telegram 配置、用户管理等接口必须登录并按角色授权。
- GitHub/GHCR token 如泄露，应立即撤销并轮换。

验证：

```bash
python3 scripts/security-scan.py --include-dist
PUBLIC_URL=http://your-host API_LOCAL_URL=http://127.0.0.1:5000 deploy/security-check.sh
```

更多见：[`docs/SECURITY_DEPLOYMENT.md`](docs/SECURITY_DEPLOYMENT.md)。

## License

按仓库实际许可证为准；如果计划公开发布，请在发布前补充明确的 `LICENSE` 文件。
