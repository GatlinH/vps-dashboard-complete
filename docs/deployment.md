# 配置与部署（Config & Env）

本文档用于核对 `backend/.env.example` 是否覆盖必需变量，并给出开发/生产两套可落地示例与启动步骤。

## 1) 必需与常用环境变量清单

> 说明：
> - **必需（Required）** = 不配置会导致启动失败、功能不可用或存在明显安全风险。
> - **可选（Optional）** = 未配置时功能退化或默认关闭。

### 核心运行与安全（必须）

| 变量 | Required | 说明 | 示例 |
|---|---|---|---|
| `FLASK_ENV` | 是 | 运行环境（`development`/`production`） | `production` |
| `SECRET_KEY` | 是 | Flask 会话签名密钥（>=32位） | `a3f...` |
| `JWT_SECRET_KEY` | 是 | JWT 签名密钥（>=32位，且不同于 `SECRET_KEY`） | `c9b...` |
| `ADMIN_DEFAULT_PASSWORD` | 建议生产设置 | 管理员初始密码（留空则首次启动随机生成并打印日志） | `StrongPass!123...` |
| `JWT_SECRET` | 建议同步 | 兼容旧字段；建议与 `JWT_SECRET_KEY` 保持一致策略 | `c9b...` |
| `MASTER_ENCRYPTION_KEY` | 是 | 敏感信息加密密钥 | `9d1...` |
| `CORS_ORIGINS` | 是 | 前端允许来源，逗号分隔 | `https://app.example.com` |

### 数据与缓存（必须）

| 变量 | Required | 说明 | 示例 |
|---|---|---|---|
| `MYSQL_HOST` `MYSQL_PORT` `MYSQL_USER` `MYSQL_PASSWORD` `MYSQL_DB` | 是 | MySQL 连接参数 | `mysql` `3306` |
| `MYSQL_ROOT_PASSWORD` | 是（Docker 场景） | MySQL root 密码 | `strong-root-pass` |
| `REDIS_HOST` `REDIS_PORT` `REDIS_DB` | 是 | Redis 连接参数 | `redis` `6379` `0` |
| `REDIS_PASSWORD` | 生产强烈建议 | Redis 访问密码 | `redis-pass` |
| `REDIS_URL` | 建议配置 | 连接串形式（限流等组件直接读取） | `redis://redis:6379/0` |
| `JWT_BLOCKLIST_FAIL_OPEN` | 建议显式配置 | Redis 异常时 JWT 黑名单策略（`1`=放行高可用；`0`=拒绝更安全） | `0` |
| `DATABASE_URL` / `DB_URL` | 建议配置 | 数据库连接串保留位（便于迁移与第三方工具） | `mysql+pymysql://...` |

### 观测与外部服务

| 变量 | Required | 说明 | 示例 |
|---|---|---|---|
| `SENTRY_DSN` | 建议生产开启 | Sentry DSN，空则禁用 | `https://...@sentry.io/...` |
| `SENTRY_TRACES_RATE` | 可选 | Sentry tracing 采样率 | `0.1` |
| `SENTRY_PROFILES_RATE` | 可选 | Sentry profiling 采样率 | `0.1` |
| `APP_VERSION` | 可选 | 版本号（Sentry release） | `2026.04.19` |
| `LOKI_URL` | 可选 | Loki 推送端点 | `http://loki:3100/loki/api/v1/push` |
| `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` | 可选 | Telegram 告警 | `xxx` / `123456` |
| `SMTP_MODE` 及 `SMTP_*` | 可选 | 邮件发送配置 | `smtp` |

### 支付（预留字段）

| 变量 | Required | 说明 |
|---|---|---|
| `STRIPE_SECRET` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | 可选（建议先预留） | 预留给未来 Stripe 接入；当前后端代码未启用 Stripe SDK。 |

### 重点核对项（上线前）

以下变量已在 `backend/.env.example` 中提供模板，部署前请逐项确认已替换真实值：

