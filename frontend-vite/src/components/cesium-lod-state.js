import * as Cesium from 'cesium';

function normalizeLonDeg(lon) {
  return ((lon + 540) % 360) - 180;
}

export function inCoastalFixZone(lon, lat, height, zones) {
  const x = normalizeLonDeg(lon);
  return zones.some((z) => height <= z.maxHeight && x >= z.west && x <= z.east && lat >= z.south && lat <= z.north);
}

export function getViewCenterCartographic(viewer) {
  try {
    const scene = viewer.scene;
    const canvas = scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const picked = viewer.camera.pickEllipsoid(center, scene.globe.ellipsoid);
    return picked ? Cesium.Cartographic.fromCartesian(picked) : null;
  } catch (_) {
    return null;
  }
}

export function getCesiumViewState(viewer, { coastalZones, farViewHeight, midViewHeight }) {
  const cameraCarto = viewer.camera.positionCartographic;
  const centerCarto = getViewCenterCartographic(viewer) || cameraCarto;
  const height = cameraCarto?.height || 12_000_000;
  const camLat = centerCarto ? Cesium.Math.toDegrees(centerCarto.latitude) : 0;
  const camLon = centerCarto ? Cesium.Math.toDegrees(centerCarto.longitude) : 0;
  const cameraLat = cameraCarto ? Cesium.Math.toDegrees(cameraCarto.latitude) : camLat;
  const latAbs = Math.max(Math.abs(camLat), Math.abs(cameraLat));
  const highLatitudeView = latAbs > 60;
  const polarView = latAbs > 84.95;
  const coastalFix = false;
  const farMode = height >= farViewHeight;
  const midMode = height >= midViewHeight && height < farViewHeight;
  const nearMode = height < midViewHeight;
  const cityMode = height < 220_000;
  return { cameraCarto, centerCarto, height, camLat, camLon, cameraLat, latAbs, highLatitudeView, polarView, coastalFix, farMode, midMode, nearMode, cityMode };
}
