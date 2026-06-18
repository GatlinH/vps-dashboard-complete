import * as Cesium from 'cesium';

export function setupCesiumScene(viewer, {
  minHeight,
  maxHeight,
  defaultLightIntensity = 2.35,
} = {}) {
  const scene = viewer.scene;
  const globe = scene.globe;

  scene.backgroundColor = Cesium.Color.BLACK;
  // 统一底色: 与 sceneRuntimeState 保持一致的深海蓝, 避免极点网格收敛 /
  // tile 缝隙处透出浅色底色, 在极区形成发亮色块。
  globe.baseColor = Cesium.Color.fromCssColorString('#0c2c4d');
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