- `JWT_SECRET_KEY`（以及兼容字段 `JWT_SECRET`）
- `DATABASE_URL` / `DB_URL`（如你的部署流程或外部工具依赖连接串）
- `REDIS_URL`（建议显式填写，便于限流/中间件与外部组件复用）
- `JWT_BLOCKLIST_FAIL_OPEN`（生产建议评估后显式设置；偏安全场景建议 `0`）
- `SENTRY_DSN`（生产建议开启）
- `STRIPE_SECRET`（如暂未接入支付，允许留空但建议保留字段）

---

## 2) 开发环境示例（Development）

```env
FLASK_ENV=development
FLASK_DEBUG=1
SECRET_KEY=dev_secret_key_change_me_32_chars
JWT_SECRET_KEY=dev_jwt_secret_change_me_32_chars
MASTER_ENCRYPTION_KEY=dev_master_key_change_me_32_chars

MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=vps_user
MYSQL_PASSWORD=vps_pass
MYSQL_DB=vps_dashboard
MYSQL_ROOT_PASSWORD=dev_root_pass

REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=

CORS_ORIGINS=http://localhost:3000,http://localhost:5173

SENTRY_DSN=
SMTP_MODE=log
```

## 3) 生产环境示例（Production）

```env
FLASK_ENV=production
FLASK_DEBUG=0
APP_VERSION=2026.04.19

SECRET_KEY=<64_hex_secret>
JWT_SECRET_KEY=<64_hex_secret_different_from_secret_key>
MASTER_ENCRYPTION_KEY=<64_hex_secret>
ADMIN_DEFAULT_PASSWORD=<strong_initial_password>

MYSQL_HOST=mysql
MYSQL_PORT=3306
MYSQL_USER=vps_user
MYSQL_PASSWORD=<strong_mysql_password>
MYSQL_ROOT_PASSWORD=<strong_mysql_root_password>
MYSQL_DB=vps_dashboard

REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=<strong_redis_password>
JWT_BLOCKLIST_FAIL_OPEN=0

CORS_ORIGINS=https://app.example.com,https://admin.example.com
FORCE_HTTPS=1
SESSION_COOKIE_SECURE=1
HSTS_ENABLED=1
HSTS_MAX_AGE=31536000

SENTRY_DSN=https://<key>@sentry.io/<project>
SENTRY_TRACES_RATE=0.1
SENTRY_PROFILES_RATE=0.1

SMTP_MODE=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USE_TLS=true
SMTP_USER=noreply@example.com
SMTP_PASSWORD=<smtp_password>
SMTP_FROM=VPS星图 <noreply@example.com>
```

---

## 4) 启动说明

### 本地开发启动

```bash
cd backend
cp .env.example .env
# 编辑 .env 为开发配置
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python app.py
```

### Docker Compose 启动（推荐）

```bash
cd backend
cp .env.example .env
# 编辑 .env 为生产配置
docker compose up -d
# 查看日志
docker compose logs -f api
```

### 启动后最小验证

```bash
curl http://localhost:5000/health
```

若 `FLASK_ENV=production` 且关键变量仍为弱默认值，后端会直接拒绝启动（预期行为）。
其中 `ADMIN_DEFAULT_PASSWORD` 若已设置但强度不足，也会触发拒绝启动；若留空则系统会生成随机强密码并写入启动日志，请在首次登录后立即改密。

---

## 5) 生产部署建议流程（简版）

1. **准备配置**
   - `cp backend/.env.example backend/.env`
   - 替换所有 `CHANGE_ME` 项，尤其是 `SECRET_KEY`、`JWT_SECRET_KEY`、`MYSQL_PASSWORD`。
2. **执行预检查**
   - 运行 `backend/scripts/pre-deploy.sh`，提前发现缺失项。
3. **拉起服务**
   - `cd backend && docker compose up -d`
