import * as Cesium from 'cesium';
import { getGlobeRuntimeDebug } from '../../utils/debugState.js';

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }

export function applyNodeLOD(globe, { midMode, nearMode, cityMode }) {
  for (const entity of globe._nodeEntities) {
    if (!entity) continue;
    entity.show = true;
    if (entity.point) {
      // 精致小信标: 远小近大, 细白边, 不再是粗白边大实心点
      entity.point.pixelSize = cityMode ? 16 : nearMode ? 14 : 12;
      entity.point.outlineWidth = cityMode ? 3 : 2.5;
      entity.point.outlineColor = Cesium.Color.fromCssColorString('#ffffff').withAlpha(0.9);
      entity.point.heightReference = Cesium.HeightReference.NONE;
      entity.point.scaleByDistance = new Cesium.NearFarScalar(220000, 1.35, 5.0e7, 0.85);
      entity.point.translucencyByDistance = new Cesium.NearFarScalar(200000, 1.0, 5.0e7, 0.9);
      entity.point.disableDepthTestDistance = Number.POSITIVE_INFINITY;
    }
    if (entity.label) entity.label.show = nearMode || cityMode;
  }
  if (typeof window !== 'undefined') {
    getGlobeRuntimeDebug().vpsBeaconDebug = (globe._nodeEntities || []).map((entity) => ({
      id: entity?.id,
      show: !!entity?.show,
      hasPoint: !!entity?.point,
      pointSize: entity?.point?.pixelSize?.getValue ? entity.point.pixelSize.getValue() : entity?.point?.pixelSize,
      labelShow: !!entity?.label?.show,
    }));
  }
  for (const entity of globe._arcEntities) if (entity) entity.show = false;
}

export function applyImageryLOD(globe, { height, truePolar, highLatitudeView, cityMode, cameraLat = 0 }) {
  const polarT = smoothstep(55, 82, Math.abs(cameraLat || 0));
  // 远景/中景使用统一全球纹理, 不再对 base 做高纬压色；
  // 近景再让 ArcGIS 细节层渐入, 保留城市/节点附近真实卫星细节。
  const detailT = 1 - smoothstep(2_200_000, 4_800_000, height || 0);
  const detailBrightness = lerp(1.0, 0.88, polarT);
  const detailContrast = lerp(1.02, 0.96, polarT);
  const detailSaturation = lerp(0.98, 0.82, polarT);
  const detailGamma = lerp(1.0, 1.06, polarT);
  if (globe._safeBaseLayer) {
    Object.assign(globe._safeBaseLayer, {
      show: true,
      alpha: 1.0,
      brightness: 1.0,
      contrast: 1.02,
      saturation: 0.98,
      gamma: 1.0,
    });
    try { globe.viewer.imageryLayers.lowerToBottom(globe._safeBaseLayer); } catch (_) {}
  }
  const showDetail = detailT > 0.02;
  if (globe._detailLayer) {
    Object.assign(globe._detailLayer, {
      show: showDetail,
      alpha: showDetail ? detailT : 0.0,
      brightness: detailBrightness,
      contrast: detailContrast,
      saturation: detailSaturation,
      gamma: detailGamma,
    });
    try { globe.viewer.imageryLayers.raise(globe._detailLayer); } catch (_) {}
  }
  const showLabelTiles = !truePolar && height < 3_000_000;
  if (globe._labelTileLayer) {
    // label 瓦片饱和度与底图接近, 避免叠加时近景出现明显色差色块
    Object.assign(globe._labelTileLayer, { show: showLabelTiles, alpha: showLabelTiles ? (height < 1_200_000 ? 0.28 : 0.18) : 0.0, brightness: 1.02, contrast: 1.02, saturation: 1.0 });
    try { globe.viewer.imageryLayers.raiseToTop(globe._labelTileLayer); } catch (_) {}
  }
  return {
    showDetail,
    showLabelTiles,
    polarT,
    detailT,
    brightness: 1.0,
    contrast: 1.02,
    saturation: 0.98,
    gamma: 1.0,
    detailBrightness,
    detailContrast,
    detailSaturation,
    detailGamma,
  };
}

export function disableLegacyFallbacks() {
  // A 档重构后已删除 coastal / NaturalEarth / polarIce 兜底实体的创建逻辑。
  // 保留这个轻量返回值给调试状态使用, 明确所有旧 fallback 均为关闭状态。
  return { showCoastalFallback: false, showNaturalEarthVector: false, showPolarIcePatch: false };
}
