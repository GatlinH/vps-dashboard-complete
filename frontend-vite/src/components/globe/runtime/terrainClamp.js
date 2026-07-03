import * as Cesium from 'cesium';
import { getServerCoords } from '../../globe-utils.js';
import { getGlobeResourceDebug } from '../../../utils/debugState.js';

export async function refreshNodeGroundHeights(globe, force = false) {
  const now = performance.now();
  if (!force && now - globe._lastNodeClampAt < 2500) return;
  globe._lastNodeClampAt = now;
  const scene = globe.viewer?.scene;
  if (!scene || !globe._nodeEntities?.length) return;
  try {
    const entities = [];
    const cartos = [];
    for (const entity of globe._nodeEntities) {
      const server = entity.properties?.serverData?.getValue?.() || entity.properties?.serverData;
      if (!server) continue;
      const [lat, lon] = getServerCoords(server);
      cartos.push(Cesium.Cartographic.fromDegrees(lon, lat, 90));
      entities.push(entity);
    }
    if (!cartos.length) return;

    let resolved = null;
    if (globe._buildingTileset?.show && scene.clampToHeightMostDetailed) {
      const source = cartos.map((c) => Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 180));
      resolved = await scene.clampToHeightMostDetailed(source);
    } else if (globe._terrainReady && Cesium.sampleTerrainMostDetailed) {
      const sampled = await Cesium.sampleTerrainMostDetailed(globe.viewer.terrainProvider, cartos.map((c) => c.clone()));
      resolved = sampled.map((c) => Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, (c.height || 0) + 42));
    }

    if (!resolved) return;
    let count = 0;
    resolved.forEach((pos, i) => {
      if (!pos || !entities[i]) return;
      const carto = Cesium.Cartographic.fromCartesian(pos);
      carto.height = Math.max(28, (carto.height || 0) + 18);
      entities[i].position = Cesium.Cartesian3.fromRadians(carto.longitude, carto.latitude, carto.height);
      if (entities[i].point) entities[i].point.heightReference = Cesium.HeightReference.RELATIVE_TO_GROUND;
      count += 1;
    });
    getGlobeResourceDebug().nodesClampedToTerrain = count;
    scene.requestRender();
  } catch (error) {
    getGlobeResourceDebug().nodeClampError = String(error?.message || error);
  }
}
