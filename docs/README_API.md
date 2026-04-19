# API 文档（Swagger / Flasgger）

本文档集中说明当前项目 API 文档入口、认证方式、常见调用示例，并补充 `auth`、`payment`（预留）和 `webhook` 相关说明。

## 1. Swagger 入口

启动后端后访问（默认）：

- Swagger UI: `http://localhost:5000/apidocs/`
- OpenAPI JSON: `http://localhost:5000/apispec_1.json`

> 项目使用 Flasgger，接口说明来自各 `backend/api/*.py` 中函数 docstring 的 `---` YAML 段。

---

## 2. 认证方式

大多数管理接口要求 JWT：

```http
Authorization: Bearer <access_token>
```

### 获取 Token（登录）

```bash
curl -X POST 'http://localhost:5000/api/v1/auth/login' \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "admin",
    "password": "StrongPassword!123"
  }'
```

成功后将得到：

- `access_token`
- `refresh_token`
- `user`

---

## 3. Auth 端点示例

### 3.1 注册

```bash
curl -X POST 'http://localhost:5000/api/v1/auth/signup' \
  -H 'Content-Type: application/json' \
  -d '{
    "username": "demo_user",
    "email": "demo@example.com",
    "password": "StrongPassword!123"
  }'
```

### 3.2 刷新令牌

```bash
curl -X POST 'http://localhost:5000/api/v1/auth/refresh' \
  -H 'Authorization: Bearer <refresh_token>'
```

### 3.3 获取当前用户信息

```bash
curl 'http://localhost:5000/api/v1/auth/me' \
  -H 'Authorization: Bearer <access_token>'
```

### 3.4 前端调用示例（fetch）

```js
async function loadMe(accessToken) {
  const res = await fetch('/api/v1/auth/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return await res.json();
}
```

---

## 4. Webhook 相关端点示例

本项目中 webhook / 事件触发场景主要体现在告警和探针采集。

### 4.1 触发 Telegram 告警

端点：`POST /api/v1/telegram/alert/fire`

```bash
curl -X POST 'http://localhost:5000/api/v1/telegram/alert/fire' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <access_token>' \
  -d '{
    "server_id": 12,
    "rule_type": "cpu",
    "current_value": 96.2,
    "threshold": 90
  }'
```

### 4.2 主动抓取探针数据（采集触发）

端点：`POST /api/v1/probe/fetch-probe`

```bash
curl -X POST 'http://localhost:5000/api/v1/probe/fetch-probe' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <access_token>' \
  -d '{"server_ids": [1, 2, 3]}'
```

---

## 5. Payment 状态说明（当前版本）

当前仓库尚未启用独立支付 API（例如 Stripe Checkout、Billing Portal、Webhook 验签处理）。

- 环境变量层面有预留：`STRIPE_SECRET` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
- 代码层面：当前版本未集成 Stripe SDK，也未暴露 `/api/v1/payment/*` 路由

建议后续新增时遵循：

1. 新建 `backend/api/payment.py` 并注册蓝图 `/api/v1/payment`
2. 将 checkout/session、subscription、billing portal、webhook 事件处理写入 Flasgger docstring
3. 在本文件补充真实示例（成功/失败响应）