4. **健康检查**
   - `curl http://127.0.0.1:5000/health`
   - 检查 `docker compose logs -f api` 无 FATAL/Traceback。
5. **上线后观测**
   - 若已配置 `SENTRY_DSN`，确认 Sentry 能接收到错误事件。
   - 若配置 `LOKI_URL`，确认日志可检索。

---

## 6) 前端（Vite）构建与部署核对

本仓库已移除 legacy `frontend/` 目录，部署时必须使用 `frontend-vite` 构建产物。

### 本地/服务器构建

```bash
cd frontend-vite
npm ci
npm run build
```

构建完成后会生成 `frontend-dist/`，并由 `backend/docker-compose.yml` 的 Nginx 挂载到 `/usr/share/nginx/html`。

### 上线前核对

- `frontend-dist/index.html` 存在
- `frontend-dist/admin.html` 存在
- `frontend-dist/sw.js` 存在
- CI 的 Frontend Build Check 通过

---

## 7) 管理后台 IP 白名单（Admin Allowlist）

### 7.1 受保护路由（Whitelisted routes）

| 路径 | 说明 |
|---|---|
| `/admin.html` | 管理后台主入口 |
| `/admin` | `/admin.html` 的别名（302 重定向），同样受白名单保护 |

以上路由仅允许白名单内 IP 访问；非白名单 IP 访问返回 **403 Forbidden**。  
其余路由（`/`、`/api/`、静态资源等）**不受影响**。

---

### 7.2 配置白名单（How to configure allowlist）

**文件位置：** `backend/admin-allowlist.conf`（不入版本库，由 `.gitignore` 排除）  
**模板位置：** `backend/admin-allowlist.conf.example`（版本库中保存，用于首次部署复制）

**首次部署：**

```bash
cd backend
cp admin-allowlist.conf.example admin-allowlist.conf
# 编辑文件，添加允许的 IP / CIDR
vi admin-allowlist.conf
```

**文件格式（CIDR）：**

```nginx
allow 203.0.113.10/32;     # 办公室固定出口 IP
allow 198.51.100.0/24;     # 运维跳板机网段
allow 10.0.0.0/8;          # 内网 / VPN 出口
deny all;                  # 最后一行必须保留
```

> ⚠️  `deny all;` 必须保留在文件末尾；`allow` 规则按顺序匹配，第一条命中即生效。

---

### 7.3 代理信任链配置（Trusted proxy settings）

**默认拓扑假设：** Nginx 直连公网（无 LB/CDN），`$remote_addr` 即为真实客户端 IP。

若部署在 **LB / CDN 之后**，需在 `backend/nginx.conf` 的 server 块中取消注释并调整：

```nginx
set_real_ip_from 10.0.0.0/8;        # 替换为实际上游 LB 网段
real_ip_header   X-Forwarded-For;   # 或 X-Real-IP / CF-Connecting-IP（Cloudflare）
real_ip_recursive on;
```

> ⚠️  **仅信任受控上游网段**，切勿使用 `set_real_ip_from 0.0.0.0/0`，  
>     否则任意客户端均可伪造 `X-Forwarded-For` 绕过白名单。

---

### 7.4 验证步骤（Verification steps）

**1. 配置语法检查：**

```bash
docker compose exec nginx nginx -t
# 期望输出：configuration file /etc/nginx/nginx.conf test is successful
```

**2. 白名单命中（允许访问，200）：**

```bash
# 直连（本机 IP 在白名单内）
curl -o /dev/null -sw "%{http_code}\n" http://your-domain.com/admin.html
# 期望：200

# 经由代理（模拟 X-Forwarded-For，需 set_real_ip_from 正确配置）
curl -H "X-Forwarded-For: <ALLOWED_IP>" \
     -o /dev/null -sw "%{http_code}\n" http://your-domain.com/admin.html
# 期望：200（仅当 set_real_ip_from 包含 curl 来源 IP 时生效）
```

**3. 非白名单拒绝（403）：**

