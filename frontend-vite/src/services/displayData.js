import { getIPInfo } from '../api/public.js';

export function hasOwnMetric(source, key) {
  return source && Object.prototype.hasOwnProperty.call(source, key) && source[key] != null && source[key] !== '';
}

const COUNTRY_FLAG_BY_CODE = { UK:'🇬🇧', UN:'🌐' };

export function flagFromCountryCode(code) {
  const normalized = String(code || '').trim().toUpperCase();
  const cc = normalized === 'UK' ? 'GB' : normalized;
  if (COUNTRY_FLAG_BY_CODE[normalized]) return COUNTRY_FLAG_BY_CODE[normalized];
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return Array.from(cc).map(ch => String.fromCodePoint(0x1F1E6 + ch.charCodeAt(0) - 65)).join('');
}

const FLAG_LOCATION_RULES = [
  ['香港|hong kong|\bhk\b', '🇭🇰'], ['澳门|macao|macau', '🇲🇴'], ['台湾|taiwan|taipei|台北', '🇹🇼'],
  ['新加坡|singapore|\bsg\b', '🇸🇬'], ['日本|东京|大阪|sakura|japan|tokyo|osaka|\bjp\b', '🇯🇵'], ['韩国|首尔|korea|seoul|\bkr\b', '🇰🇷'],
  ['美国|洛杉矶|纽约|西雅图|圣何塞|硅谷|达拉斯|芝加哥|迈阿密|ashburn|los angeles|new york|seattle|san jose|silicon valley|dallas|chicago|miami|\bus\b|\busa\b', '🇺🇸'],
  ['加拿大|多伦多|温哥华|蒙特利尔|canada|toronto|vancouver|montreal|\bca\b', '🇨🇦'],
  ['德国|法兰克福|hetzner|germany|frankfurt|\bde\b', '🇩🇪'], ['荷兰|阿姆斯特丹|netherlands|amsterdam|\bnl\b', '🇳🇱'],
  ['英国|伦敦|united kingdom|london|\buk\b|\bgb\b', '🇬🇧'], ['法国|巴黎|france|paris|\bfr\b', '🇫🇷'],
  ['西班牙|马德里|spain|madrid|\bes\b', '🇪🇸'], ['意大利|米兰|罗马|italy|milan|rome|\bit\b', '🇮🇹'],
  ['澳大利亚|悉尼|墨尔本|australia|sydney|melbourne|\bau\b', '🇦🇺'], ['印度|孟买|德里|india|mumbai|delhi|\bin\b', '🇮🇳'],
  ['巴西|圣保罗|brazil|sao paulo|são paulo|\bbr\b', '🇧🇷'], ['中国|北京|上海|深圳|广州|china|beijing|shanghai|shenzhen|guangzhou|\bcn\b', '🇨🇳']
].map(([pattern, flag]) => [new RegExp(pattern, 'i'), flag]);

export function inferFlagFromLocation(...parts) {
  const text = parts.filter(Boolean).map(v => typeof v === 'object' ? Object.values(v).join(' ') : String(v)).join(' · ');
  const directCode = parts
    .map(v => (v == null || typeof v === 'object') ? '' : String(v).trim())
    .find(v => /^[A-Za-z]{2}$/.test(v));
  const directFlag = flagFromCountryCode(directCode);
  if (directFlag) return directFlag;
  for (const [rule, flag] of FLAG_LOCATION_RULES) if (rule.test(text)) return flag;
  const code = text.match(/(?:^|[^A-Za-z])([A-Za-z]{2})(?:[^A-Za-z]|$)/)?.[1];
  return flagFromCountryCode(code) || '🌐';
}

export function hasExplicitFlag(flag) {
  return /[\u{1F1E6}-\u{1F1FF}]{2}/u.test(String(flag || ''));
}

