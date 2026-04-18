/**
 * utils/traffic.js
 * 流量计算工具函数
 */

/** 格式化 GB 数值（≥1024 自动转 TB） */
export function fmtGb(v) {
  v = Number(v) || 0;
  return v >= 1024 ? `${(v / 1024).toFixed(2)} TB` : `${v.toFixed(1)} GB`;
}

/** 返回已使用流量（GB）*/
export function getTrafficUsed(server) {
  return server.traffic_used_gb
    || ((server.traffic_up_gb || 0) + (server.traffic_down_gb || 0));
}

/** 返回使用百分比（无限量时返回 null）*/
export function getTrafficPct(server) {
  if (!server.traffic_limit_gb || server.traffic_limit_gb <= 0) return null;
  const used = getTrafficUsed(server);
  return Math.min(100, (used / server.traffic_limit_gb) * 100);
}

/** 距下次重置天数 */
export function daysUntilReset(resetDay) {
  const now  = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), resetDay);
  if (next <= now) next.setMonth(next.getMonth() + 1);
  return Math.ceil((next - now) / 86400000);
}

/** 根据使用率返回 CSS 颜色变量 */
export function trafficColor(pct, threshold = 80) {
  if (pct === null)   return 'var(--accent)';
  if (pct >= 95)      return 'var(--red)';
  if (pct >= threshold) return 'var(--orange)';
  return 'var(--green)';
}
