import * as Cesium from 'cesium';
import { FULL_GLOBE_RECTANGLE, GEOGRAPHIC_TILING_SCHEME } from './imageryProviders.js';
import { getGlobeResourceDebug } from '../../utils/debugState.js';

export const MAPTILER_KEY = import.meta.env.VITE_MAPTILER_KEY || '';
export const MAPTILER_STYLE = 'basic-v2';

export function installMaptilerLayer(globe) {
  try {
    if (!Cesium.UrlTemplateImageryProvider || !globe.viewer?.imageryLayers) return;
    const provider = new Cesium.UrlTemplateImageryProvider({
      url: `https://api.maptiler.com/maps/${MAPTILER_STYLE}/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`,
      credit: '© MapTiler © OpenStreetMap contributors',
      // Force EPSG:4326 semantics for any label overlay. This layer stays hidden
      // outside near/detail views, but must not impose a WebMercator polar cutoff.
      tilingScheme: GEOGRAPHIC_TILING_SCHEME,
      rectangle: FULL_GLOBE_RECTANGLE,
      minimumLevel: 0,
      maximumLevel: 18,
    });
    const layer = globe.viewer.imageryLayers.addImageryProvider(provider);
    Object.assign(layer, { show: false, alpha: 0.0, brightness: 1.02, contrast: 1.04, saturation: 0.86 });
    globe._labelTileLayer = layer;
    globe._maptilerLayer = layer;
    getGlobeResourceDebug().globalLabelTiles = `MapTiler ${MAPTILER_STYLE}`;
  } catch (error) {
    getGlobeResourceDebug().globalLabelTilesError = String(error?.message || error);
  }
}
