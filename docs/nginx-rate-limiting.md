# P3F — Nginx 限流配置收敛（limit_req_zone）

本文档说明 P3F 改动的背景、配置结构、验证步骤与回滚方案。

---

## 1. 背景：为什么旧方式不稳定

旧版 `nginx.conf`（即 `conf.d/default.conf`）的顶部注释要求**手动**将 `limit_req_zone` 指令添加到宿主机或容器的 `/etc/nginx/nginx.conf` 的 `http {}` 块：

```nginx
# ── 旧注释（已废弃）──────────────────────────────────
# 以下 limit_req_zone 指令需在 Nginx 主配置的 http {} 块中添加，
# 通常位于 /etc/nginx/nginx.conf：
#
#   limit_req_zone $binary_remote_addr zone=api:10m   rate=30r/s;
#   limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
```

**问题**：
- `limit_req_zone` 只能放在 `http {}` 级别，而 `conf.d/*.conf` 是 `server {}` 级别的片段，无法在其中定义 zone。
- 若忘记手工操作，`nginx -t` 会报错 `unknown "login" zone`，限流规则完全不生效。
- 新环境 / CI 重建容器后手工操作不可重现，导致 dev / staging / prod 配置不一致。

---

## 2. P3F 方案：volume 挂载自定义主配置（Option B）

### 2.1 新增文件

| 文件 | 容器内路径 | 说明 |
|---|---|---|
| `backend/nginx-main.conf` | `/etc/nginx/nginx.conf` | 自定义 nginx 主配置，包含 `limit_req_zone`（`http {}` 级别）及标准 `include conf.d/*.conf` |
| `backend/nginx.conf` | `/etc/nginx/conf.d/default.conf` | 站点配置（原有，已移除过时注释） |

### 2.2 配置结构（Before / After）

**Before（易遗漏）：**
```
/etc/nginx/nginx.conf          ← 容器默认，无 limit_req_zone（需手工添加）
/etc/nginx/conf.d/default.conf ← 挂载 backend/nginx.conf（含 limit_req 但 zone 未定义）
```

**After（开箱即用）：**
```
/etc/nginx/nginx.conf          ← 挂载 backend/nginx-main.conf（http{} 含 limit_req_zone）
/etc/nginx/conf.d/default.conf ← 挂载 backend/nginx.conf（limit_req 引用已定义的 zone）
```

### 2.3 docker-compose.yml 变更摘要

```yaml
nginx:
  volumes:
    # P3F：挂载自定义主配置（含 limit_req_zone），替换容器默认 nginx.conf
    - ./nginx-main.conf:/etc/nginx/nginx.conf:ro
    - ./nginx.conf:/etc/nginx/conf.d/default.conf:ro
    - ./admin-allowlist.conf:/etc/nginx/conf.d/admin-allowlist.conf:ro
    # ...其余 volume 不变
```

---

## 3. 限流规则说明

### 3.1 Zone 定义（nginx-main.conf，http {} 块）

```nginx
limit_req_zone $binary_remote_addr zone=api:10m   rate=30r/s;
limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
limit_req_log_level warn;
```

| Zone | 速率 | 共享内存 | 适用路由 | burst | nodelay |
|---|---|---|---|---|---|
| `api` | 30 req/s | 10 MB（≈80 000 IP） | `location /api/` | 30 | ✅ |
| `login` | 5 req/min | 10 MB | `location = /api/v1/auth/login` | 5 | ✅ |

### 3.2 被限流响应

- 状态码：**429 Too Many Requests**（`limit_req_status 429;` 已在站点配置中设置）
- 超出 burst 的请求立即被拒绝（`nodelay`），不排队等待

### 3.3 日志字段

访问日志格式（`nginx-main.conf`）：

```
$remote_addr ... "$request" $status ... limit_req=$limit_req_status
```

被限流时 `limit_req_status` 值为 `REJECTED`（立即丢弃）或 `DELAYED`（排队）。

**快速查找限流命中：**

