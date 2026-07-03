import * as Cesium from 'cesium';
import { getDashboardDebug, getGlobeResourceDebug } from '../../utils/debugState.js';

export const ARCGIS_WORLD_IMAGERY_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
export const UNIFIED_EARTH_TEXTURE_URL = '/cesium/Assets/Textures/clean-earth-map-v2.jpg';
export const FULL_GLOBE_RECTANGLE = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90);
export const GEOGRAPHIC_TILING_SCHEME = new Cesium.GeographicTilingScheme({ rectangle: FULL_GLOBE_RECTANGLE });

function wireProviderErrors(provider, label) {
  try {
    provider?.errorEvent?.addEventListener?.((error) => {
      const msg = String(error?.message || error || 'unknown imagery error');
      const resources = getGlobeResourceDebug();
      resources.imageryProviderErrors = resources.imageryProviderErrors || [];
      resources.imageryProviderErrors.push({ label, message: msg, timesRetried: error?.timesRetried ?? null });
    });
  } catch (_) {}
}

export async function installEarthImagery(globe) {
  const layers = globe.viewer.imageryLayers;
  layers.removeAll();
  try {
    // 远景统一全球贴图: 单张 equirectangular 纹理覆盖完整地球, 避免 ArcGIS 极区瓦片
    // 与赤道瓦片的数据源/色阶差异。近景再叠加 ArcGIS 细节层。
    const unifiedProvider = await Cesium.SingleTileImageryProvider.fromUrl(UNIFIED_EARTH_TEXTURE_URL, {
      rectangle: FULL_GLOBE_RECTANGLE,
    });
    wireProviderErrors(unifiedProvider, 'Unified Earth Texture');
    const unifiedBase = layers.addImageryProvider(unifiedProvider, 0);
    Object.assign(unifiedBase, {
      show: true,
      alpha: 1.0,
      brightness: 1.0,
      contrast: 1.02,
      saturation: 0.98,
      gamma: 1.0,
    });

    const detailProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ARCGIS_WORLD_IMAGERY_URL, {
      enablePickFeatures: false,
    });
    wireProviderErrors(detailProvider, 'ArcGIS World Imagery Detail');
    const detail = layers.addImageryProvider(detailProvider, 1);
    Object.assign(detail, {
      show: false,
      alpha: 0.0,
      brightness: 1.0,
      contrast: 1.02,
      saturation: 0.98,
      gamma: 1.0,
    });

    globe._safeBaseLayer = unifiedBase;
    globe._blueMarbleLayer = unifiedBase;
    globe._northPolarLayer = null;
    globe._southPolarLayer = null;
    globe._detailLayer = detail;
    globe._baseImageryProvider = unifiedProvider;
    globe._detailImageryProvider = detailProvider;
    const dbg = getDashboardDebug('globe');
    dbg.safeBaseMode = 'Unified global texture base + ArcGIS detail LOD';
    dbg.unifiedEarthTextureUrl = UNIFIED_EARTH_TEXTURE_URL;
    dbg.arcgisWorldImageryUrl = ARCGIS_WORLD_IMAGERY_URL;
    delete dbg.nasaGibsPolarLayers;
    delete dbg.ionImageryAssetId;
    delete dbg.detailLayerSkipped;
    delete dbg.safeBaseError;
  } catch (baseError) {
    getDashboardDebug('globe').safeBaseError = String(baseError?.message || baseError);
    throw baseError;
  }
  globe.viewer.scene.requestRender();
}
