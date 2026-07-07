# GHCR + 后台手动更新部署

该方案让 GitHub Actions 只负责测试、构建镜像、推送到 GitHub Container Registry (GHCR)，不再通过 SSH 登录 VPS。VPS 侧不自动更新；管理员在后台面板点击“检查更新 / 应用更新”后才更新。

## 流程

```text
git push main
  -> GitHub Actions 跑 CI gate
  -> 构建并推送两个镜像
     - ghcr.io/gatlinh/vps-dashboard-complete-backend:latest
     - ghcr.io/gatlinh/vps-dashboard-complete-frontend:latest
  -> 后台面板“检查更新”只读查看镜像清单
  -> 管理员点击“应用更新”后，Watchtower HTTP API 才 pull + rolling restart
```

## GitHub Actions

`.github/workflows/deploy.yml` 为 `Publish Docker Image`：

- 复用 `ci.yml` 作为测试 gate；
- 使用 `GITHUB_TOKEN` 登录 GHCR；
- 发布 backend/frontend 两个镜像；
- 不需要 `VPS_HOST`、`VPS_USER`、`VPS_PASSWORD`、`VPS_SSH_KEY`。

## VPS 首次启用

在 `/etc/vps-dashboard/secrets.env` 增加一个随机 token：

```env
WATCHTOWER_HTTP_API_TOKEN=换成一串随机长字符串
```

首次启动会运行一次 `schema_init` 容器，用当前 backend 镜像的 SQLAlchemy 模型创建数据库表；不再使用旧的 `backend/init_db.sql` 初始化业务表，避免新装缺字段。

然后在 VPS 项目目录执行：

```bash
cd /opt/vps-dashboard

git pull origin main

docker compose \
  --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml \
  -f docker-compose.ghcr.yml \
  pull

docker compose \
  --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml \
  -f docker-compose.ghcr.yml \
  up -d --no-build

# 首次部署/迁移后，把宿主机注册为“主控节点”并安装只读 Agent
sudo ./scripts/install-master-agent.sh
```

> `--no-build` 很重要：确保使用 GHCR 镜像，而不是在 VPS 本机重新构建。
>
> `install-master-agent.sh` 会在宿主机创建/更新 `/opt/vps-agent` 和 `vps-agent.service`，并在数据库中创建/复用一个 `agent_config.install_role=master` 的主控节点。它是幂等的，重跑会复用已有有效 key；如果 key 已失效才会轮换。

验证主控 Agent：

```bash
systemctl is-active vps-agent.service
curl -sS http://127.0.0.1:5000/api/v1/servers/ | python3 -m json.tool | sed -n '1,80p'
```

预期至少有一个 `status: online` 的主控节点，首页可点击进入详情页并看到 CPU/内存/网络图表。

## 后台按钮

后台“诊断 / 日志”页会显示“版本更新”卡片：

- **刷新状态**：显示当前手动更新模式；
- **检查更新**：只读查询 GHCR 镜像 manifest，不重启服务；
- **应用更新**：管理员确认后调用 `http://watchtower:8080/v1/update`，由 Watchtower 拉取新镜像并滚动重启。

## 端口/反代

`frontend` 容器监听宿主机：

```text
127.0.0.1:9119 -> container:80
```

这匹配现有 Caddy 反代：

```caddy
reverse_proxy 127.0.0.1:9119
```

前端 Nginx 会把 `/api/*` 反代到 Docker 网络里的 `api:5000`。

## Watchtower（手动触发模式）

`docker-compose.ghcr.yml` 增加：

- `watchtower` 服务；
- 只更新带 `com.centurylinklabs.watchtower.enable=true` 的容器；
- 启用内部 HTTP API `http://watchtower:8080/v1/update`；
- 不做定时自动轮询，只有后台按钮触发时才更新；
- 自动清理旧镜像；
- rolling restart。

查看日志：

```bash
docker logs -f vps_watchtower
```

命令行也可手动触发更新：

```bash
curl -H "Authorization: Bearer $WATCHTOWER_HTTP_API_TOKEN" \
  -X POST http://127.0.0.1:8080/v1/update
```

## 私有镜像访问

如果 GHCR package 是 private，需要在 VPS 上登录一次 GHCR：

```bash
echo '<GHCR_TOKEN>' | docker login ghcr.io -u '<GITHUB_USER>' --password-stdin
```

建议把 package visibility 改成 public，或使用只读 `read:packages` token。

## 回滚

可以把 compose override 中的镜像 tag 从 `latest` 改成某个 SHA tag，例如：

```yaml
image: ghcr.io/gatlinh/vps-dashboard-complete-backend:sha-<commit>
```

然后：

```bash
docker compose --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml -f docker-compose.ghcr.yml up -d --no-build
```
