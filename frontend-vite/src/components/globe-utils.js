/**
 * globe-utils.js — Cesium + Deck.gl 地球工具函数
 * 坐标转换、动画、颜色映射
 */

// ── 状态颜色映射（霓虹风） ──────────────────────────────────────────────────
export const STATUS_COLORS = {
  online:  [0, 255, 136],    // 霓虹绿
  warn:    [255, 170, 0],    // 琥珀橙
  offline: [255, 40, 72],    // 霓虹红
  unknown: [100, 120, 160],  // 暗灰蓝
};

export const STATUS_GLOW = {
  online:  [0, 255, 136, 180],
  warn:    [255, 170, 0, 160],
  offline: [255, 40, 72, 160],
  unknown: [100, 120, 160, 100],
};

// ── VPS 节点 fallback 坐标 ──────────────────────────────────────────────────
const GEO_FALLBACK = {
  'SG': [1.35, 103.82],
  'JP': [35.68, 139.65],
  'DE': [50.11, 8.68],
  'LA': [34.05, -118.24],
  'US': [37.77, -122.42],
  'HK': [22.32, 114.17],
  'TW': [25.03, 121.57],
  'KR': [37.57, 126.98],
  'UK': [51.51, -0.13],
  'NL': [52.37, 4.90],
  'FR': [48.86, 2.35],
  'AU': [33.87, 151.21],
  'CA': [43.65, -79.38],
  'RU': [55.76, 37.62],
  'IN': [19.08, 72.88],
  'BR': [-23.55, -46.63],
};

/**
 * 从 server 对象提取经纬度
 * 优先 server.latitude/longitude，fallback 用 name/location 前缀匹配
 */
export function getServerCoords(server) {
  // 后端 API 返回的真实地理坐标字段为 lat/lon（兼容 latitude/longitude 别名）。
  // 优先使用真实坐标，仅在缺失或非法时才回退到 name/location 前缀映射。
  const rawLat = server.lat != null ? server.lat : server.latitude;
  const rawLon = server.lon != null ? server.lon : server.longitude;
  const lat = Number(rawLat);
  const lon = Number(rawLon);
  const valid =
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !(lat === 0 && lon === 0); // 0,0 视为无效占位
  if (valid) {
    return [lat, lon];
  }

  // —— 回退 1：按 name / location 前缀匹配已知城市坐标 ——
  const name = (server.name || server.location || '').toUpperCase();
  for (const [prefix, coords] of Object.entries(GEO_FALLBACK)) {
    if (name.startsWith(prefix)) return coords;
  }

  // —— 回退 2：稳定散列偏移，避免多个未知节点完全重叠 ——
  const hash = (server.id || 0) * 2654435761;
  return [20 + (hash % 40) - 20, 100 + (hash % 60) - 30];
}

/**
 * 获取节点状态颜色
 */
export function getStatusColor(server) {
  return STATUS_COLORS[server.status] || STATUS_COLORS.unknown;
}

export function getStatusGlow(server) {
  return STATUS_GLOW[server.status] || STATUS_GLOW.unknown;
}

/**
 * 生成飞线数据：在线节点两两连线（只取距离最近的几条避免视觉爆炸）
 */
export function generateArcData(servers, maxArcs = 12) {
  const online = servers.filter(s => s.status === 'online');
  if (online.length < 2) return [];

  const arcs = [];
  for (let i = 0; i < online.length; i++) {
    for (let j = i + 1; j < online.length; j++) {
      const [lat1, lon1] = getServerCoords(online[i]);
      const [lat2, lon2] = getServerCoords(online[j]);
      const dist = Math.sqrt((lat1 - lat2) ** 2 + (lon1 - lon2) ** 2);
      arcs.push({
        source: online[i],
        target: online[j],
        sourcePosition: [lon1, lat1],
        targetPosition: [lon2, lat2],
        dist,
      });
    }
  }

  // 按距离排序，取前 maxArcs 条
  arcs.sort((a, b) => a.dist - b.dist);
  return arcs.slice(0, maxArcs);
}

/**
 * 飞线动画时间函数
 */
export function getArcAnimationProgress(time, index, speed = 0.0008) {
  return ((time * speed) + index * 0.15) % 1.0;
}

/**
 * 光柱高度映射（基于 CPU 使用率或固定）
 */
export function getColumnHeight(server) {
  const cpuUse = server.cpu_use ?? server.cpuUse ?? 30;
  // 高度范围: 80000 ~ 600000 米
  return 80000 + (cpuUse / 100) * 520000;
}

/**
 * 光柱半径
 */
export function getColumnRadius(_server) {
  return 18000; // 18km 半径，视觉上足够粗
}
