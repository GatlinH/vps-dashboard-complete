# 上线部署检查清单 (Deploy Checklist)

在将本项目部署到生产环境前，请逐项确认以下检查点。  
未完成 P0 项目时，**请勿上线**。

---

## P0 — 必须完成（上线阻断项）

### 🔐 安全与密钥

- [ ] `SECRET_KEY` 已修改为长度 ≥ 32 的随机字符串  
      ```bash
      python -c "import secrets; print(secrets.token_hex(32))"
      ```
- [ ] `JWT_SECRET_KEY` 已修改为独立的长度 ≥ 32 随机字符串（与 SECRET_KEY 不同）
- [ ] `MYSQL_PASSWORD` 和 `MYSQL_ROOT_PASSWORD` 已改为强密码
- [ ] `MASTER_ENCRYPTION_KEY` 已设置为随机强密钥
- [ ] `.env` 文件未提交到 Git（确认 `.gitignore` 包含 `.env`）
- [ ] 管理员初始密码已通过 `ADMIN_DEFAULT_PASSWORD` 设置，或首次启动后立即修改
- [ ] `CORS_ORIGINS` 仅包含正式域名，已删除 localhost 条目

### 🐳 容器与服务

- [ ] `docker-compose.yml` 所有关键服务均有 `restart: unless-stopped`（已默认配置）
- [ ] MySQL、Redis、API 均配置了 `healthcheck`（已默认配置）
- [ ] `depends_on` 使用健康条件（`condition: service_healthy`）（已默认配置）
- [ ] MySQL（3306）和 Redis（6379）端口仅绑定 `127.0.0.1`，不对公网开放（已默认配置）
- [ ] API 端口 5000 不直接暴露公网（通过 Nginx 代理）

### 🌐 网络与防火墙

- [ ] 防火墙仅开放 80（HTTP）和 443（HTTPS）端口
- [ ] SSH 登录使用密钥认证，已禁用密码登录
- [ ] root 用户直接登录已禁用或受限

### 📦 数据库

- [ ] 数据库已成功初始化（`init_db.sql` 已执行）
- [ ] 备份策略已配置（见 `backend/BACKUP_AND_ROLLBACK.md`）
- [ ] 至少完成一次备份恢复演练，确认可以从备份恢复

### ✅ 功能回归（最小上线验证）

- [ ] 登录 / 刷新 Token / 鉴权失败路径已验证
- [ ] 服务器 CRUD 全流程验证通过
- [ ] TCP Ping 单点与批量探测正常
- [ ] Telegram 测试消息发送成功（若已配置）
- [ ] 健康检查端点可访问：`curl http://localhost:5000/health`

---

## P1 — 建议完成（影响稳定性）

### 🧪 测试与 CI

- [ ] `pytest tests/ -v` 在本地全部通过
- [ ] `frontend-vite` 已执行 `npm ci && npm run build`，并确认 `frontend-dist/index.html`、`frontend-dist/admin.html`、`frontend-dist/sw.js` 存在
- [ ] CI 流水线（GitHub Actions）正常，`deploy` Job 的 `needs: test` 已生效
- [ ] 测试覆盖核心模块：auth、servers、probe（建议覆盖率 ≥ 60%）

### 📊 监控与观测

- [ ] 结构化日志（method/path/status/latency）已输出到容器日志
- [ ] 关键错误（5xx、DB/Redis 连接失败）通过 Telegram 或其他方式告警
- [ ] 磁盘、内存、CPU 监控已接入（可使用宿主机监控工具）
- [ ] 容器重启次数纳入监控（`docker stats` 或监控工具）

### ⚡ 性能

- [ ] Nginx 启用 gzip 压缩（`gzip on;` 已在 nginx.conf 中配置）
- [ ] 前端静态资源缓存头已配置
- [ ] 50 并发下关键 API P95 延迟 < 500ms（压测验证）

### 🔄 回滚能力

- [ ] 当前部署版本（镜像 tag 或 git commit）已记录
- [ ] 回滚操作流程已验证（见 `backend/BACKUP_AND_ROLLBACK.md`）
- [ ] 至少完成一次回滚演练

---

## P3F — Nginx 限流配置收敛（limit_req_zone）

- [ ] `backend/nginx-main.conf` 已存在，内含 `limit_req_zone` 定义（`http {}` 级别）
- [ ] `backend/docker-compose.yml` nginx 服务已挂载 `nginx-main.conf` → `/etc/nginx/nginx.conf`
- [ ] `docker compose up -d` 后 nginx 容器正常运行：`docker compose ps nginx`
- [ ] 配置语法通过：`docker compose exec nginx nginx -t`
- [ ] 常规请求返回 200（未触发限流）
- [ ] 压测可触发 429：`ab -n 200 -c 50 http://localhost/api/v1/health`
- [ ] 日志可见限流字段：`docker compose exec nginx grep "REJECTED" /var/log/nginx/access.log`
- [ ] 容器重启后配置仍自动生效（无需手工补配置）

> 详细验证步骤与回滚方案见 `docs/nginx-rate-limiting.md`。

---

## P2 — 上线后 1~2 周内补齐

- [ ] 登录失败次数限制与临时锁定
- [ ] 审计日志定期归档策略
- [ ] API 权限细化（从单管理员到角色模型）
- [ ] 离线页与 Service Worker 缓存策略精细化
- [ ] 国际化文案完整性检查（i18n key 缺失扫描）
- [ ] `DEPLOY_CHECKLIST.md` 固化进发布流程（作为 PR 模板检查项）

---

## 上线 Go / No-Go 判断

```
✅ P0 全部完成
✅ P1 至少完成 70%
✅ 完成一次预生产全链路演练（登录→CRUD→探测→告警→导出）
✅ 演练中无 P0/P1 阻断级问题
→ Go ✅

否则 → No-Go ❌（记录未完成原因并制定修复计划）
```

---

## HTTPS 配置（Let's Encrypt）

### 快速申请证书

```bash
# 安装 certbot
apt install -y certbot python3-certbot-nginx

# 申请证书（自动配置 Nginx）
certbot --nginx -d your-domain.com

# 验证自动续期
certbot renew --dry-run
```

### 手动激活 nginx.conf 中的 HTTPS 配置

1. 将 `backend/nginx.conf` 中 HTTP server 块内的功能配置（location、add_header、gzip）移至 HTTPS server 块
2. HTTP server 块只保留 `return 301 https://$host$request_uri;`
3. 取消 HTTPS server 块的注释
4. 填入实际的 `server_name` 和证书路径
5. `docker compose exec nginx nginx -s reload`

---

*最后更新：请在每次部署前更新此文件的完成状态。*