```bash
# 从未在白名单内的 IP 访问（或通过代理注入非白名单 XFF）
curl -o /dev/null -sw "%{http_code}\n" http://your-domain.com/admin.html
# 期望：403

curl -H "X-Forwarded-For: 1.2.3.4" \
     -o /dev/null -sw "%{http_code}\n" http://your-domain.com/admin.html
# 期望：403（1.2.3.4 不在白名单）
```

**4. 兼容路径 /admin（同样受白名单保护，直接返回 admin.html 内容）：**

```bash
# 白名单 IP
curl -o /dev/null -sw "%{http_code}\n" http://your-domain.com/admin
# 期望：200（白名单命中，直接返回 admin.html 内容，不发生浏览器跳转）

# 非白名单 IP
curl -o /dev/null -sw "%{http_code}\n" http://your-domain.com/admin
# 期望：403（白名单拦截）
```

> 注意：`/admin` 路径现在直接返回 `admin.html` 内容而非 302 重定向。这是必要的设计——  
> 使用 `return 302` 会在 nginx 的 rewrite 阶段执行（先于 access 阶段的 `deny`），  
> 导致白名单规则被绕过。

**5. 普通用户路由不受影响：**

```bash
curl -o /dev/null -sw "%{http_code}\n" http://your-domain.com/
# 期望：200

curl -o /dev/null -sw "%{http_code}\n" http://your-domain.com/api/v1/health
# 期望：200
```

---

### 7.5 生效步骤（Apply changes）

```bash
# 1. 修改 backend/admin-allowlist.conf
# 2. 验证配置语法
docker compose exec nginx nginx -t
# 3. 热重载（零停机）
docker compose exec nginx nginx -s reload
```

> 变更仅影响管理路由，其余流量在 reload 期间不中断。

---

### 7.6 紧急放行（Emergency access）

临时追加 IP（不修改原有规则）：

```bash
# 编辑文件，在 deny all; 之前追加一行
echo "allow <EMERGENCY_IP>/32;" >> backend/admin-allowlist.conf
# （或手动 vi 编辑，确保 deny all; 仍在最后一行）
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

---

### 7.7 回滚步骤（Rollback steps）

**方案 A：恢复旧白名单（仅回滚 IP 列表）**

```bash
git show HEAD~1:backend/admin-allowlist.conf.example > backend/admin-allowlist.conf
# 或从备份恢复
cp backend/admin-allowlist.conf.bak backend/admin-allowlist.conf
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

**方案 B：完整回滚 nginx.conf（恢复白名单功能关闭状态）**

```bash
git stash   # 暂存本地改动
git checkout <PREVIOUS_COMMIT> -- backend/nginx.conf
docker compose exec nginx nginx -t && docker compose exec nginx nginx -s reload
```

**灰度节点建议：** 变更前先在单台节点 reload，观察日志 1 分钟确认无误后再同步其余节点，最大限度降低中断风险。

---

### 7.8 已知限制（Known limitations）

| 限制 | 说明 | 建议 |
|---|---|---|
| 动态出口 IP | 若办公室使用 DHCP/动态公网 IP，白名单需定期更新 | 改用 VPN 固定出口，或加入 `/24` 段 |
| VPN 出口变化 | VPN 扩容/切换时出口 IP 段可能变化 | 使用 CIDR 段而非单 IP |
| IPv6 支持 | `deny all` 对 IPv4/IPv6 均有效；如需放行 IPv6 地址，格式：`allow 2001:db8::/32;` | 视实际网络环境添加 |
| CDN/多级代理 | 未正确配置 `set_real_ip_from` 时，nginx 看到的是代理 IP 而非真实客户端 IP | 参见 7.3 节 |
| 仅保护静态入口 | 白名单保护 HTML 入口页，API 鉴权仍由后端 JWT + RBAC 负责，两层共同构成防御纵深 | 确保后端 `@admin_required` 装饰器已覆盖所有管理 API |