```bash
docker compose exec nginx grep -E "REJECTED|DELAYED" /var/log/nginx/access.log | tail -20
```

---

## 4. 可调参数

### 4.1 调整速率（不需要重建镜像）

修改 `backend/nginx-main.conf` 中对应的 `rate=` 值，然后热重载：

```bash
docker compose exec nginx nginx -t
docker compose exec nginx nginx -s reload
```

| 场景 | 建议参数 |
|---|---|
| 生产默认（平衡） | `api: 30r/s`, `login: 5r/m` |
| 生产保守（高安全） | `api: 10r/s`, `login: 3r/m` |
| 开发/测试（宽松） | `api: 300r/s`, `login: 60r/m` |

### 4.2 调整 burst

在 `backend/nginx.conf` 的 `location` 块中修改 `burst=` 值：

```nginx
location /api/ {
    limit_req zone=api burst=30 nodelay;   # burst 可按需调大/小
    ...
}
location = /api/v1/auth/login {
    limit_req zone=login burst=5 nodelay;
    ...
}
```

### 4.3 真实 IP 配置（部署在 LB/CDN 之后时必须配置）

若 nginx 前面有负载均衡器或 CDN，`$binary_remote_addr` 默认取到代理 IP，导致所有用户共享一个限额。  
在 `backend/nginx.conf` 的 `server {}` 块中取消注释并按实际拓扑填写：

```nginx
set_real_ip_from 10.0.0.0/8;        # 信任的上游 LB 网段
real_ip_header   X-Forwarded-For;   # 或 X-Real-IP / CF-Connecting-IP
real_ip_recursive on;
```

> ⚠️ 切勿使用 `set_real_ip_from 0.0.0.0/0`，否则任意客户端可伪造 XFF 绕过限流。

---

## 5. 验证步骤（可复现）

### 5.1 配置语法检查

```bash
# 方式 A：本地 nginx（若已安装）
nginx -t -c $(pwd)/backend/nginx-main.conf

# 方式 B：在运行容器中
docker compose exec nginx nginx -t
# 期望输出：
# nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
# nginx: configuration file /etc/nginx/nginx.conf test is successful
```

### 5.2 常规请求正常（未触发限流）

```bash
# 单次请求，期望 200
curl -o /dev/null -sw "%{http_code}\n" http://localhost/api/v1/health

# 查看访问日志，limit_req 字段应为空
docker compose exec nginx tail -5 /var/log/nginx/access.log
# 示例输出（正常）：
# 127.0.0.1 - - [03/May/2026:03:00:00 +0000] "GET /api/v1/health HTTP/1.1" 200 ... limit_req=
```

### 5.3 压测触发限流（返回 429）

```bash
# 方式 A：使用 ab（Apache Bench）
ab -n 200 -c 50 http://localhost/api/v1/health
# 在统计结果中找到 "Non-2xx responses" 计数 > 0，即为限流命中

# 方式 B：使用 hey
hey -n 200 -c 50 http://localhost/api/v1/health
# 在统计中找到 "[429] N responses"

# 方式 C：简单 bash 循环（无需额外工具）
for i in $(seq 1 80); do
  curl -o /dev/null -sw "%{http_code} " http://localhost/api/v1/health
done
# 观察到出现 429 即表示限流已命中（实际触发位置取决于请求间隔与 burst 消耗速度，无固定计数）
```

**关键输出摘要示例：**
```
200 200 200 ... 429 429 429
```

### 5.4 登录接口限流验证

```bash
# 模拟 10 次快速登录尝试（5r/m + burst=5 → 第 6 次起触发）
for i in $(seq 1 10); do
  curl -o /dev/null -sw "%{http_code} " \
    -X POST http://localhost/api/v1/auth/login \
    -H "Content-Type: application/json" \
    -d '{"username":"x","password":"y"}'
done
# 期望：前 5 次为 4xx（如 401 认证失败），第 6 次起为 429 限流（可能随时间间隔略有波动）
```

### 5.5 日志可见限流命中

