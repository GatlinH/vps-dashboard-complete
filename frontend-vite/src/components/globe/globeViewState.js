import * as Cesium from 'cesium';

export function getViewCenterCartographic(viewer) {
  try {
    const scene = viewer.scene;
    const canvas = scene.canvas;
    const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
    const picked = viewer.camera.pickEllipsoid(center, scene.globe.ellipsoid);
    return picked ? Cesium.Cartographic.fromCartesian(picked) : null;
  } catch (_) { return null; }
}

export function getGlobeViewState(viewer, { farViewHeight, midViewHeight }) {
  const cameraCarto = viewer.camera.positionCartographic;
  const centerCarto = getViewCenterCartographic(viewer) || cameraCarto;
  const height = cameraCarto?.height || 12_000_000;
  const camLat = centerCarto ? Cesium.Math.toDegrees(centerCarto.latitude) : 0;
  const camLon = centerCarto ? Cesium.Math.toDegrees(centerCarto.longitude) : 0;
  const cameraLat = cameraCarto ? Cesium.Math.toDegrees(cameraCarto.latitude) : camLat;
  const latAbs = Math.max(Math.abs(camLat), Math.abs(cameraLat));
  const truePolar = latAbs > 84.95;
  const highLatitudeView = latAbs > 66;
  const farMode = height >= farViewHeight;
  const midMode = height >= midViewHeight && height < farViewHeight;
  const nearMode = height < midViewHeight;
  const cityMode = height < 220_000;
  return { cameraCarto, centerCarto, height, camLat, camLon, cameraLat, latAbs, truePolar, polarView: truePolar, highLatitudeView, coastalFix: false, farMode, midMode, nearMode, cityMode };
}
