"""Regression coverage for the Caddy TLS to frontend Nginx proxy boundary."""
from pathlib import Path
import re


NGINX_CONFIG = (
    Path(__file__).resolve().parents[2] / "frontend-vite" / "nginx.conf"
)


def test_frontend_nginx_preserves_caddy_forwarded_proto_with_https_default():
    config = NGINX_CONFIG.read_text(encoding="utf-8")

    assert not re.search(
        r"proxy_set_header\s+X-Forwarded-Proto\s+\$scheme\s*;",
        config,
    )
    assert re.search(
        r"map\s+\$http_x_forwarded_proto\s+\$upstream_x_forwarded_proto\s*\{"
        r"[\s\S]*?\"\"\s+https\s*;[\s\S]*?\}",
        config,
    )
    assert len(
        re.findall(
            r"proxy_set_header\s+X-Forwarded-Proto\s+\$upstream_x_forwarded_proto\s*;",
            config,
        )
    ) == 2
