const EARTH_RADIUS_KM = 6371;
const MIN_FANOUT_RADIUS_KM = 12;

const ROLE_COLORS = ['#38bdf8', '#a78bfa', '#f97316', '#14b8a6', '#ec4899', '#84cc16'];
const ROLE_SHAPES = ['circle', 'diamond', 'square', 'triangle', 'pin', 'star'];
const STATUS_ALIASES = {
  online: 'online', healthy: 'online', ok: 'online', up: 'online',
  warn: 'warn', warning: 'warn', degraded: 'warn',
  offline: 'offline', error: 'offline', unknown: 'offline', down: 'offline', unavailable: 'offline',
};

export function sortClusterMembers(members = []) {
  return members.slice().sort((left, right) => {
    const leftId = Number(left?.id);
    const rightId = Number(right?.id);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
    return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
  });
}

function safeText(value, fallback) {
  const text = Array.isArray(value) ? value.find((item) => String(item || '').trim()) : value;
  return String(text || '').trim() || fallback;
}

function canonicalGroupInfo(member) {
  return member?.group_info && typeof member.group_info === 'object' ? member.group_info : null;
}

function stableRoleIndex(role) {
  return [...String(role)].reduce((hash, character) => ((hash * 31) + character.codePointAt(0)) >>> 0, 0);
}

export function clusterMemberGroup(member) {
  const info = canonicalGroupInfo(member);
  return safeText(info?.name, safeText(member?.group ?? member?.group_name, '默认分组'));
}

export function clusterMemberPurpose(member) {
  const info = canonicalGroupInfo(member);
  if (info) return safeText(info.purpose, '未分类用途');
  return safeText(member?.tags, safeText(member?.public_note ?? member?.publicRemark, '未分类用途'));
}

export function clusterMemberAppearance(member) {
  const group = clusterMemberGroup(member);
  const purpose = clusterMemberPurpose(member);
  const info = canonicalGroupInfo(member);
  const roleIndex = stableRoleIndex(`${group}\u0000${purpose}`);
  return {
    group,
    purpose,
    color: safeText(info?.color, ROLE_COLORS[roleIndex % ROLE_COLORS.length]),
    shape: ROLE_SHAPES[roleIndex % ROLE_SHAPES.length],
  };
}

export function aggregateClusterStatus(members = []) {
  let aggregate = 'online';
  for (const member of members) {
    const status = STATUS_ALIASES[String(member?.status || '').trim().toLowerCase()] || 'offline';
    if (status === 'offline') return 'offline';
    if (status === 'warn') aggregate = 'warn';
  }
  return aggregate;
}

export function buildClusterBeaconAppearance(members = []) {
  const sectors = new Map();
  for (const member of sortClusterMembers(members)) {
    const appearance = clusterMemberAppearance(member);
    const key = `${appearance.group}\u0000${appearance.purpose}\u0000${appearance.color}`;
    const sector = sectors.get(key) || { ...appearance, count: 0 };
    sector.count += 1;
    sectors.set(key, sector);
  }
  const orderedSectors = [...sectors.values()].sort((left, right) =>
    left.group.localeCompare(right.group, 'zh-CN') || left.purpose.localeCompare(right.purpose, 'zh-CN') || left.color.localeCompare(right.color));
  const groups = [...new Set(sortClusterMembers(members).map((member) => clusterMemberGroup(member)))];
  return {
    status: aggregateClusterStatus(members),
    sectors: orderedSectors,
    label: `${members.length} 个节点 · ${groups.join(' / ') || '默认分组'}`,
  };
}

export function groupClusterMembers(members = []) {
  const groups = new Map();
  for (const member of sortClusterMembers(members)) {
    const group = clusterMemberGroup(member);
    const purpose = clusterMemberPurpose(member);
    if (!groups.has(group)) groups.set(group, new Map());
    const purposes = groups.get(group);
    if (!purposes.has(purpose)) purposes.set(purpose, []);
    purposes.get(purpose).push(member);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
    .map(([group, purposes]) => ({
      group,
      purposes: [...purposes.entries()]
        .sort(([left], [right]) => left.localeCompare(right, 'zh-CN'))
        .map(([purpose, groupedMembers]) => ({ purpose, members: groupedMembers })),
    }));
}

export function buildClusterFanout({ lat, lon, members = [] }) {
  const centerLat = Number(lat);
  const centerLon = Number(lon);
  if (!Number.isFinite(centerLat) || !Number.isFinite(centerLon)) return [];
  return sortClusterMembers(members).map((member, index, sorted) => {
    const radiusKm = Math.max(MIN_FANOUT_RADIUS_KM, 8 + (sorted.length * 2));
    const angle = sorted.length === 1 ? 0 : (-Math.PI / 2) + ((Math.PI * index) / (sorted.length - 1));
    const latOffset = (radiusKm / EARTH_RADIUS_KM) * (180 / Math.PI);
    const lonOffset = latOffset / Math.max(Math.cos(centerLat * Math.PI / 180), 0.2);
    return {
      member,
      appearance: clusterMemberAppearance(member),
      lat: centerLat + latOffset * Math.sin(angle),
      lon: centerLon + lonOffset * Math.cos(angle),
      angleRad: angle,
      radiusKm,
      visualOnly: true,
    };
  });
}

export function resolveClusterSelection(members = []) {
  const sorted = sortClusterMembers(members);
  return sorted.length > 1 ? { type: 'expand', members: sorted } : { type: 'navigate', member: sorted[0] || null };
}
