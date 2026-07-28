# IPv4 / IPv6 direct deployment

The dashboard does **not** require a domain, reverse proxy, or TLS termination layer. Those are optional operator choices.

## Default: IPv4 direct bind

No settings are needed:

```text
PUBLIC_BIND_ADDRESS=0.0.0.0
GUNICORN_BIND=0.0.0.0:5000
```

The public API/dashboard is published at `http://<ipv4>:4500` (subject to the operator's TLS policy and firewall configuration).

## IPv6 direct bind

For an IPv6-only host, set both values explicitly in the Compose environment used by the operator:

```text
PUBLIC_BIND_ADDRESS=[::]
GUNICORN_BIND=[::]:5000
```

Then configure each IPv6-only Agent with a bracketed URL:

```text
API_ROOT=http://[2001:db8::10]:4500
```

Do not omit the brackets around a literal IPv6 address in a URL.

## Dual-stack direct bind

Docker/host networking behavior differs by platform. Operators must explicitly choose and verify their desired v4/v6 publishing strategy. The project does not silently alter host sysctls, firewalls, Docker daemon IPv6 settings, or install a proxy.

A domain, A/AAAA records, TLS, Caddy, Nginx, Cloudflare, VPN, and private overlays are all optional deployment layers selected by the operator.

## Agent inventory

Agents report independent fields:

```json
{
  "network": {
    "local_ipv4": "10.0.0.8",
    "local_ipv6": ["2001:db8::8"]
  }
}
```

A local routed address is not automatically treated as public/NAT-reachable. For global VPS peer probes behind NAT, configure `agent_config.nat.public_ipv4` plus its mapped port. For direct IPv6 peer probes, configure `agent_config.network.public_ipv6` when the address is publicly reachable.

## Verification

```bash
# IPv6 listener (operator-selected direct mode)
ss -ltnp | grep ':4500'

# IPv6 health request
curl -g --max-time 5 'http://[<ipv6>]:4500/health'

# Agent service and IPv6-capable API root
systemctl is-active vps-agent
```

Do not apply `docker compose up -d` only to change bind mode when the running service has in-container hotpatches. Bake/reapply those changes first, then perform a controlled recreate.
