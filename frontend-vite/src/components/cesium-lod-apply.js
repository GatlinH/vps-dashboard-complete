import * as Cesium from 'cesium';

export function applyNodeLOD(globe, { midMode, nearMode, cityMode }) {
  for (const entity of globe._nodeEntities) {
    if (!entity) continue;
    entity.show = true;
    if (entity.point) {
      entity.point.pixelSize = cityMode ? 18 : nearMode ? 15 : 12;
      entity.point.outlineWidth = cityMode ? 3 : nearMode ? 2.5 : 2.5;
      entity.point.outlineColor = Cesium.Color.fromCssColorString('#ffffff').withAlpha(cityMode ? 1.0 : 0.96);
      entity.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    }
    if (entity.label) entity.label.show = false;
  }
  if (typeof window !== 'undefined') {
    window.__vpsBeaconDebug = (globe._nodeEntities || []).map((entity) => ({
      id: entity?.id,
      show: !!entity?.show,
      hasPoint: !!entity?.point,
      pointSize: entity?.point?.pixelSize?.getValue ? entity.point.pixelSize.getValue() : entity?.point?.pixelSize,
      labelShow: !!entity?.label?.show,
    }));
  }
  for (const entity of globe._arcEntities) if (entity) entity.show = false;
}

export function applyImageryLOD(globe, { height, polarView, highLatitudeView, camLat, cameraLat, coastalFix, cityMode }) {
  const latAbs = Math.max(Math.abs(camLat || 0), Math.abs(cameraLat || 0));
  const truePolar = latAbs > 84.95;

  if (globe._safeBaseLayer) {
    globe._safeBaseLayer.show = true;
    globe._safeBaseLayer.alpha = 1.0;
    // Keep the full-globe EPSG:4326 base readable at the poles; do not fade it into a blue/white ball.
    globe._safeBaseLayer.brightness = truePolar ? 1.12 : highLatitudeView ? 1.08 : 1.03;
    globe._safeBaseLayer.contrast = truePolar ? 1.08 : 1.02;
    globe._safeBaseLayer.saturation = truePolar ? 1.10 : highLatitudeView ? 1.06 : 1.02;
    globe._safeBaseLayer.gamma = truePolar ? 0.88 : 0.94;
    try { globe.viewer.imageryLayers.lowerToBottom(globe._safeBaseLayer); } catch (_) {}
  }

  const showDetail = !truePolar;
  if (globe._detailLayer) {
    globe._detailLayer.show = showDetail;
    globe._detailLayer.alpha = showDetail ? 1.0 : 0.0;
    globe._detailLayer.brightness = cityMode ? 1.08 : height < 4_000_000 ? 1.06 : 1.04;
    globe._detailLayer.contrast = 1.06;
    globe._detailLayer.saturation = 1.02;
    globe._detailLayer.gamma = 0.98;
  }

  const showLabelTiles = !truePolar && height < 3_000_000;
  if (globe._labelTileLayer) {
    globe._labelTileLayer.show = showLabelTiles;
    globe._labelTileLayer.alpha = showLabelTiles ? (height < 1_200_000 ? 0.34 : 0.22) : 0.0;
    globe._labelTileLayer.brightness = 1.0;
    globe._labelTileLayer.contrast = 1.04;
    globe._labelTileLayer.saturation = 0.86;
    try { globe.viewer.imageryLayers.raiseToTop(globe._labelTileLayer); } catch (_) {}
  }

  return { showDetail, showLabelTiles };
}

export function setNaturalEarthVectorVisible(globe, show) {
  if (!globe._naturalEarthDataSource || globe._naturalEarthVectorVisible === show) return;
  globe._naturalEarthVectorVisible = show;
  for (const entity of globe._naturalEarthDataSource.entities.values) entity.show = show;
}

export function applyLocalFallbackLOD(globe, { coastalFix, polarView, highLatitudeView, camLat, cameraLat, height }) {
  for (const entity of globe._coastalFallbackEntities || []) entity.show = false;
  for (const entity of globe._coastalLabelEntities || []) entity.show = false;
  const latAbs = Math.max(Math.abs(camLat || 0), Math.abs(cameraLat || 0));
  const truePolar = latAbs > 84.95;
  const showPolarSemantics = truePolar && height < 12_000_000;
  for (const entity of globe._polarIcePatchEntities || []) {
    entity.show = showPolarSemantics;
    if (entity.polygon?.material) {
      entity.polygon.material = Cesium.Color.fromCssColorString('#dcefff').withAlpha(0.34);
    }
  }
  // In true-polar views, a restrained Natural Earth overlay restores land/ice semantics without re-enabling bad WebMercator tiles.
  setNaturalEarthVectorVisible(globe, showPolarSemantics);
  return { showCoastalFallback: false, showNaturalEarthVector: showPolarSemantics, showPolarIcePatch: showPolarSemantics };
}
