/**
 * CesiumGlobe.js — 原生 CesiumJS 数字地球 (Google Earth 风格重建 v2)
 *
 * 设计原则:
 *  1. 相机交互完全交给 Cesium 原生 ScreenSpaceCameraController —— 惯性旋转 /
 *     滚轮缩放定位到光标 / 倾斜 / 360° 自由姿态。
 *  2. 影像走真实卫星: ArcGIS World Imagery 作为常驻底图 (各缩放级别都是真实卫星,
 *     最接近 Google Earth); Blue Marble 单张全球纹理垫底, 兜住 ArcGIS 在 ±85° 以上
 *     无瓦片的极区, 让两极有自然冰盖而不是空洞。
 *  3. 云层: 半透明全球云图叠加, 远景 (太空视角) 显示, 近景 (城市级) 淡出, 模拟
 *     "从太空看到云、贴近地面云消失" 的真实层次。
 *  4. 大气干净: 全纬度统一的柔和蓝色大气, 不在高纬关闭 (避免极区发暗/割裂),
 *     压低亮度与 HDR 避免边缘白环。
 *  5. 自转: 太空视角下地球缓慢自转, 用户一交互即停, 静止数秒后恢复; 贴近地面不自转。
 *
 * 公共契约 (与 main.js 对齐, 不可破坏):
 *  - constructor(containerSelector, servers, { onNodeClick })
 *  - updateServers(servers) / setServers(servers)
 *  - flyToServer(server) / flyToCity(lon, lat, height) / resetView()
 *  - resize() / destroy()
 */
import * as Cesium from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import { getServerCoords } from './globe-utils.js';
import { rebuildVpsEntities } from './globe/vpsEntities.js';
import { installVisitorBeacon } from './globe/runtime/visitorBeacon.js';
import { installPlaceLabels, updatePlaceLabels, updateHtmlNodeLabels } from './globe/runtime/labelOverlay.js';
import { StarEffectsLayer } from './StarEffectsLayer.js';
import { NasaParallaxBackground } from './NasaParallaxBackground.js';

const CESIUM_ION_TOKEN = import.meta.env.VITE_CESIUM_ION_TOKEN || '';
const BLUE_MARBLE_TEXTURE_URL = '/globe/earth_atmos_2048.jpg';   // 真实地貌底图 (兜底 + 极区冰盖)
const CLOUDS_TEXTURE_URL = '/globe/earth_clouds_1024.png';        // 半透明云层
const SKYBOX_BASE_URL = '/globe/skybox-projection-v3';
const SKYBOX_SOURCES = {
  positiveX: `${SKYBOX_BASE_URL}/px.png`,
  negativeX: `${SKYBOX_BASE_URL}/nx.png`,
  positiveY: `${SKYBOX_BASE_URL}/py.png`,
  negativeY: `${SKYBOX_BASE_URL}/ny.png`,
  positiveZ: `${SKYBOX_BASE_URL}/pz.png`,
  negativeZ: `${SKYBOX_BASE_URL}/nz.png`,
};
const ARCGIS_WORLD_IMAGERY_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer';
const FULL_GLOBE_RECTANGLE = Cesium.Rectangle.fromDegrees(-180, -90, 180, 90);

const DEFAULT_TARGET = { lon: 108, lat: 18 };
const HOME_HEIGHT = 13_000_000;
const MIN_ZOOM = 800;            // 近景最小距离 (米), 城市街区级
const MAX_ZOOM = 42_000_000;     // 远景最大距离, 接近"太空看地球"

// 云层按相机高度淡入淡出: 高于 FAR 全显, 低于 NEAR 全隐
const CLOUD_FADE_NEAR = 600_000;
const CLOUD_FADE_FAR = 3_500_000;
const CLOUD_MAX_ALPHA = 0.55;

// 自转: 仅在太空视角 (高度高于阈值) 自转; 贴近地面停转
const AUTOROTATE_MIN_HEIGHT = 4_500_000;
const AUTOROTATE_SPEED = 0.00055;   // 弧度/帧, 约 190 秒一圈
const AUTOROTATE_RESUME_MS = 5000;  // 用户停止交互后多久恢复自转

