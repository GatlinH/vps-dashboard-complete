import * as Cesium from 'cesium';

export const CESIUM_THEME_COLORS = Object.freeze({
  dark: Object.freeze({ background: '#050812', base: '#0c2c4d' }),
  light: Object.freeze({ background: '#dcecf4', base: '#6d9bb7' }),
});

export function applyCesiumTheme(viewer, theme = document.documentElement.getAttribute('data-theme')) {
  const palette = CESIUM_THEME_COLORS[theme] || CESIUM_THEME_COLORS.dark;
  if (!viewer?.scene?.globe) return false;
  const scene = viewer.scene;
  const isLightTheme = theme === 'light';

  scene.backgroundColor = Cesium.Color.fromCssColorString(palette.background);
  scene.globe.baseColor = Cesium.Color.fromCssColorString(palette.base);
  if (scene.skyBox) scene.skyBox.show = !isLightTheme;
  if (scene.skyAtmosphere) {
    scene.skyAtmosphere.show = true;
    scene.skyAtmosphere.brightnessShift = isLightTheme ? 0.25 : 0.0;
    scene.skyAtmosphere.hueShift = isLightTheme ? -0.02 : 0.0;
  }
  scene.requestRender();
  return true;
}

export function setupCesiumScene(viewer, {
  minHeight,
  maxHeight,
  defaultLightIntensity = 2.35,
} = {}) {
  const scene = viewer.scene;
  const globe = scene.globe;

  // Theme state is renderer-owned, not a CSS-only body background.
  applyCesiumTheme(viewer);
  // Avoid pale tile seams near poles; applyCesiumTheme supplies the theme base.
  globe.showGroundAtmosphere = true;
  globe.enableLighting = false;
  globe.dynamicAtmosphereLighting = false;
  globe.dynamicAtmosphereLightingFromSun = false;
  globe.atmosphereBrightnessShift = 0.14;
  globe.atmosphereHueShift = 0.0;
  globe.atmosphereSaturationShift = 0.02;
  globe.maximumScreenSpaceError = 0.9;
  globe.depthTestAgainstTerrain = true;
  globe.show = true;
  globe.translucency.enabled = false;

  scene.highDynamicRange = false;
  scene.verticalExaggeration = 1.18;
  scene.verticalExaggerationRelativeHeight = 0.0;
  scene.fog.enabled = false;
  scene.fog.density = 0.00016;
  scene.fog.minimumBrightness = 0.22;
  scene.fxaa = true;
  scene.postProcessStages.fxaa.enabled = true;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (scene.skyBox) scene.skyBox.show = true;
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = true;
  // Theme state is renderer-owned, not a CSS-only body background. Apply it
  // after the scene defaults so light mode can disable the sky box.
  applyCesiumTheme(viewer);
  scene.light = Cesium.DirectionalLight
    ? new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.normalize(new Cesium.Cartesian3(-0.35, -0.45, -0.82), new Cesium.Cartesian3()),
      color: Cesium.Color.WHITE,
      intensity: defaultLightIntensity,
    })
    : new Cesium.SunLight({ intensity: 1.9 });

  const c = scene.screenSpaceCameraController;
  c.enableTilt = true;
  c.enableTranslate = false;
  c.enableLook = true;
  c.enableCollisionDetection = false;
  c.inertiaSpin = 0.9;
  c.inertiaTranslate = 0.0;
  c.inertiaZoom = 0.78;
  c.minimumZoomDistance = minHeight;
  c.maximumZoomDistance = maxHeight;
  c.zoomEventTypes = [];
  c.maximumTiltAngle = undefined;
  viewer.camera.constrainedAxis = undefined;
}
