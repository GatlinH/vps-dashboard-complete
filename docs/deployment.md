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
