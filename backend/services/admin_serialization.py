"""Admin-only server DTO serialization."""


class AdminServerSerializer:
    """Build the internal server representation used by protected admin APIs."""

    @classmethod
    def serialize(cls, server, *, include_metrics=True) -> dict:
        from models.models import (
            format_server_location,
            get_server_coords,
            get_server_inventory_meta,
        )

        cfg, inventory_meta = get_server_inventory_meta(server)
        lat, lon = get_server_coords(server)
        city = str(inventory_meta.get("city") or cfg.get("city") or "").strip()
        region = str(inventory_meta.get("region") or cfg.get("region") or "").strip()
        country = str(inventory_meta.get("country") or cfg.get("country") or "").strip()
        provider_guess = str(
            inventory_meta.get("provider_guess")
            or cfg.get("provider_guess")
            or inventory_meta.get("org")
            or inventory_meta.get("isp")
            or ""
        ).strip()
        runtime_os = str(inventory_meta.get("os") or cfg.get("os") or "").strip()
        runtime_kernel = str(
            inventory_meta.get("kernel_version")
            or inventory_meta.get("kernel")
            or cfg.get("kernel_version")
            or cfg.get("kernel")
            or ""
        ).strip()
        runtime_arch = str(inventory_meta.get("arch") or cfg.get("arch") or "").strip()
        runtime_cpu_model = str(
            inventory_meta.get("cpu_model")
            or inventory_meta.get("cpu_name")
            or cfg.get("cpu_model")
            or cfg.get("cpu_name")
            or ""
        ).strip()
        effective_location = str(server.location or "").strip() or format_server_location(
            city, region, country
        )

        merged_agent_config = dict(cfg)
        merged_agent_config["inventory_meta"] = inventory_meta
        network = cfg.get("network") if isinstance(cfg.get("network"), dict) else {}
        local_ipv4 = str(
            network.get("local_ipv4") or inventory_meta.get("local_ipv4") or ""
        ).strip()
        local_ipv6 = network.get("local_ipv6", inventory_meta.get("local_ipv6", []))
        if not isinstance(local_ipv6, list):
            local_ipv6 = [local_ipv6] if local_ipv6 else []

        data = {
            "id": server.id,
            "name": server.name,
            "group": server.group.name if server.group else server.group_name,
            "group_info": server.group.to_public_dict() if server.group else None,
            "flag": server.flag,
            "location": effective_location,
            "city": city,
            "region": region,
            "country": country,
            "ip": server.ip,
            "cpu": server.cpu_cores,
            "ram": server.ram_gb,
            "disk": server.disk_gb,
            "bw": server.bandwidth,
            "provider": server.provider or "",
            "provider_guess": provider_guess,
            "os": runtime_os[:160],
            "kernel_version": runtime_kernel[:160],
            "arch": runtime_arch[:80],
            "cpu_model": runtime_cpu_model,
            "tags": server.tags or [],
            "probe": server.probe_url,
            "probe_config": {"url": server.probe_url},
            "note": server.note,
            "price": server.price,
            "period": server.period,
            "expiry": server.expiry.isoformat() if server.expiry else None,
            "uuid": server.uuid,
            "agent_status": {
                "status": server.status,
                "has_key": bool(server.agent_key_hash),
                "key_created_at": cls._isoformat(server.agent_key_created_at),
                "key_last_used": cls._isoformat(server.agent_key_last_used),
            },
            "agent_config": merged_agent_config,
            "internal_ips": {
                "ipv4": local_ipv4,
                "ipv6": [str(value).strip() for value in local_ipv6 if str(value).strip()],
            },
            "raw_metadata": dict(inventory_meta),
            "lat": lat,
            "lon": lon,
            "agent_key_created_at": cls._isoformat(server.agent_key_created_at),
            "agent_key_last_used": cls._isoformat(server.agent_key_last_used),
            "has_agent_key": bool(server.agent_key_hash),
        }

        if include_metrics:
            data.update(
                cpu_use=round(server.cpu_use, 2),
                ram_use=round(server.ram_use, 2),
                disk_use=round(server.disk_use, 2),
                net_up=round(server.net_up, 2),
                net_down=round(server.net_down, 2),
                process_count=server.process_count,
                status=server.status,
                uptime=server.uptime,
                traffic_limit_gb=server.traffic_limit_gb,
                traffic_reset_day=server.traffic_reset_day or 1,
                traffic_up_gb=round(server.traffic_up_gb, 4),
                traffic_down_gb=round(server.traffic_down_gb, 4),
                traffic_used_gb=round(server.traffic_used_gb, 4),
                updated_at=cls._isoformat(server.updated_at),
            )

        return data

    @staticmethod
    def _isoformat(value):
        return value.isoformat() if value else None
