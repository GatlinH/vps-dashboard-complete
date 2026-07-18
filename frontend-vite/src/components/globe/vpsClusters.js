export function clusterServersByCoordinate(servers = []) {
  const groups = new Map();
  for (const server of servers) {
    const lat = Number(server?.lat ?? server?.latitude);
    const lon = Number(server?.lon ?? server?.longitude);
    const valid = Number.isFinite(lat) && Number.isFinite(lon)
      && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
      && !(lat === 0 && lon === 0);
    const key = valid ? `${lat.toFixed(4)},${lon.toFixed(4)}` : `invalid:${server?.id ?? groups.size}`;
    const group = groups.get(key) || { key, lat, lon, valid, members: [] };
    group.members.push(server);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    members: group.members.slice().sort((left, right) => Number(left?.id) - Number(right?.id)),
  }));
}
