export const VPS_CLUSTER_DISTANCE_KM = 1;
const EARTH_RADIUS_KM = 6371;

function getServerCoordinates(server) {
  const lat = Number(server?.lat ?? server?.latitude);
  const lon = Number(server?.lon ?? server?.longitude);
  const valid = Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    && !(lat === 0 && lon === 0);
  return { lat, lon, valid };
}

function sortServers(left, right) {
  const leftId = Number(left?.id);
  const rightId = Number(right?.id);
  if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
  return String(left?.id ?? '').localeCompare(String(right?.id ?? ''));
}

function distanceKm(left, right) {
  const toRadians = (degrees) => degrees * Math.PI / 180;
  const latDelta = toRadians(right.lat - left.lat);
  const lonDelta = toRadians(right.lon - left.lon);
  const leftLat = toRadians(left.lat);
  const rightLat = toRadians(right.lat);
  const haversine = Math.sin(latDelta / 2) ** 2
    + Math.cos(leftLat) * Math.cos(rightLat) * Math.sin(lonDelta / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function centroid(members) {
  const coordinates = members.map(getServerCoordinates);
  return {
    lat: coordinates.reduce((sum, coordinate) => sum + coordinate.lat, 0) / coordinates.length,
    lon: coordinates.reduce((sum, coordinate) => sum + coordinate.lon, 0) / coordinates.length,
  };
}

/**
 * Groups only display-overlapping VPS locations within one kilometre, a city-level
 * presentation threshold. It does not identify locations as the same city.
 */
export function clusterServersByCoordinate(servers = []) {
  const validServers = [];
  const invalidClusters = [];

  for (const server of servers) {
    const coordinates = getServerCoordinates(server);
    if (coordinates.valid) validServers.push({ server, ...coordinates });
    else {
      invalidClusters.push({
        key: `invalid:${server?.id ?? invalidClusters.length}`,
        lat: coordinates.lat,
        lon: coordinates.lon,
        valid: false,
        members: [server],
      });
    }
  }

  validServers.sort((left, right) => sortServers(left.server, right.server));
  const groups = [];
  for (const candidate of validServers) {
    const group = groups.find((currentGroup) => distanceKm(candidate, currentGroup.centroid) <= VPS_CLUSTER_DISTANCE_KM);
    if (group) {
      group.members.push(candidate.server);
      group.centroid = centroid(group.members);
    } else {
      groups.push({ members: [candidate.server], centroid: { lat: candidate.lat, lon: candidate.lon } });
    }
  }

  const validClusters = groups.map((group) => {
    const members = group.members.slice().sort(sortServers);
    const coordinates = centroid(members);
    return {
      key: `cluster:${coordinates.lat.toFixed(6)},${coordinates.lon.toFixed(6)}`,
      ...coordinates,
      valid: true,
      members,
    };
  });

  return [...validClusters, ...invalidClusters];
}
