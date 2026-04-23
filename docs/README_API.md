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

成功响应（`201`）示例：

```json
{
  "msg": "注册成功，请检查邮箱进行验证"
}
```

冲突响应（`409`）示例：

```json
{
  "msg": "用户名已被占用"
}
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

成功响应（`200`）示例：

```json
{
  "msg": "告警已推送"
}
```

失败响应（`502`）示例：

```json
{
  "msg": "推送失败",
  "detail": {
    "ok": false
  }
}
```

### 4.2 主动抓取探针数据（采集触发）

端点：`POST /api/v1/probe/fetch-probe`

```bash
curl -X POST 'http://localhost:5000/api/v1/probe/fetch-probe' \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <access_token>' \
  -d '{"server_ids": [1, 2, 3]}'
```

响应（`200`）示例：

```json
{
  "updated": ["1", "2"],
  "errors": [
    {
      "server_id": "3",
      "error": "timed out"
    }
  ]
}
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

### 5.1 Payment 建议的 Swagger 合约示例（预留）

> 以下为建议文档模板，便于后续在 `payment.py` 中直接落地为 Flasgger docstring。

#### POST `/api/v1/payment/checkout/session`

请求示例：

```json
{
  "plan": "pro-monthly",
  "success_url": "https://example.com/billing/success",
  "cancel_url": "https://example.com/billing/cancel"
}
```

响应（`200`）示例：

```json
{
  "checkout_url": "https://checkout.stripe.com/c/pay/cs_test_xxx",
  "session_id": "cs_test_xxx"
}
```

#### POST `/api/v1/payment/webhook`

请求头示例：

```http
Stripe-Signature: t=1718888888,v1=abcdef123456
```

响应（`200`）示例：

```json
{
  "received": true
}
```


## 6. Probe / IP 查询限流与批量硬限制

- `POST /api/v1/probe/ping/batch` 与 `POST /api/v1/probe/fetch-probe` 增加了双层保护：
  - 批次上限：`PROBE_BATCH_MAX_ITEMS`（默认 `50`）
  - 最小触发间隔：`PROBE_BATCH_MIN_INTERVAL_S`（默认 `3s`）
  - 触发过快时返回 `429`，错误码 `BATCH_RATE_LIMITED`
- `GET /api/v1/probe/ip-info` 增加 IP 维度限流（`IP_INFO_RATE_LIMIT`，默认 `60 per minute`）
- `GET /api/v1/probe/ip-info` 响应增加缓存标识：`X-Cache: HIT|MISS`

## 7. API Schema 版本同步

前后端通过以下头部同步接口字段版本：

- 客户端请求头：`X-Client-Schema-Version`
- 服务端响应头：`X-API-Schema-Version`

当版本不一致时，后端会记录告警日志，便于发布时快速发现前后端字段未对齐问题。

## 8. Geo API（分页 / 聚合 / 降级）

Schema 版本：`2026-04-23`（通过 `X-API-Schema-Version` 响应头返回）。

### 8.1 GET `/api/v1/geo/servers/coords`

支持两种模式：

1) 列表分页模式（默认）：`mode=list&page=1&per_page=200`

```json
{
  "mode": "list",
  "nodes": [
    {"id": 1, "name": "node-a", "location": "Tokyo", "status": "online", "lat": 35.6, "lon": 139.7}
  ],
  "pagination": {"page": 1, "per_page": 200, "pages": 3, "total": 420, "has_next": true},
  "schema_version": "2026-04-23"
}
```

2) 聚合模式：`mode=aggregate`

```json
{
  "mode": "aggregate",
  "total": 420,
  "coords_ready": 410,
  "by_status": {"online": 380, "offline": 40},
  "top_locations": [{"location": "Tokyo", "count": 132}],
  "schema_version": "2026-04-23"
}
```

### 8.2 地图 provider 降级响应

当上游地图 provider 失败且本地缓存不可用时，接口会返回统一降级结构：

```json
{
  "error_code": "MAP_PROVIDER_UNAVAILABLE",
  "provider": "carto",
  "message": "地图服务暂时不可用，已进入降级模式",
  "detail": "...",
  "fallback_hint": "前端可切换到纯矢量模式（关闭 tileMode）或展示简化底图。"
}
```

- `GET /api/v1/geo/countries`：若存在 stale 缓存，优先返回 `200` + `X-Cache: STALE`。
- `GET /api/v1/geo/tile/*`：失败时返回上面的降级 JSON（HTTP 502）。

### 8.3 瓦片代理限流/缓存

- 短时限流：`TILE_BURST_LIMIT`（默认 120）/ `TILE_BURST_WINDOW_S`（默认 10 秒）。
- 缓存 TTL：`TILE_CACHE_TTL`（默认 24h）。
- 高频批量拉取可避免打爆 provider，降低被拉黑风险。
