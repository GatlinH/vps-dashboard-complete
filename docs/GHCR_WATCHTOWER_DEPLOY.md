# GHCR + Watchtower 镜像部署

VPS Dashboard 默认生产部署方式是 GHCR 镜像部署：GitHub Actions 构建并推送镜像，VPS 只负责拉镜像和运行容器。

## 流程

```text
git push main
  -> GitHub Actions 跑 CI gate
  -> 构建并推送镜像
     - ghcr.io/gatlinh/vps-dashboard-complete-backend:latest
     - ghcr.io/gatlinh/vps-dashboard-complete-frontend:latest
  -> VPS docker compose pull
  -> docker compose up -d --no-build
```

## GitHub Actions

`.github/workflows/deploy.yml`：

- 复用 `ci.yml` 作为测试 gate；
- 使用 `GITHUB_TOKEN` 登录 GHCR；
- 发布 backend/frontend 两个镜像；
- 不需要 GitHub Actions 持有 VPS SSH 密钥。

## VPS 首次启用

```bash
git clone https://github.com/GatlinH/vps-dashboard-complete.git
cd vps-dashboard-complete
sudo ./install.sh
```

安装脚本会生成 `/etc/vps-dashboard/secrets.env`，包括：

```env
WATCHTOWER_HTTP_API_TOKEN=<random>
```

然后执行：

```bash
docker compose --env-file /etc/vps-dashboard/secrets.env pull
docker compose --env-file /etc/vps-dashboard/secrets.env up -d --no-build
```

> `--no-build` 很重要：确保 VPS 使用 GHCR 镜像，不在本机重新构建。

## 后台按钮

后台“诊断 / 日志 → 版本更新”：

- **刷新状态**：显示 GHCR 镜像部署模式和宿主机 Agent 版本状态；
- **检查更新**：只读查询 GHCR 镜像 manifest，不重启服务；
- **更新容器镜像**：管理员确认后调用 Watchtower HTTP API，拉取最新镜像并滚动重启。

## 宿主机 Agent

Agent 仍运行在宿主机上，因为它需要读取宿主机指标：

```text
/opt/vps-agent/agent.py
/etc/systemd/system/vps-agent.service
```

同步命令：

```bash
sudo ./scripts/install-master-agent.sh
# 或 sudo ./update.sh
```

## 私有镜像访问

如果 GHCR package 是 private，需要在 VPS 上登录一次 GHCR：

```bash
echo '<GHCR_READ_TOKEN>' | docker login ghcr.io -u '<GITHUB_USER>' --password-stdin
```

建议使用只读 `read:packages` token，或把 package visibility 改成 public。

## 本机构建回退

如需开发或回退到源码构建：

```bash
docker compose \
  --env-file /etc/vps-dashboard/secrets.env \
  -f docker-compose.yml \
  -f docker-compose.build.yml \
  up -d --build
```

## 回滚

把镜像 tag 改为某个 SHA tag，例如：

```yaml
image: ghcr.io/gatlinh/vps-dashboard-complete-backend:sha-<commit>
```

然后：

```bash
docker compose --env-file /etc/vps-dashboard/secrets.env up -d --no-build
```
