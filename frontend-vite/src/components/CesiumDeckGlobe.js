/**
 * CesiumDeckGlobe.js — Cesium 1.141 科幻地球 / 真实感增强版
 */
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { getServerCoords } from './globe-utils.js';
import { rebuildVpsEntities } from './globe/vpsEntities.js';
import { getGlobeViewState } from './globe/globeViewState.js';
import { applyNodeLOD, applyImageryLOD, disableLegacyFallbacks } from './globe/globeLod.js';
import { setupCesiumScene } from './globe/runtime/sceneSetup.js';
import { installImageryStack } from './globe/runtime/imageryStack.js';
import { applySceneRuntimeState } from './globe/runtime/sceneRuntimeState.js';
import { installVisitorBeacon, addVisitorBeacon } from './globe/runtime/visitorBeacon.js';
import { refreshNodeGroundHeights } from './globe/runtime/terrainClamp.js';
import { installPlaceLabels, updatePlaceLabels, updateHtmlNodeLabels } from './globe/runtime/labelOverlay.js';
import { startRenderLoop } from './globe/runtime/renderLoop.js';

const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN || '';
const DEFAULT_TARGET = { lon: 108, lat: 18 };
const AUTO_ROTATE_SPEED = 0.8;
const FAR_HEIGHT = 28_000_000;
const MID_HEIGHT = 11_500_000;
const MIN_HEIGHT = 2_500;
const MAX_HEIGHT = 42_000_000;
const FAR_VIEW_HEIGHT = 18_000_000;
const MID_VIEW_HEIGHT = 8_500_000;
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
export class CesiumDeckGlobe {
  constructor(containerSelector, servers, options = {}) {
    this.container = document.querySelector(containerSelector);
    if (!this.container) throw new Error(`Container not found: ${containerSelector}`);
    this.servers = servers || [];
    this.onNodeClick = options.onNodeClick || null;
    this._destroyed = false;
    this._animFrame = null;
    this._lastTime = 0;
    this._userInteracting = false;
    this._interactionTimer = null;
    this._cloudLayer = null;
    this._cloudCollection = null;
    this._safeBaseLayer = null;
    this._detailLayer = null;
    this._labelTileLayer = null;
    this._maptilerLayer = null;
    this._nodeEntities = [];
    this._visitorEntities = [];
    this._visitorInfo = null;
    this._visitorLabel = null;
    this._visitorFetchStarted = false;
    this._arcEntities = [];
    this._tilesLoadingCount = 0;
    this._lastNodeClampAt = 0;
    this._terrainReady = false;
    this._terrainError = '';
    this._loadingBadge = null;
    this._labelLayer = null;
    this._htmlLabels = new Map();
    this._placeLabels = [];
    this._placeLabelLayer = null;
    try { this._init(); } catch (e) { window.__deckGlobeError = e; throw e; }
  }

  _init() {
    this.container.innerHTML = '';
    this._cesiumDiv = document.createElement('div');
    this._cesiumDiv.id = 'cesium-globe-container';
    this._cesiumDiv.style.cssText = 'width:100%;height:100%;position:absolute;inset:0;';
    this.container.appendChild(this._cesiumDiv);
    this._loadingBadge = document.createElement('div');
    this._loadingBadge.className = 'google-earth-loading-badge';
    this._loadingBadge.textContent = '细化 3D 地表…';
    this.container.appendChild(this._loadingBadge);
    this._labelLayer = document.createElement('div');
    this._labelLayer.className = 'google-earth-node-label-layer';
    this.container.appendChild(this._labelLayer);
    this._placeLabelLayer = document.createElement('div');
    this._placeLabelLayer.className = 'google-earth-place-label-layer';
    this.container.appendChild(this._placeLabelLayer);
    this._installPlaceLabels();
    Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;

    this.viewer = new Cesium.Viewer(this._cesiumDiv, {
      baseLayer: false,
      terrainProvider: new Cesium.EllipsoidTerrainProvider(),
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      vrButton: false,
      infoBox: false,
      creditContainer: document.createElement('div'),
      contextOptions: { webgl: { alpha: false, antialias: true, powerPreference: 'high-performance' } },
      msaaSamples: 4,
      requestRenderMode: false,
      targetFrameRate: 60,
    });

    const scene = this.viewer.scene;
    setupCesiumScene(this.viewer, { minHeight: MIN_HEIGHT, maxHeight: MAX_HEIGHT, defaultLightIntensity: 2.35 });

    this._installWorldTerrain();

    this._setHomeView();
    installImageryStack(this);
    this._installCloudLayer();
    this._installCenterZoom();
    this._installFreeTumbleDrag();

    const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
    handler.setInputAction(() => this._onInteraction(), Cesium.ScreenSpaceEventType.LEFT_DOWN);
    handler.setInputAction(() => this._onInteraction(), Cesium.ScreenSpaceEventType.RIGHT_DOWN);
    handler.setInputAction(() => this._onInteraction(), Cesium.ScreenSpaceEventType.MIDDLE_DOWN);
    handler.setInputAction(() => this._onInteraction(), Cesium.ScreenSpaceEventType.WHEEL);
    handler.setInputAction((movement) => this._onPick(movement), Cesium.ScreenSpaceEventType.LEFT_CLICK);
    this._handler = handler;

    this._buildEntities();
    this._installVisitorBeacon();
    this._startLoop();
    window.__globe = this;
    window.__CESIUM_GLOBE__ = this;
  }

