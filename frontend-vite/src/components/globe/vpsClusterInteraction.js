const EARTH_RADIUS_KM = 6371;
const FANOUT_RADIUS_KM = 4;

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

export function clusterMemberGroup(member) {
  return safeText(member?.group ?? member?.group_name, '默认分组');
}

export function clusterMemberPurpose(member) {
  return safeText(member?.tags, safeText(member?.public_note ?? member?.publicRemark, '未分类用途'));
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
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / sorted.length;
    const latOffset = (FANOUT_RADIUS_KM / EARTH_RADIUS_KM) * (180 / Math.PI);
    const lonOffset = latOffset / Math.max(Math.cos(centerLat * Math.PI / 180), 0.2);
    return {
      member,
      lat: centerLat + latOffset * Math.sin(angle),
      lon: centerLon + lonOffset * Math.cos(angle),
      radiusKm: FANOUT_RADIUS_KM,
      visualOnly: true,
    };
  });
}

export function resolveClusterSelection(members = []) {
  const sorted = sortClusterMembers(members);
  return sorted.length > 1 ? { type: 'expand', members: sorted } : { type: 'navigate', member: sorted[0] || null };
}