```bash
# 实时监控（压测时另开终端）
docker compose exec nginx tail -f /var/log/nginx/access.log | grep -E "429|REJECTED|DELAYED"

# 事后查询
docker compose exec nginx grep "429" /var/log/nginx/access.log | tail -20
docker compose exec nginx grep "REJECTED" /var/log/nginx/access.log | wc -l
```

**示例日志片段（限流命中）：**
```
192.168.1.100 - - [03/May/2026:03:00:01 +0000] "GET /api/v1/health HTTP/1.1" 429 169 "-" "curl/7.88.1" "-" limit_req=REJECTED
```

### 5.6 重启后配置仍生效

```bash
# 重启 nginx 容器
docker compose restart nginx

# 再次验证
docker compose exec nginx nginx -t
curl -o /dev/null -sw "%{http_code}\n" http://localhost/api/v1/health
# 期望：200
```

---

## 6. 兼容性说明

| 项目 | 说明 |
|---|---|
| API 路径 | 无任何变化，所有现有路由保持不变 |
| 业务响应结构 | 无变化。新增 429 响应体为 nginx 默认 HTML（非 API JSON），前端应处理此状态码 |
| 白名单豁免 | `/metrics`、静态资源（`/assets/`、`/sw.js`、`/manifest.webmanifest`）、前端页面（`/`、`/admin.html`）均不在限流 location 内，不受影响 |
| 未版本化 API 路径重定向 | `location ~ ^/api/(?!v\d+/)(.+)$`（301 重定向）不受限流影响 |
| 地图瓦片 `/api/geo/tile/` | 按当前 `backend/nginx.conf`，`location /api/geo/tile/` 作为更长前缀会优先于 `location /api/` 命中，因此通常不会落入 `/api/` 中声明的 `limit_req`。如需对该路由限流，应在 `/api/geo/tile/` 的 location 内显式配置单独的 `limit_req`/zone；如需豁免，保持该 location 不配置 `limit_req` 即可 |

> **注意**：当前默认配置下，`/api/geo/tile/` 是否受限流取决于其自身的 `location` 配置，而不是 `location /api/`。若该路由后续流量较大且需要单独控制，建议在 `/api/geo/tile/` 的 location 中显式配置更高配额的 zone；若要明确关闭该 location 的限流，在所用 Nginx 版本支持时可使用 `limit_req off;`。

---

## 7. 回滚步骤

### 方案 A：热回滚（零停机，推荐）

1. 恢复 `nginx-main.conf` 到上一版本：
   ```bash
   git checkout <PREVIOUS_COMMIT> -- backend/nginx-main.conf
   ```
2. 语法检查：
   ```bash
   docker compose exec nginx nginx -t
   ```
3. 热重载（不中断现有连接）：
   ```bash
   docker compose exec nginx nginx -s reload
   ```

### 方案 B：完整恢复旧行为（移除 P3F 改动）

若需完全撤销 P3F（恢复为手工模式），需同时回滚三个文件：

```bash
git checkout <PREVIOUS_COMMIT> -- \
  backend/nginx-main.conf \
  backend/nginx.conf \
  backend/docker-compose.yml

# 重建并重启 nginx 容器
docker compose up -d --force-recreate nginx
```

> 回滚后 `limit_req_zone` 将再次失效（同旧版行为），需手工添加到宿主 nginx.conf 才能恢复限流。

---

## 8. 部署检查清单（P3F）

部署前逐项确认：

- [ ] `backend/nginx-main.conf` 已存在且语法正确（`nginx -t` 通过）
- [ ] `backend/docker-compose.yml` 包含 `nginx-main.conf` volume 挂载
- [ ] `docker compose up -d` 后 nginx 容器健康（`docker compose ps nginx`）
- [ ] 普通请求返回 200（未触发限流）
- [ ] 压测可稳定触发 429
- [ ] 日志可见 `limit_req=REJECTED` 字段
- [ ] 容器重启后配置仍生效（无需手工干预）
