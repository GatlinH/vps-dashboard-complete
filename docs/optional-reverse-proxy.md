# 可选：反向代理与 TLS

Dashboard 默认直接监听 `http://<IP>:4500`。不需要 Caddy、Nginx 或任何反向代理。

如果你需要域名、TLS 或统一入口，请自行将**已有的**反向代理配置指向 `127.0.0.1:4500`。不要盲目覆盖现有 Caddyfile、Nginx server block 或其他代理配置；它们可能服务其他站点。

## Caddy（可选）

将以下站点块谨慎合并到你自己的 Caddyfile：

```caddy
dashboard.example.com {
    reverse_proxy 127.0.0.1:4500
}
```

## Nginx（可选）

将以下 location 谨慎合并到你自己的 HTTPS server block：

```nginx
location / {
    proxy_pass http://127.0.0.1:4500;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

远程 Agent 的 HTTPS 地址仍由管理员提供。请保持 `AGENT_REQUIRE_TLS=1`，不要因为 Dashboard 直连端口而降低 Agent TLS 要求。
