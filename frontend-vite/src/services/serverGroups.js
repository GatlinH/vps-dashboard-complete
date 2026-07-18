/** Public grouping normalization: group_info is canonical when present. */
export function normalizePublicServer(server = {}) {
  const info = server.group_info;
  if (info && typeof info === 'object') {
    return { ...server, group: info.name || '默认分组', groupPurpose: info.purpose || '', groupColor: info.color || '' };
  }
  return { ...server, group: server.group || server.group_name || '默认分组', groupPurpose: Array.isArray(server.tags) ? (server.tags[0] || '') : '', groupColor: '' };
}

export function groupClusterMembers(members = []) {
  const groups = new Map();
  for (const member of members.map(normalizePublicServer)) {
    const name = member.group || '默认分组';
    const purpose = member.groupPurpose || '';
    const key = `${name}\u0000${purpose}`;
    if (!groups.has(key)) groups.set(key, { name, purpose, members: [] });
    groups.get(key).members.push(member);
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name) || left.purpose.localeCompare(right.purpose));
}
