import React from "react";
import { createRoot } from "react-dom/client";
import GlobeStarmap from "./GlobeStarmap.jsx";

const FLAG_MAP = [
  [/(香港|HK|Hong Kong)/i, "🇭🇰"],
  [/(日本|东京|JP|Tokyo|Sakura)/i, "🇯🇵"],
  [/(新加坡|SG|Singapore|Linode)/i, "🇸🇬"],
  [/(德国|法兰克福|DE|Frankfurt|Hetzner)/i, "🇩🇪"],
  [/(洛杉矶|LA|Los Angeles|美国|US|New York|纽约|OVH)/i, "🇺🇸"],
  [/(英国|伦敦|UK|London)/i, "🇬🇧"],
  [/(韩国|首尔|KR|Seoul)/i, "🇰🇷"],
  [/(澳大利亚|悉尼|AU|Sydney)/i, "🇦🇺"],
  [/(巴西|圣保罗|BR|SP)/i, "🇧🇷"],
  [/(印度|孟买|IN|Mumbai)/i, "🇮🇳"],
  [/(荷兰|阿姆斯特丹|NL|AMS)/i, "🇳🇱"],
];

function num(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function statusOf(s) {
  const raw = String(s.status || s.state || s.health || "").toLowerCase();
  if (raw.includes("offline") || raw.includes("down") || raw.includes("离线")) return "offline";
  const cpu = num(s.cpu_use, s.cpu, s.cpu_usage, s.cpuPercent, s.metrics?.cpu);
  const ram = num(s.ram_use, s.ram, s.mem, s.memory, s.memory_percent, s.metrics?.memory);
  if (raw.includes("warn") || raw.includes("warning") || cpu >= 75 || ram >= 85) return "warn";
  return "online";
}


function flagFromCountryCode(code) {
  const normalized = String(code || "").trim().toUpperCase();
  const cc = normalized === "UK" ? "GB" : normalized;
  if (!/^[A-Z]{2}$/.test(cc)) return "";
  return Array.from(cc).map(ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join("");
}

function flagOf(s) {
  const explicitFlag = String(s.flag || "");
  if (/[\u{1F1E6}-\u{1F1FF}]{2}/u.test(explicitFlag)) return explicitFlag;
  const directCode = [s.country_code, s.countryCode, s.country, s.flag, s.agent_config?.inventory_meta?.country_code, s.agent_config?.inventory_meta?.countryCode]
    .map(v => v == null ? "" : String(v).trim())
    .find(v => /^[A-Za-z]{2}$/.test(v));
  const directFlag = flagFromCountryCode(directCode);
  if (directFlag) return directFlag;
  const hay = `${s.flag || ""} ${s.name || ""} ${s.location || ""} ${s.city || ""} ${s.region || ""} ${s.country || ""} ${s.country_name || ""} ${s.agent_config?.inventory_meta?.country || ""}`;
  const hit = FLAG_MAP.find(([re]) => re.test(hay));
  return hit ? hit[1] : "🌐";
}

function coord(s, axis) {
  const keys = axis === 'lat'
    ? [s.lat, s.latitude, s.geo?.lat, s.agent_config?.lat, s.agent_config?.inventory_meta?.lat]
    : [s.lon, s.lng, s.longitude, s.geo?.lon, s.geo?.lng, s.agent_config?.lon, s.agent_config?.inventory_meta?.lon];
  for (const v of keys) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function normalizeServers(servers = []) {
  return (Array.isArray(servers) ? servers : []).map((s, idx) => ({
    id: s.id ?? idx + 1,
    name: s.name || s.hostname || `NODE-${idx + 1}`,
    flag: flagOf(s),
    location: s.location || s.city || s.region || s.country || s.provider || s.name || "未知区域",
    ip: s.ip || s.public_ip || s.host || "—",
    lat: coord(s, 'lat'),
    lon: coord(s, 'lon'),
    cpu_use: num(s.cpu_use, s.cpu, s.cpu_usage, s.cpuPercent, s.metrics?.cpu),
    ram_use: num(s.ram_use, s.ram, s.mem, s.memory, s.memory_percent, s.metrics?.memory),
    net_up: num(s.net_up, s.upload, s.netUpload, s.traffic_up, s.metrics?.net_up),
    net_down: num(s.net_down, s.download, s.netDownload, s.traffic_down, s.metrics?.net_down),
    status: statusOf(s),
  })).filter((s) => Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lon)));
}

export function mountGlobeStarmap(element, servers, options = {}) {
  if (!element) return null;
  const root = createRoot(element);
  const render = (nextServers = servers) => {
    const normalized = normalizeServers(nextServers);
    window.__DETAIL_STARMAP_SERVER_COUNT__ = normalized.length;
    window.__DETAIL_STARMAP_SERVER_NAMES__ = normalized.map((s) => s.name);
    window.__DETAIL_STARMAP_SERVERS__ = normalized;
    root.render(
      <GlobeStarmap
        servers={normalized}
        width={options.width || 760}
        height={options.height || 430}
        baseRadius={options.baseRadius || 180}
        showInfoPanel={options.showInfoPanel ?? false}
        originServerId={options.originServerId ?? null}
      />
    );
  };
  render(servers);
  element.__globeStarmapRender = render;
  return () => {
    delete element.__globeStarmapRender;
    root.unmount();
  };
}
