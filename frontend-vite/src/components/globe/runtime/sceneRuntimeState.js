import * as Cesium from 'cesium';

export function applySceneRuntimeState(globe, { height, cityMode, highLatitudeView = false, truePolar = false }) {
  const viewer = globe?.viewer;
  const scene = viewer?.scene;
  const runtimeGlobe = scene?.globe;
  if (!viewer || !scene || !runtimeGlobe) return;

  runtimeGlobe.show = true;
  runtimeGlobe.enableLighting = false;

  // 极区放射状拉伸纹根因: groundAtmosphere 在极点曲率处汇聚成 sunburst 高光。
  // 远景保留地面大气辉光(美观), 但进入高纬/极区俯视时关闭, 消除拉伸纹。
  const polarRegion = highLatitudeView || truePolar;
  runtimeGlobe.showGroundAtmosphere = !polarRegion;
  runtimeGlobe.dynamicAtmosphereLighting = false;
  runtimeGlobe.dynamicAtmosphereLightingFromSun = false;
  runtimeGlobe.baseColor = Cesium.Color.fromCssColorString('#0c2c4d');
  runtimeGlobe.atmosphereBrightnessShift = 0.12;
  runtimeGlobe.atmosphereSaturationShift = 0.02;
  runtimeGlobe.maximumScreenSpaceError = cityMode ? 0.85 : height < 2_600_000 ? 1.05 : 1.15;

  scene.verticalExaggeration = cityMode ? 1.08 : height < 2_600_000 ? 1.16 : height < 8_500_000 ? 1.22 : 1.08;
  scene.highDynamicRange = false;
  scene.fog.enabled = false;

  // 极区天空大气也会在极点边缘产生过曝, 高纬时一并关闭
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = !polarRegion;

  const ctrl = scene.screenSpaceCameraController;
  if (ctrl) {
    ctrl.enableRotate = true;
    ctrl.enableTilt = true;
    ctrl.enableLook = true;
    ctrl.enableTranslate = false;
    ctrl.enableCollisionDetection = false;
    ctrl.maximumTiltAngle = undefined;

    // —— 缩放后旋转灵敏度修复 ——
    // Cesium 默认 _maximumRotateRate≈1.77, 近景(低空)时鼠标轻移就把地球甩很远。
    // 改为随相机高度分级限制最大旋转速率: 越近越稳, 远景保持默认手感。
    // 同时略增惯性, 让操作收尾更顺滑而非生硬。
    const nearRotateCap = height < 1_000_000 ? 0.45
      : height < 3_000_000 ? 0.75
      : height < 8_000_000 ? 1.1
      : 1.77;
    ctrl._maximumRotateRate = nearRotateCap;
    ctrl._minimumRotateRate = 1.0 / 5000.0;
    ctrl.inertiaSpin = 0.9;
    ctrl.inertiaZoom = 0.8;
    ctrl.minimumZoomDistance = 800;
    ctrl.maximumZoomDistance = 42_000_000;
  }
  viewer.camera.constrainedAxis = undefined;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  if (globe._cloudCollection) globe._cloudCollection.show = false;
  if (globe._buildingTileset) globe._buildingTileset.show = false;
  document.body.classList.toggle('globe-city-mode', cityMode);

  if (globe._loadingBadge) {
    const showLoading = cityMode && globe._tilesLoadingCount > 180;
    globe._loadingBadge.classList.toggle('is-visible', showLoading);
  }
}