export function normalizeServer(s) {
  const cfg = s.agent_config && typeof s.agent_config === 'object' ? s.agent_config : {};
  const meta = cfg.inventory_meta && typeof cfg.inventory_meta === 'object' ? cfg.inventory_meta : {};
  const liveMetricFlags = {
    cpu_use: hasOwnMetric(s, 'cpu_use'),
    ram_use: hasOwnMetric(s, 'ram_use'),
    disk_use: hasOwnMetric(s, 'disk_use'),
  };
  const locationParts = [
    s.location,
    s.city,
    meta.city,
    s.region,
    meta.region,
    s.state,
    s.province,
    s.country,
    meta.country,
    s.country_name,
    s.address,
    s.address_text,
    s.geo?.city,
    s.geo?.region,
    s.geo?.country,
  ].filter(Boolean);

  return {
    ...s,
    agent_config: cfg,
    __liveMetricFlags: liveMetricFlags,
    group: s.group_name || s.group || '默认分组',
    bw: s.bandwidth || s.bw || '不限',
    cpu: s.cpu_cores || s.cpu || 1,
    ram: s.ram_gb || s.ram || 1,
    disk: s.disk_gb || s.disk || 20,
    cpu_use: Number(s.cpu_use || 0),
    ram_use: Number(s.ram_use || 0),
    disk_use: Number(s.disk_use || 0),
    net_up: Number(s.net_up || 0),
    net_down: Number(s.net_down || 0),
    uptime: s.uptime || '—',
    traffic_limit_gb: Number(s.traffic_limit_gb || 0),
    traffic_up_gb: Number(s.traffic_up_gb || 0),
    traffic_down_gb: Number(s.traffic_down_gb || 0),
    traffic_used_gb: Number(s.traffic_used_gb || 0),
    traffic_reset_day: Number(s.traffic_reset_day || 1),
    price: Number(s.price || 0),
    flag: hasExplicitFlag(s.flag) ? s.flag : inferFlagFromLocation(s.country_code, s.countryCode, s.country, s.country_name, s.location, s.city, meta.country, meta.city, s.region, s.address, s.name, s.geo),
    provider_guess: s.provider_guess || meta.provider_guess || cfg.provider_guess || meta.org || meta.isp || '',
    os: s.os || meta.os || cfg.os || '',
    arch: s.arch || meta.arch || cfg.arch || '',
    hostname: s.hostname || meta.hostname || cfg.hostname || s.name || '',
    ip: s.ip || s.public_ip || s.host || meta.ip || meta.public_ip || cfg.ip || cfg.public_ip || '',
    latitude: s.latitude ?? s.lat ?? meta.lat ?? cfg.lat ?? s.geo?.latitude ?? s.geo?.lat ?? s.location_lat,
    longitude: s.longitude ?? s.lon ?? s.lng ?? meta.lon ?? meta.lng ?? cfg.lon ?? cfg.lng ?? s.geo?.longitude ?? s.geo?.lon ?? s.geo?.lng ?? s.location_lng,
    coord_source: (s.latitude ?? s.lat ?? meta.lat ?? cfg.lat ?? s.geo?.latitude ?? s.geo?.lat ?? s.location_lat) != null && (s.longitude ?? s.lon ?? s.lng ?? meta.lon ?? meta.lng ?? cfg.lon ?? cfg.lng ?? s.geo?.longitude ?? s.geo?.lon ?? s.geo?.lng ?? s.location_lng) != null ? 'backend' : '',
    city: s.city ?? meta.city ?? s.geo?.city ?? '',
    region: s.region ?? meta.region ?? s.state ?? s.province ?? s.geo?.region ?? '',
    country: s.country ?? meta.country ?? s.country_name ?? s.geo?.country ?? '',
    public_note: s.public_note || s.publicRemark || s.public_remark || s.remark || (s.location && !String(s.region || '').trim() ? s.location : ''),
    publicRemark: s.publicRemark || s.public_note || s.public_remark || s.remark || (s.location && !String(s.region || '').trim() ? s.location : ''),
    address: s.address ?? s.address_text ?? locationParts.join(', '),
    location: s.location || locationParts.join(' · '),
  };
}