  async _installWorldTerrain() {
    try {
      if (this._destroyed || !this.viewer) return;
      const terrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, {
        requestVertexNormals: true,
        requestWaterMask: true,
      });
      if (this._destroyed || !this.viewer) return;
      this.viewer.terrainProvider = terrain;
      this._terrainReady = true;
      this._terrainError = '';
      window.__terrainMode = 'Cesium Ion World Terrain asset 1';
      window.__terrainReady = true;
      window.__ionTerrainAssetId = 1;
      this.viewer.scene.requestRender();
      window.setTimeout(() => this._refreshNodeGroundHeights(true), 900);
    } catch (error) {
      this._terrainReady = false;
      this._terrainError = String(error?.message || error);
      window.__terrainMode = 'ellipsoid fallback';
      window.__terrainError = this._terrainError;
      window.__terrainReady = false;
    }
  }

  _setHomeView() {
    this.viewer.camera.lookAt(
      Cesium.Cartesian3.fromDegrees(DEFAULT_TARGET.lon, DEFAULT_TARGET.lat, 0),
      new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(16),
        Cesium.Math.toRadians(-32),
        12_000_000
      )
    );
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
  }

  _installCenterZoom() {
    const canvas = this.viewer?.scene?.canvas;
    if (!canvas) return;
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const viewer = this.viewer;
      const camera = viewer.camera;
      const scene = viewer.scene;
      const center = new Cesium.Cartesian2(canvas.clientWidth * 0.5, canvas.clientHeight * 0.5);
      let target = camera.pickEllipsoid(center, scene.globe.ellipsoid);
      if (!target) {
        target = scene.globe.pick(camera.getPickRay(center), scene);
      }
      if (!target) {
        target = Cesium.Cartesian3.fromDegrees(DEFAULT_TARGET.lon, DEFAULT_TARGET.lat, 0);
      }
      const range = Cesium.Cartesian3.distance(camera.positionWC, target);
      const nextRange = clamp(range * (e.deltaY > 0 ? 1.18 : 0.82), MIN_HEIGHT, MAX_HEIGHT);
      camera.lookAt(target, new Cesium.HeadingPitchRange(camera.heading, camera.pitch, nextRange));
      camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
      this._onInteraction();
      scene.requestRender();
    }, { passive: false });
  }

  _installFreeTumbleDrag() {
    const canvas = this.viewer?.scene?.canvas;
    if (!canvas) return;
    let dragging = false;
    let last = null;
    const speed = 0.0042;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      dragging = true;
      last = { x: event.clientX, y: event.clientY };
      try { canvas.setPointerCapture?.(event.pointerId); } catch (_) {}
      this._onInteraction();
    }, true);
    window.addEventListener('pointermove', (event) => {
      if (!dragging || !last || !this.viewer) return;
      const dx = event.clientX - last.x;
      const dy = event.clientY - last.y;
      last = { x: event.clientX, y: event.clientY };
      const camera = this.viewer.camera;
      // Drag should feel like grabbing the Earth itself: move pointer right/up,
      // the visible globe follows right/up instead of orbiting the camera opposite.
      camera.rotateRight(-dx * speed);
      camera.rotateUp(-dy * speed);
      this._onInteraction();
      this.viewer.scene.requestRender();
      event.preventDefault?.();
    }, true);
    window.addEventListener('pointerup', () => { dragging = false; last = null; }, true);
    window.__vpsGlobeFreeTumble = true;
  }

  _installCloudLayer() {
    try {
      if (!Cesium.CloudCollection || !Cesium.CumulusCloud) return;
      const clouds = new Cesium.CloudCollection({ show: true, noiseDetail: 16.0, noiseOffset: Cesium.Cartesian3.ZERO });
      const cloudSpecs = [
        { lon: 132, lat: 28, h: 7600, s: [900000, 420000, 76000] },
        { lon: 104, lat: 8, h: 8200, s: [760000, 360000, 68000] },
        { lon: 160, lat: -18, h: 9000, s: [1100000, 520000, 82000] },
        { lon: -145, lat: 25, h: 8500, s: [920000, 440000, 76000] },
        { lon: 42, lat: 42, h: 7800, s: [780000, 360000, 70000] },
        { lon: 8, lat: 53, h: 7600, s: [640000, 320000, 62000] },
      ];
      for (const c of cloudSpecs) {
        clouds.add({
          position: Cesium.Cartesian3.fromDegrees(c.lon, c.lat, c.h),
          scale: new Cesium.Cartesian2(c.s[0], c.s[1]),
          maximumSize: new Cesium.Cartesian3(c.s[0], c.s[1], c.s[2]),
          slice: 0.42,
          brightness: 0.82,
          color: Cesium.Color.WHITE.withAlpha(0.46),
        });
      }
      this._cloudCollection = this.viewer.scene.primitives.add(clouds);
      this.viewer.scene.requestRender();
    } catch (error) {
      window.__cloudLayerError = String(error?.message || error);
    }
  }

  _buildEntities() {
    rebuildVpsEntities(this);
  }

  async _installVisitorBeacon() {
    return installVisitorBeacon(this);
  }

  _addVisitorBeacon() {
    return addVisitorBeacon(this);
  }

  async _refreshNodeGroundHeights(force = false) {
    return refreshNodeGroundHeights(this, force);
  }

  _onPick(movement) {
    const picks = this.viewer.scene.drillPick(movement.position, 12) || [];
    for (const picked of picks) {
      const entity = picked?.id;
      const props = entity?.properties;
      const serverId = props?.serverId?.getValue ? props.serverId.getValue() : props?.serverId;
      if (!serverId) continue;
      const serverData = props?.serverData?.getValue ? props.serverData.getValue() : this.servers.find((s) => s.id === serverId);
      if (serverData && this.onNodeClick) {
        this.onNodeClick(serverData);
        return;
      }
    }
  }

  _onInteraction() {
    this._userInteracting = true;
    clearTimeout(this._interactionTimer);
    this._interactionTimer = setTimeout(() => { this._userInteracting = false; }, 4000);
  }

  _updateAtmosphereAndClouds() {
    const h = this.viewer.camera.positionCartographic?.height || 12_000_000;
    if (this._cloudCollection) {
      this._cloudCollection.show = h > 800000 && h >= 220000;
    }
    const globe = this.viewer.scene.globe;
    if (h > FAR_HEIGHT) globe.atmosphereBrightnessShift = -0.01;
    else if (h > MID_HEIGHT) globe.atmosphereBrightnessShift = 0.01;
    else globe.atmosphereBrightnessShift = 0.04;
  }

  _installPlaceLabels() {
    return installPlaceLabels(this);
  }

  _updateCameraFrontLight() {
    const scene = this.viewer?.scene;
    const camera = this.viewer?.camera;
    if (!scene || !camera || !Cesium.DirectionalLight) return;
    // Cesium DirectionalLight.direction points *toward* the surface. Use the
    // camera forward vector, not its negation, so the currently viewed side is
    // filled instead of turning into a black backside at polar/high-latitude
    // rotations. Lighting is disabled on the globe, but this still keeps
    // terrain/atmosphere and any light-aware primitives from going black.
    // 方向: 以相机前向为基准, 但向左上偏移一个固定分量, 使光轴偏离视线轴。
    // 之前光方向 == 相机视线, 低纬正对相机时镜面高光正好砸在画面正中, 形成
    // "聚光灯式"圆形亮斑(用户反馈"中间没统一")。偏移后高光移到太阳一侧,
    // 呈自然侧面采光: 朝阳面(左上)受光明显, 背光面平滑变暗但不死黑。
    const fwd = Cesium.Cartesian3.normalize(camera.directionWC, new Cesium.Cartesian3());
    const up = Cesium.Cartesian3.normalize(camera.upWC, new Cesium.Cartesian3());
    const right = Cesium.Cartesian3.normalize(camera.rightWC, new Cesium.Cartesian3());
    const dir = new Cesium.Cartesian3();
    Cesium.Cartesian3.multiplyByScalar(fwd, 1.0, dir);
    Cesium.Cartesian3.add(dir, Cesium.Cartesian3.multiplyByScalar(right, -0.65, new Cesium.Cartesian3()), dir);
    Cesium.Cartesian3.add(dir, Cesium.Cartesian3.multiplyByScalar(up, 0.55, new Cesium.Cartesian3()), dir);
    Cesium.Cartesian3.normalize(dir, dir);
    // 极区拉伸纹根因之一: 沿相机方向的强定向光在俯视极点时, 光线与收敛网格几乎
    // 平行, 在极点汇聚成放射状过曝高光(sunburst)。随纬度衰减光强: 低纬适度补光,
    // 高纬/极区显著降低消除拉伸纹。低纬从 2.15 降到 1.45, 进一步压低中心高光强度。
    const latAbs = Math.abs(Cesium.Math.toDegrees(camera.positionCartographic?.latitude || 0));
    const intensity = latAbs > 78 ? 0.0 : latAbs > 60 ? 0.7 : 1.45;
    if (!scene.light || !scene.light.direction) {
      scene.light = new Cesium.DirectionalLight({ direction: dir, color: Cesium.Color.WHITE, intensity });
    } else {
      scene.light.direction = dir;
      scene.light.intensity = intensity;
      scene.light.color = Cesium.Color.WHITE;
    }
  }

  _updatePlaceLabels(height) {
    return updatePlaceLabels(this, height);
  }

  _updateHtmlNodeLabels(cityMode) {
    return updateHtmlNodeLabels(this, cityMode);
  }

  _updateLOD() {
    const view = getGlobeViewState(this.viewer, { farViewHeight: FAR_VIEW_HEIGHT, midViewHeight: MID_VIEW_HEIGHT });
    const { height, polarView, highLatitudeView, coastalFix, camLat, camLon, cameraLat, cityMode, truePolar } = view;

    applyNodeLOD(this, view);
    for (const entity of this._visitorEntities || []) {
      entity.show = view.midMode || view.nearMode || view.cityMode;
    }
    const imagery = applyImageryLOD(this, view);
    disableLegacyFallbacks();

    window.__imageryGuard = {
      mode: truePolar ? 'truePolar' : 'normal',
      polarView,
      highLatitudeView,
      coastalFix,
      camLat,
      camLon,
      cameraLat,
      height,
      detailShown: imagery.showDetail,
      labelShown: imagery.showLabelTiles,
      polarColorT: imagery.polarT,
      imageryBrightness: imagery.brightness,
      imageryContrast: imagery.contrast,
      imagerySaturation: imagery.saturation,
      imageryGamma: imagery.gamma,
      detailAlpha: imagery.detailT,
      detailBrightness: imagery.detailBrightness,
      detailSaturation: imagery.detailSaturation,
      vpsNodeCount: this._nodeEntities?.length || 0,
      visitorNodeCount: this._visitorEntities?.length || 0,
      visitorReady: Boolean(this._visitorInfo),
    };

    applySceneRuntimeState(this, { height, cityMode, highLatitudeView, truePolar });
    this._updateCameraFrontLight();
    this._updatePlaceLabels(height);
    this._updateHtmlNodeLabels(cityMode);
    if ((cityMode || (this._terrainReady && height < 8_500_000)) && this._tilesLoadingCount <= 8) {
      this._refreshNodeGroundHeights();
    }
  }

  _stabilizeCameraRoll() {
    // Intentionally no-op: vertical 360° globe inspection needs free camera roll.
  }

  _startLoop() {
    return startRenderLoop(this, { midViewHeight: MID_VIEW_HEIGHT, autoRotateSpeed: AUTO_ROTATE_SPEED });
  }

  updateServers(servers) {
    this.servers = servers || [];
    const previousVisitorInfo = this._visitorInfo;
    this._buildEntities();
    if (previousVisitorInfo) {
      this._visitorInfo = previousVisitorInfo;
      this._visitorFetchStarted = true;
      this._addVisitorBeacon();
    } else {
      this._installVisitorBeacon();
    }
  }
  flyToCity(lon, lat, height = 6500) {
    const camera = this.viewer.camera;
    this._onInteraction();
    camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      orientation: {
        heading: Cesium.Math.toRadians(18),
        pitch: Cesium.Math.toRadians(-58),
        roll: 0,
      },
      duration: 1.35,
      complete: () => setTimeout(() => this._refreshNodeGroundHeights(), 1800),
    });
  }
  flyToServer(server) {
    const [lat, lon] = getServerCoords(server);
    this.flyToCity(lon, lat, 6500);
  }
  resetView() {
    this._userInteracting = false;
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(112, 18, 13_500_000),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 2.0,
      complete: () => this._setHomeView(),
    });
  }
  resize() { if (this.viewer) this.viewer.resize(); }
  destroy() {
    this._destroyed = true;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    clearTimeout(this._interactionTimer);
    if (this._handler) this._handler.destroy();
    if (this._visualShell) { this._visualShell.destroy(); this._visualShell = null; }
    if (this.viewer) { this.viewer.destroy(); this.viewer = null; }
    this.container.innerHTML = '';
  }
}
