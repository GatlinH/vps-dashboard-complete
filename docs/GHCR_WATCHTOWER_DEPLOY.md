# GHCR + Watchtower 自动部署

该方案让 GitHub Actions 只负责测试、构建镜像、推送到 GitHub Container Registry (GHCR)，不再通过 SSH 登录 VPS。

## 流程

```text
git push main
  -> GitHub Actions 跑 CI gate
  -> 构建并推送两个镜像
     - ghcr.io/gatlinh/vps-dashboard-complete-backend:latest
     - ghcr.io/gatlinh/vps-dashboard-complete-frontend:latest
  -> VPS 上的 watchtower 每 300 秒检查镜像
  -> 自动 pull + rolling restart
```

## GitHub Actions

`.github/workflows/deploy.yml` 已改为 `Publish Docker Image`：

- 复用 `ci.yml` 作为测试 gate；
- 使用 `GITHUB_TOKEN` 登录 GHCR；
- 发布 backend/frontend 两个镜像；
- 不需要 `VPS_HOST`、`VPS_USER`、`VPS_PASSWORD`、`VPS_SSH_KEY`。

## VPS 首次启用

在 VPS 项目目录执行：

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
```

> `--no-build` 很重要：确保使用 GHCR 镜像，而不是在 VPS 本机重新构建。

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

## Watchtower

`docker-compose.ghcr.yml` 增加：

- `watchtower` 服务；
- 只更新带 `com.centurylinklabs.watchtower.enable=true` 的容器；
- 每 300 秒检查；
- 自动清理旧镜像；
- rolling restart。

查看日志：

```bash
docker logs -f vps_watchtower
```

手动触发更新：

```bash
docker compose \
  --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml \
  -f docker-compose.ghcr.yml \
  pull frontend api agent_consumer

docker compose \
  --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml \
  -f docker-compose.ghcr.yml \
  up -d --no-build frontend api agent_consumer
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