export async function fetchJson(url, options = {}) {
  const { timeoutMs = 2500, ...fetchOptions } = options || {};
  const controller = new AbortController();
  const upstreamSignal = fetchOptions.signal;
  let timeoutId = null;
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason);
  if (upstreamSignal) {
    if (upstreamSignal.aborted) abortFromUpstream();
    else upstreamSignal.addEventListener('abort', abortFromUpstream, { once: true });
  }
  if (timeoutMs > 0) timeoutId = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  fetchOptions.signal = controller.signal;
  try {
    const response = await fetch(url, fetchOptions);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.msg || data.message || `HTTP ${response.status}`);
    return data;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (upstreamSignal) upstreamSignal.removeEventListener('abort', abortFromUpstream);
  }
}


export async function fetchServerHistory(serverId, days = 1, limit = 48, bucketMinutes = null) {
  const root = window.__DBG__.API_ROOT || (location.port === 5000 ? `${location.protocol}//${location.hostname}:5000` : location.origin);
  const bucketParam = bucketMinutes ? `&bucket_minutes=${encodeURIComponent(bucketMinutes)}` : '';
  return fetchJson(`${root}/api/v1/servers/public/${serverId}/history?days=${days}${bucketParam}&limit=${limit}`, { timeoutMs: Math.max(1200, limit > 1000 ? 12000 : 1200) });
}

export async function fetchPingTargets(serverId, count = 1, source = '') {
  const root = window.__DBG__.API_ROOT || (location.port === 5000 ? `${location.protocol}//${location.hostname}:5000` : location.origin);
  const sourceParam = source ? `&source=${encodeURIComponent(source)}` : '';
  return fetchJson(`${root}/api/v1/probe/public/ping-targets/${serverId}?count=${count}${sourceParam}`, { timeoutMs: 9000 });
}

export async function fetchPingTargetHistory(serverId, hours = 12, limit = 2000) {
  const root = window.__DBG__.API_ROOT || (location.port === 5000 ? `${location.protocol}//${location.hostname}:5000` : location.origin);
  return fetchJson(`${root}/api/v1/probe/public/ping-targets/${serverId}/history?hours=${hours}&limit=${limit}`, { timeoutMs: 9000 });
}

export async function fetchPing(resolvedServer) {
  if (!resolvedServer?.ip) return null;
  if (pingAbortController) pingAbortController.abort();
  pingAbortController = new AbortController();
  return fetchJson(`${API_ROOT}/api/v1/probe/public/ping`, {
    timeoutMs: 1200,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ host: resolvedServer.ip, port: 443, count: 3 }),
    signal: pingAbortController.signal,
  });
}


export function hasValidServerCoords(server) {
  const lat = Number(server?.latitude ?? server?.lat);
  const lon = Number(server?.longitude ?? server?.lon ?? server?.lng);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 && !(lat === 0 && lon === 0);
}

export function publicIpForGeo(server) {
  const raw = String(server?.ip || server?.public_ip || server?.agent_config?.inventory_meta?.ip || '').trim();
  if (!raw) return '';
  const ip = raw.replace(/^\[|\]$/g, '').split(':')[0];
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) return '';
  if (/^(10|127|169\.254|192\.168)\./.test(ip) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return '';
  return ip;
}

export async function enrichServersWithIpGeo(servers) {
  const rows = Array.isArray(servers) ? servers : [];
  await Promise.all(rows.map(async (server) => {
    if (hasValidServerCoords(server)) return;
    const ip = publicIpForGeo(server);
    if (!ip) return;
    try {
      const info = await getIPInfo(ip);
      const lat = Number(info?.lat ?? info?.latitude);
      const lon = Number(info?.lon ?? info?.lng ?? info?.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
        server.latitude = lat;
        server.longitude = lon;
        server.lat = lat;
        server.lon = lon;
        server.coord_source = 'ip-geo';
        server.city = server.city || info.city || '';
        server.region = server.region || info.regionName || info.region || '';
        server.country = server.country || info.country || '';
        server.provider_guess = server.provider_guess || info.isp || info.org || '';
      }
    } catch (error) {
      server.coord_source = server.coord_source || 'fallback';
      window.__DBG__.LAST_IP_GEO_ERROR = { id: server.id, ip, message: error?.message || String(error) };
    }
  }));
  return rows;
}