// 节点标签可见的高度阈值
const NODE_LABEL_HEIGHT = 3_500_000;

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export class CesiumGlobe {
  constructor(containerSelector, servers, options = {}) {
    this.container = document.querySelector(containerSelector);
    if (!this.container) throw new Error(`Container not found: ${containerSelector}`);
    this.servers = servers || [];
    this.onNodeClick = options.onNodeClick || null;
    this._destroyed = false;

    // VPS / 访客 / 标签状态
    this._nodeEntities = [];
    this._visitorEntities = [];
    this._visitorInfo = null;
    this._visitorLabel = null;
    this._visitorFetchStarted = false;
    this._arcEntities = [];
    this._htmlLabels = new Map();
    this._placeLabels = [];
    this._tilesLoadingCount = 0;
    this._lastNodeClampAt = 0;

    // 自转状态
    this._autoRotateEnabled = true;   // 总开关 (高度合适时才真正转)
    this._userInteracting = false;
    this._resumeTimer = null;
    this._raf = null;

    try { this._init(); } catch (e) { window.__globeError = e; throw e; }
  }

  _init() {
    this.container.innerHTML = '';
    this._starProjectionBg = document.createElement('div');
    this._starProjectionBg.className = 'globe-star-projection-bg heic-nebula-host';
    this._starProjectionBg.setAttribute('aria-hidden', 'true');
    this._earthSyncStarsA = document.createElement('div');
    this._earthSyncStarsA.className = 'earth-sync-stars earth-sync-stars-a';
    this._earthSyncStarsB = document.createElement('div');
    this._earthSyncStarsB.className = 'earth-sync-stars earth-sync-stars-b';
    this._starProjectionBg.appendChild(this._earthSyncStarsA);
    this._starProjectionBg.appendChild(this._earthSyncStarsB);
    this.container.appendChild(this._starProjectionBg);
    this._nasaParallaxBackground = new NasaParallaxBackground(this._starProjectionBg);
    this._starEffectsLayer = new StarEffectsLayer(this.container, { seed: 2406 });

    this._cesiumDiv = document.createElement('div');
    this._cesiumDiv.id = 'cesium-globe-container';
    this._cesiumDiv.style.cssText = 'width:100%;height:100%;position:absolute;inset:0;';
    this.container.appendChild(this._cesiumDiv);

    // HTML 标签层
    this._labelLayer = document.createElement('div');
    this._labelLayer.className = 'google-earth-node-label-layer';
    this.container.appendChild(this._labelLayer);
    this._placeLabelLayer = document.createElement('div');
    this._placeLabelLayer.className = 'google-earth-place-label-layer';
    this.container.appendChild(this._placeLabelLayer);

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
      creditContainer: this._hiddenCreditContainer(),
      contextOptions: { webgl: { alpha: true, antialias: true, powerPreference: 'high-performance' } },
      msaaSamples: 4,
      // 按需渲染: 静止零开销; 自转时由 rAF 每帧 requestRender 驱动
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
    });

    this._setupScene();
    this._setupNativeCamera();
    this._installImagery();
    this._installWorldTerrain();
    this._installPlaceLabels();
    this._setHomeView();

    // 节点点击 -> 详情页
    this._handler = new Cesium.ScreenSpaceEventHandler(this.viewer.scene.canvas);
    this._handler.setInputAction((m) => this._onClick(m), Cesium.ScreenSpaceEventType.LEFT_CLICK);

    this._removeCameraListener = this.viewer.camera.changed.addEventListener(() => this._onCameraChanged());
    this.viewer.camera.percentageChanged = 0.02;
    this._removePostRender = this.viewer.scene.postRender.addEventListener(() => this._updateOverlays());

    this._buildEntities();
    installVisitorBeacon(this);
    this._onCameraChanged();
    this._installAutoRotate();

    window.__globe = this;
    window.__CESIUM_GLOBE__ = this;
    window.__globeMode = 'Native CesiumJS rebuild v2 (real imagery + clouds + spin)';
  }

  _hiddenCreditContainer() {
    if (!this._creditContainer) {
      this._creditContainer = document.createElement('div');
      this._creditContainer.className = 'hidden-cesium-credit-container';
      this._creditContainer.setAttribute('aria-hidden', 'true');
      this._creditContainer.style.cssText = 'display:none!important;visibility:hidden!important;position:absolute!important;left:-99999px!important;top:-99999px!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;opacity:0!important;';
      document.body.appendChild(this._creditContainer);
    }
    return this._creditContainer;
  }

  _setupScene() {
    const scene = this.viewer.scene;
    const globe = scene.globe;
    scene.backgroundColor = Cesium.Color.TRANSPARENT;
    globe.baseColor = Cesium.Color.fromCssColorString('#1b4f7c');
    globe.enableLighting = false;            // 永久关闭真实昼夜光照, 避免旋转到任何角度仍死黑
    globe.dynamicAtmosphereLighting = false;
    globe.dynamicAtmosphereLightingFromSun = false;
    globe.maximumScreenSpaceError = 1.4;
    globe.depthTestAgainstTerrain = true;
    globe.translucency.enabled = false;
    globe.showWaterEffect = false;           // 关镜面水效, 避免极点高光白斑

    // 地面大气: 全纬度统一保留, 柔和偏蓝, 压低亮度避免边缘白环
    globe.showGroundAtmosphere = true;
    globe.atmosphereBrightnessShift = -0.05;
    globe.atmosphereSaturationShift = 0.12;
    globe.atmosphereHueShift = 0.0;

    scene.highDynamicRange = false;          // 关 HDR, 避免大气/海面过曝成白
    scene.verticalExaggeration = 1.0;
    scene.fog.enabled = true;
    scene.fog.density = 0.00010;

    // 天空背景交给自定义 SkyBox；保留地面大气，不让 Cesium 的天空大气雾层盖住星云背景。
    if (scene.skyAtmosphere) {
      scene.skyAtmosphere.show = false;
      scene.skyAtmosphere.brightnessShift = -0.12;
      scene.skyAtmosphere.saturationShift = 0.10;
      scene.skyAtmosphere.hueShift = 0.0;
    }
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    // 背景星空改为 DOM 平面投影层，避免 SkyBox 六面体/正方体空间感。
    if (scene.skyBox) scene.skyBox.show = false;
    window.__customSkyBoxSources = null;
    window.__starProjectionBackground = '/globe/star-projection-bg.png';

    // 固定方向光 (仅用于实体/大气方向感, 地表 enableLighting=false 不受其变暗)
    scene.light = new Cesium.DirectionalLight({
      direction: Cesium.Cartesian3.normalize(new Cesium.Cartesian3(-0.42, -0.35, -0.84), new Cesium.Cartesian3()),
      color: Cesium.Color.WHITE,
      intensity: 2.0,
    });
  }

  _setupNativeCamera() {
    const c = this.viewer.scene.screenSpaceCameraController;
    c.enableRotate = true;
    c.enableTranslate = false; // keep globe centered; avoid surface-map drift during zoom/drag
    c.enableZoom = true;
    c.enableTilt = false;
    c.enableLook = false;
    c.enableCollisionDetection = true;
    c.inertiaSpin = 0.92;
    c.inertiaTranslate = 0.0;
    c.inertiaZoom = 0.0;
    c.minimumZoomDistance = MIN_ZOOM;
    c.maximumZoomDistance = MAX_ZOOM;
    c.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH];
    // Plain left-drag is handled by our free-spin pointer path below; disabling native
    // surface-anchored LEFT_DRAG removes the polar/up-down clamp feel.
    c.rotateEventTypes = [];
    c.tiltEventTypes = [];
    c.maximumTiltAngle = undefined;
    c.minimumCollisionTerrainHeight = 0;
    this.viewer.camera.constrainedAxis = undefined; // 允许 360° 翻转 (含上下越过两极)
  }

  async _installImagery() {
    const layers = this.viewer.imageryLayers;
    layers.removeAll();
    try {
      // 垫底层: Blue Marble 真实地貌, 兜住 ArcGIS 在 ±85° 以上无瓦片的极区
      const baseProvider = await Cesium.SingleTileImageryProvider.fromUrl(BLUE_MARBLE_TEXTURE_URL, {
        rectangle: FULL_GLOBE_RECTANGLE,
      });
      if (this._destroyed) return;
      const base = layers.addImageryProvider(baseProvider, 0);
      Object.assign(base, { show: true, alpha: 1.0, brightness: 1.48, contrast: 1.03, saturation: 1.16, gamma: 0.70 });
      this._baseLayer = base;

      // 主图层: ArcGIS World Imagery 真实卫星, 各缩放级别常驻 (Google Earth 观感)
      const satProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ARCGIS_WORLD_IMAGERY_URL, {
        enablePickFeatures: false,
      });
      if (this._destroyed) return;
      const sat = layers.addImageryProvider(satProvider, 1);
      Object.assign(sat, { show: true, alpha: 1.0, brightness: 1.42, contrast: 1.03, saturation: 1.14, gamma: 0.72 });
      this._satLayer = sat;

      // 云层: 半透明全球云图, 远景显示近景淡出
      const cloudProvider = await Cesium.SingleTileImageryProvider.fromUrl(CLOUDS_TEXTURE_URL, {
        rectangle: FULL_GLOBE_RECTANGLE,
      });
      if (this._destroyed) return;
      const clouds = layers.addImageryProvider(cloudProvider, 2);
      Object.assign(clouds, { show: true, alpha: CLOUD_MAX_ALPHA, brightness: 1.32, contrast: 1.08, gamma: 0.86 });
      this._cloudLayer = clouds;

      window.__imageryMode = 'ArcGIS World Imagery + Blue Marble base + cloud overlay';
      this._onCameraChanged();
      this.viewer.scene.requestRender();
    } catch (e) {
      window.__imageryError = String(e?.message || e);
    }
  }

  async _installWorldTerrain() {
    try {
      const terrain = await Cesium.CesiumTerrainProvider.fromIonAssetId(1, {
        requestVertexNormals: true,
        requestWaterMask: false,
      });
      if (this._destroyed || !this.viewer) return;
      this.viewer.terrainProvider = terrain;
      this._terrainReady = true;
      window.__terrainMode = 'Cesium Ion World Terrain';
      this.viewer.scene.requestRender();
    } catch (e) {
      this._terrainReady = false;
      window.__terrainError = String(e?.message || e);
    }
  }

  _installPlaceLabels() {
    try { installPlaceLabels(this); } catch (_) {}
  }

  _getInitialTarget() {
    const valid = (this.servers || [])
      .map((server) => {
        const [lat, lon] = getServerCoords(server);
        return { lat, lon };
      })
      .filter(({ lat, lon }) => Number.isFinite(lat) && Number.isFinite(lon));
    if (!valid.length) return DEFAULT_TARGET;
    const lat = valid.reduce((sum, p) => sum + p.lat, 0) / valid.length;
    const lon = valid.reduce((sum, p) => sum + p.lon, 0) / valid.length;
    return { lat, lon };
  }

  _setHomeView() {
    const target = this._getInitialTarget();
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, HOME_HEIGHT),
    });
  }

  _buildEntities() {
    rebuildVpsEntities(this);
    this.viewer.scene.requestRender();
  }

  // ── 自转 ─────────────────────────────────────────────
  _installAutoRotate() {
    const canvas = this.viewer.scene.canvas;
    const pause = () => {
      this._userInteracting = true;
      if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    };
    let freeSpin = null;
    const getCanvasPoint = (event) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const scheduleResume = () => {
      if (this._resumeTimer) clearTimeout(this._resumeTimer);
      this._resumeTimer = setTimeout(() => { this._userInteracting = false; }, AUTOROTATE_RESUME_MS);
    };
    const eventKey = (event) => event.pointerId ?? 'mouse';
    const isPlainPrimaryDrag = (event) => (event.button === 0 || event.buttons === 1 || event.type === 'mousemove')
      && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
    this._rotateCameraAroundEarth = (axis, angle) => {
      if (!axis || !Number.isFinite(angle) || Math.abs(angle) < 1e-6) return;
      const camera = this.viewer.camera;
      const q = Cesium.Quaternion.fromAxisAngle(Cesium.Cartesian3.normalize(axis, new Cesium.Cartesian3()), angle);
      const m = Cesium.Matrix3.fromQuaternion(q);
      const destination = Cesium.Matrix3.multiplyByVector(m, camera.positionWC, new Cesium.Cartesian3());
      const direction = Cesium.Cartesian3.normalize(Cesium.Matrix3.multiplyByVector(m, camera.directionWC, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      const up = Cesium.Cartesian3.normalize(Cesium.Matrix3.multiplyByVector(m, camera.upWC, new Cesium.Cartesian3()), new Cesium.Cartesian3());
      camera.setView({ destination, orientation: { direction, up } });
    };
    this._applyFreeSpinDelta = (dx, dy) => {
      if (Math.abs(dx) + Math.abs(dy) < 0.25) return;
      // Quaternion free-spin around Earth center. This avoids Cesium rotateUp polar clamps,
      // so vertical dragging can cross both poles and continue through a full 360°.
      const camera = this.viewer.camera;
      const spinSpeed = 0.0032;
      if (Math.abs(dx) >= 0.01) this._rotateCameraAroundEarth(Cesium.Cartesian3.UNIT_Z, -dx * spinSpeed);
      if (Math.abs(dy) >= 0.01) this._rotateCameraAroundEarth(camera.rightWC, -dy * spinSpeed);
      camera.constrainedAxis = undefined;
      this._forceLitGlobe();
      this._updateOverlays();
      this.viewer.scene.requestRender();
    };
    this._onPointerDown = (event) => {
      if (!isPlainPrimaryDrag(event)) return;
      pause();
      freeSpin = { pointerId: eventKey(event), ...getCanvasPoint(event) };
      canvas.setPointerCapture?.(event.pointerId);
      window.__freeSpinStarted = (window.__freeSpinStarted || 0) + 1;
    };
    this._onPointerMove = (event) => {
      if (!freeSpin || freeSpin.pointerId !== eventKey(event)) return;
      const p = getCanvasPoint(event);
      const dx = p.x - freeSpin.x;
      const dy = p.y - freeSpin.y;
      freeSpin = { pointerId: eventKey(event), ...p };
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      window.__freeSpinMoves = (window.__freeSpinMoves || 0) + 1;
      this._applyFreeSpinDelta(dx, dy);
    };
    this._onPointerUp = (event) => {
      if (freeSpin && (!event || freeSpin.pointerId === eventKey(event))) freeSpin = null;
      scheduleResume();
    };
    this._onMouseDown = (event) => {
      if (!isPlainPrimaryDrag(event)) return;
      pause();
      freeSpin = { pointerId: 'mouse', ...getCanvasPoint(event) };
      window.__freeSpinStarted = (window.__freeSpinStarted || 0) + 1;
    };
    this._onMouseMove = (event) => {
      if (!freeSpin || freeSpin.pointerId !== 'mouse') return;
      const p = getCanvasPoint(event);
      const dx = p.x - freeSpin.x;
      const dy = p.y - freeSpin.y;
      freeSpin = { pointerId: 'mouse', ...p };
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      window.__freeSpinMoves = (window.__freeSpinMoves || 0) + 1;
      this._applyFreeSpinDelta(dx, dy);
    };
    this._onMouseUp = () => { if (freeSpin?.pointerId === 'mouse') freeSpin = null; scheduleResume(); };
    this._onWheel = () => {
      pause();
      this.viewer.camera.constrainedAxis = undefined;
      this._updateOverlays();
      this.viewer.scene.requestRender();
      scheduleResume();
    };
    canvas.addEventListener('pointerdown', this._onPointerDown, true);
    canvas.addEventListener('pointermove', this._onPointerMove, true);
    window.addEventListener('pointerup', this._onPointerUp, true);
    canvas.addEventListener('mousedown', this._onMouseDown, true);
    window.addEventListener('mousemove', this._onMouseMove, true);
    window.addEventListener('mouseup', this._onMouseUp, true);
    canvas.addEventListener('wheel', this._onWheel, { passive: true });

    const tick = () => {
      if (this._destroyed) return;
      const carto = this.viewer.camera.positionCartographic;
      const height = carto?.height || HOME_HEIGHT;
      const shouldSpin = this._autoRotateEnabled && !this._userInteracting
        && !document.hidden && height >= AUTOROTATE_MIN_HEIGHT;
      if (shouldSpin) {
        // 绕地球自转轴 (世界 Z 轴) 缓慢旋转相机, 视觉上即地球自西向东自转
        this.viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -AUTOROTATE_SPEED);
        this._updateOverlays();
        this.viewer.scene.requestRender();
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }

  _forceLitGlobe() {
    const scene = this.viewer?.scene;
    const globe = scene?.globe;
    if (!globe) return;
    this.viewer.camera.constrainedAxis = undefined;
    globe.baseColor = Cesium.Color.fromCssColorString('#1b4f7c');
    globe.enableLighting = false;
    globe.dynamicAtmosphereLighting = false;
    globe.dynamicAtmosphereLightingFromSun = false;
    if (this._baseLayer) Object.assign(this._baseLayer, { brightness: 1.48, contrast: 1.03, saturation: 1.16, gamma: 0.70 });
    if (this._satLayer) Object.assign(this._satLayer, { brightness: 1.42, contrast: 1.03, saturation: 1.14, gamma: 0.72 });
  }

  _onCameraChanged() {
    if (this._destroyed) return;
    const carto = this.viewer.camera.positionCartographic;
    const height = carto?.height || HOME_HEIGHT;
    // 防止运行时/旧热补丁把地表重新拉进真实昼夜光照，导致旋转到任意角度仍一片黑。
    this._forceLitGlobe();

    // 云层按高度淡入淡出
    if (this._cloudLayer) {
      const cloudT = smoothstep(CLOUD_FADE_NEAR, CLOUD_FADE_FAR, height);
      const a = CLOUD_MAX_ALPHA * cloudT;
      this._cloudLayer.show = a > 0.02;
      this._cloudLayer.alpha = a;
    }

    // VPS 节点只保留点位，不显示浮空名称标签；避免与访客信标混淆。
    for (const entity of this._nodeEntities) {
      if (entity?.label) entity.label.show = false;
    }
    const latAbs = carto ? Math.abs(Cesium.Math.toDegrees(carto.latitude)) : 0;
    window.__globeView = {
      height: Math.round(height),
      latAbs: Math.round(latAbs),
      cloudAlpha: this._cloudLayer ? +this._cloudLayer.alpha.toFixed(2) : null,
      spinning: this._autoRotateEnabled && !this._userInteracting && height >= AUTOROTATE_MIN_HEIGHT,
    };
  }

  _updateOverlays() {
    if (this._destroyed || !this.viewer) return;
    const height = this.viewer.camera.positionCartographic?.height || HOME_HEIGHT;
    const cityMode = height < 400_000;
    window.__overlaySyncTick = (window.__overlaySyncTick || 0) + 1;
    try { updatePlaceLabels(this, height); } catch (_) {}
    try { updateHtmlNodeLabels(this, cityMode); } catch (_) {}
  }

  _onClick(movement) {
    const picks = this.viewer.scene.drillPick(movement.position) || [];
    for (const picked of picks) {
      const props = picked?.id?.properties;
      const serverId = props?.serverId?.getValue ? props.serverId.getValue() : props?.serverId;
      if (serverId == null) continue;
      const serverData = props?.serverData?.getValue ? props.serverData.getValue() : props?.serverData;
      if (serverData && typeof this.onNodeClick === 'function') {
        this.onNodeClick(serverData);
        return;
      }
    }
  }

  // ── 公共 API (main.js 契约) ──────────────────────────────
  updateServers(servers) {
    this.servers = servers || [];
    this._buildEntities();
    installVisitorBeacon(this);
    this._onCameraChanged();
  }

  setServers(servers) { this.updateServers(servers); }

  flyToServer(server) {
    this._userInteracting = true;
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    const [lat, lon] = getServerCoords(server);
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, 600_000),
      duration: 1.6,
    });
  }

  flyToCity(lon, lat, height = 600_000) {
    this._userInteracting = true;
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.6,
    });
  }

  resetView() {
    this._userInteracting = true;
    if (this._resumeTimer) clearTimeout(this._resumeTimer);
    this._resumeTimer = setTimeout(() => { this._userInteracting = false; }, AUTOROTATE_RESUME_MS);
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(DEFAULT_TARGET.lon, DEFAULT_TARGET.lat, HOME_HEIGHT),
      duration: 1.4,
    });
  }

  resize() { if (this.viewer) this.viewer.resize(); }

  destroy() {
    this._destroyed = true;
    if (this._raf) { try { cancelAnimationFrame(this._raf); } catch (_) {} this._raf = null; }
    if (this._resumeTimer) { try { clearTimeout(this._resumeTimer); } catch (_) {} this._resumeTimer = null; }
    try {
      const canvas = this.viewer?.scene?.canvas;
      if (canvas && this._onPointerDown) canvas.removeEventListener('pointerdown', this._onPointerDown, true);
      if (canvas && this._onPointerMove) canvas.removeEventListener('pointermove', this._onPointerMove, true);
      if (canvas && this._onMouseDown) canvas.removeEventListener('mousedown', this._onMouseDown, true);
      if (canvas && this._onWheel) canvas.removeEventListener('wheel', this._onWheel);
      if (this._onPointerUp) window.removeEventListener('pointerup', this._onPointerUp, true);
      if (this._onMouseMove) window.removeEventListener('mousemove', this._onMouseMove, true);
      if (this._onMouseUp) window.removeEventListener('mouseup', this._onMouseUp, true);
    } catch (_) {}
    try { this._removeCameraListener?.(); } catch (_) {}
    try { this._removePostRender?.(); } catch (_) {}
    try { this._handler?.destroy(); } catch (_) {}
    try { this._nasaParallaxBackground?.destroy(); } catch (_) {}
    this._nasaParallaxBackground = null;
    try { this._starEffectsLayer?.destroy(); } catch (_) {}
    this._starEffectsLayer = null;
    this._htmlLabels?.forEach((el) => el.remove());
    this._htmlLabels = new Map();
    if (this.viewer) { try { this.viewer.destroy(); } catch (_) {} this.viewer = null; }
    if (this.container) this.container.innerHTML = '';
  }
}
