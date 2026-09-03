import '../globals/dashboardGlobals.js';
import { getDashboardDebug, getGlobeRuntimeDebug } from '../utils/debugState.js';
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
import { getServerCoords } from './globe-utils.js';
import { applyCesiumTheme } from './globe/runtime/sceneSetup.js';
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

// Google Earth 手感: 自定义自由旋转的松手惯性 / 近中远移动幅度
const GE_MAX_MOVEMENT_RATIO = 0.08;      // 单帧最大输入比例，防止远景甩飞
const GE_SPIN_INERTIA = 0.86;            // 松手旋转惯性：保留重量感，但避免地图层面滑跳
const GE_SPIN_STOP_EPS = 0.035;          // 惯性速度低于该值时停止
const GE_MAP_SPIN_SPEED   = 0.000012;    // <500m：极慢，街景级
const GE_NEAR_SPIN_SPEED  = 0.000028;    // 500m–50km：地图级，Google Maps 近景手感
const GE_MID_SPIN_SPEED   = 0.000065;    // 50km–500km：区级
const GE_MID2_SPIN_SPEED  = 0.00012;     // 500km–3000km：省级
const GE_HIGH_SPIN_SPEED  = 0.00035;     // 3000km–8000km：国家级
const GE_FAR_SPIN_SPEED   = 0.0028;      // 8000km+：太空级，整颗地球快扫
const GE_MAP_MAX_STEP   = 3;
const GE_NEAR_MAX_STEP  = 6;
const GE_MID_MAX_STEP   = 10;
const GE_MID2_MAX_STEP  = 14;
const GE_HIGH_MAX_STEP  = 22;
const GE_FAR_MAX_STEP   = 68;

// 节点标签可见的高度阈值
const NODE_LABEL_HEIGHT = 3_500_000;
const MOBILE_GLOBE_MEDIA = '(max-width: 640px)';
const MOBILE_IMAGERY_TONE = { brightness: 0.96, contrast: 1.08, saturation: 1.04, gamma: 1.0 };
const DESKTOP_BASE_IMAGERY_TONE = { brightness: 1.48, contrast: 1.03, saturation: 1.16, gamma: 0.70 };
const DESKTOP_SAT_IMAGERY_TONE = { brightness: 1.42, contrast: 1.03, saturation: 1.14, gamma: 0.72 };
// Shared Cesium WebGL starship: camera-relative composition (no second Three.js renderer).
const STARSHIP_MODEL_URL = '/globe/xinjian1.glb';
// Place the ship a few percent of camera height ahead so it stays in the near field of the home view.
const STARSHIP_FORWARD_MIN_M = 1800;
const STARSHIP_FORWARD_MAX_M = 120000;
const STARSHIP_FORWARD_HEIGHT_RATIO = 0.0048;
const STARSHIP_RIGHT_RATIO = 0.52;
const STARSHIP_UP_RATIO = 0.04;
const STARSHIP_TARGET_RADIUS_RATIO = 0.20; // world-radius / forward distance

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function smoothstep(edge0, edge1, x) {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function isMobileGlobe() {
  return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_GLOBE_MEDIA).matches;
}

export class CesiumGlobe {
  constructor(containerSelector, servers, options = {}) {
    this.container = document.querySelector(containerSelector);
    if (!this.container) throw new Error(`Container not found: ${containerSelector}`);
    this.servers = servers || [];
    this.onNodeClick = options.onNodeClick || null;
    this.onBlankClick = options.onBlankClick || null;
    this.enableStarship = options.enableStarship === true;
    this.starshipModelUrl = options.starshipModelUrl || STARSHIP_MODEL_URL;
    this._destroyed = false;
    this._initStarted = false;
    this._layoutWaitTimer = null;
    this._layoutObserver = null;
    this._clusterFanoutExpansionId = 0;
    this._hiddenClusterFanoutVisuals = null;
    this._starshipModel = null;
    this._starshipReady = false;
    this._starshipLoadToken = 0;
    this._starshipNativeRadius = null;
    this._starshipScratch = {
      position: new Cesium.Cartesian3(),
      right: new Cesium.Cartesian3(),
      up: new Cesium.Cartesian3(),
      direction: new Cesium.Cartesian3(),
      forward: new Cesium.Cartesian3(),
      tmp: new Cesium.Cartesian3(),
      rot: new Cesium.Matrix3(),
      scale: new Cesium.Matrix4(),
      modelMatrix: new Cesium.Matrix4(),
    };

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
    this._freeSpinVelocity = { x: 0, y: 0 };
    this._freeSpinMomentumActive = false;
    this._clickSuppressUntil = 0;
    this._dragMovedPx = 0;

    // Defer Viewer creation until the host has a real non-zero layout.
    // Creating Cesium.Viewer in a 0×0 box throws:
    //   DeveloperError: Expected width to be greater than 0, actual value was 0
    // and permanently stops rendering.
    try {
      this._scheduleInitWhenReady();
    } catch (e) {
      window.__DBG__.globeError = e;
      throw e;
    }
  }

  _hostSize() {
    const host = this._cesiumDiv || this.container;
    const rect = host?.getBoundingClientRect?.();
    const w = Math.max(
      0,
      Math.floor(host?.clientWidth || rect?.width || 0),
    );
    const h = Math.max(
      0,
      Math.floor(host?.clientHeight || rect?.height || 0),
    );
    return { w, h };
  }

  _hasRenderableSize(min = 2) {
    const { w, h } = this._hostSize();
    return w >= min && h >= min;
  }

  _scheduleInitWhenReady(attempt = 0) {
    if (this._destroyed || this._initStarted) return;
    if (this._layoutWaitTimer) {
      clearTimeout(this._layoutWaitTimer);
      this._layoutWaitTimer = null;
    }

    const tryStart = () => {
      if (this._destroyed || this._initStarted) return;
      // Force a layout pass: empty absolute hosts sometimes report 0 until painted.
      try {
        this.container.style.minWidth = this.container.style.minWidth || '1px';
        this.container.style.minHeight = this.container.style.minHeight || '1px';
      } catch (_) {}

      if (this._hasRenderableSize(2) || attempt >= 60) {
        this._initStarted = true;
        try {
          this._init();
        } catch (e) {
          window.__DBG__.globeError = e;
          console.error('[CesiumGlobe] init failed', e);
          // One more delayed retry if the first paint size was still wrong.
          if (attempt < 70 && /width|greater than 0/i.test(String(e?.message || e))) {
            this._initStarted = false;
            this._layoutWaitTimer = setTimeout(() => this._scheduleInitWhenReady(attempt + 1), 120);
            return;
          }
          throw e;
        }
        return;
      }

      this._layoutWaitTimer = setTimeout(() => this._scheduleInitWhenReady(attempt + 1), attempt < 10 ? 32 : 80);
    };

    if (typeof ResizeObserver !== 'undefined' && !this._layoutObserver) {
      try {
        this._layoutObserver = new ResizeObserver(() => {
          if (!this._initStarted) tryStart();
          else this.resize();
        });
        this._layoutObserver.observe(this.container);
      } catch (_) {}
    }

    // Always also poll: ResizeObserver can miss first paint on some mobile browsers.
    tryStart();
  }

  _safeRequestRender() {
    if (this._destroyed || !this.viewer?.scene) return;
    if (!this._hasRenderableSize(1)) return;
    try {
      const canvas = this.viewer.scene.canvas;
      const w = canvas?.clientWidth || canvas?.width || 0;
      const h = canvas?.clientHeight || canvas?.height || 0;
      if (w < 1 || h < 1) return;
      this.viewer.scene.requestRender();
    } catch (error) {
      console.warn('[CesiumGlobe] requestRender skipped', error);
    }
  }

  _init() {
    this.container.replaceChildren();
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
    // Optional PIXI star sparkles; fail-soft if host is 0×0 or WebGL is busy.
    try {
      this._starEffectsLayer = new StarEffectsLayer(this.container, { seed: 2406 });
    } catch (error) {
      console.warn('[CesiumGlobe] StarEffectsLayer skipped', error);
      this._starEffectsLayer = null;
    }

    this._cesiumDiv = document.createElement('div');
    this._cesiumDiv.id = 'cesium-globe-container';
    this._cesiumDiv.style.cssText = 'width:100%;height:100%;min-width:1px;min-height:1px;position:absolute;inset:0;';
    this.container.appendChild(this._cesiumDiv);

    // Guarantee non-zero host before Cesium measures the canvas.
    const size = this._hostSize();
    if (size.w < 2 || size.h < 2) {
      const fallbackW = Math.max(2, window.innerWidth || 320);
      const fallbackH = Math.max(2, window.innerHeight || 240);
      this._cesiumDiv.style.width = `${fallbackW}px`;
      this._cesiumDiv.style.height = `${fallbackH}px`;
    }

    // HTML 标签层
    this._labelLayer = document.createElement('div');
    this._labelLayer.className = 'google-earth-node-label-layer';
    this.container.appendChild(this._labelLayer);
    this._clusterFanoutLayer = document.createElement('div');
    this._clusterFanoutLayer.className = 'cluster-screen-fanout';
    this._clusterFanoutLayer.setAttribute('aria-hidden', 'true');
    this.container.appendChild(this._clusterFanoutLayer);
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

    // Hide Cesium's fatal red panel and keep the loop alive on zero-size frames.
    try {
      if (this.viewer.cesiumWidget) {
        // Replace showErrorPanel with a no-op so the red "Rendering has stopped"
        // overlay never appears for recoverable zero-size frames.
        this.viewer.cesiumWidget.showErrorPanel = function showErrorPanelNoop() {};
      }
    } catch (_) {}
    try {
      this.viewer.scene.rethrowRenderErrors = false;
    } catch (_) {}

    // Force a non-zero drawing buffer immediately after Viewer construction.
    try {
      const canvas = this.viewer.scene?.canvas;
      const size = this._hostSize();
      const w = Math.max(1, size.w || window.innerWidth || 1);
      const h = Math.max(1, size.h || window.innerHeight || 1);
      if (canvas) {
        if (!canvas.width) canvas.width = w;
        if (!canvas.height) canvas.height = h;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
      }
    } catch (_) {}

    // Guard CesiumWidget.resize — this is the usual source of:
    // DeveloperError: Expected width to be greater than 0
    // Cesium's default render loop calls resize every frame; a 0×0 host stops rendering forever.
    try {
      const widget = this.viewer.cesiumWidget;
      if (widget && typeof widget.resize === 'function') {
        const originalWidgetResize = widget.resize.bind(widget);
        widget.resize = () => {
          if (this._destroyed) return;
          const host = this._cesiumDiv || this.container;
          const canvas = widget.canvas || this.viewer?.scene?.canvas;
          const w = Math.max(
            host?.clientWidth || 0,
            canvas?.clientWidth || 0,
            canvas?.width || 0,
            this.container?.clientWidth || 0,
          );
          const h = Math.max(
            host?.clientHeight || 0,
            canvas?.clientHeight || 0,
            canvas?.height || 0,
            this.container?.clientHeight || 0,
          );
          if (w < 1 || h < 1) return;
          try {
            return originalWidgetResize();
          } catch (error) {
            const msg = String(error?.message || error || '');
            if (/width to be greater than 0|height to be greater than 0/i.test(msg)) {
              console.warn('[CesiumGlobe] widget.resize skipped (zero size)', error);
              return;
            }
            throw error;
          }
        };
      }
    } catch (_) {}

    // Guard Viewer.resize similarly.
    try {
      if (typeof this.viewer.resize === 'function') {
        const originalViewerResize = this.viewer.resize.bind(this.viewer);
        this.viewer.resize = () => {
          if (this._destroyed) return;
          if (!this._hasRenderableSize(1)) return;
          try {
            return originalViewerResize();
          } catch (error) {
            const msg = String(error?.message || error || '');
            if (/width to be greater than 0|height to be greater than 0/i.test(msg)) {
              console.warn('[CesiumGlobe] viewer.resize skipped (zero size)', error);
              return;
            }
            throw error;
          }
        };
      }
    } catch (_) {}

    // Guard Cesium's own render path: if layout collapses to 0, skip the frame
    // instead of letting DeveloperError permanently stop the render loop.
    try {
      const scene = this.viewer.scene;
      const originalRender = scene.render.bind(scene);
      scene.render = (...args) => {
        if (this._destroyed) return;
        const canvas = scene.canvas;
        const w = canvas?.clientWidth || canvas?.width || this._cesiumDiv?.clientWidth || 0;
        const h = canvas?.clientHeight || canvas?.height || this._cesiumDiv?.clientHeight || 0;
        if (w < 1 || h < 1) return;
        try {
          return originalRender(...args);
        } catch (error) {
          const msg = String(error?.message || error || '');
          if (/width to be greater than 0|height to be greater than 0/i.test(msg)) {
            console.warn('[CesiumGlobe] render skipped (zero size)', error);
            // Ensure the default loop is not left permanently disabled.
            try { this.viewer.useDefaultRenderLoop = true; } catch (_) {}
            return;
          }
          throw error;
        }
      };
    } catch (_) {}

    // If Cesium still raises renderError, swallow zero-size and resume the loop.
    try {
      this._removeRenderError = this.viewer.scene.renderError.addEventListener((scene, error) => {
        const msg = String(error?.message || error || '');
        window.__DBG__.lastCesiumRenderError = msg;
        if (/width to be greater than 0|height to be greater than 0/i.test(msg)) {
          console.warn('[CesiumGlobe] renderError swallowed (zero size)', error);
          try { this.viewer.useDefaultRenderLoop = true; } catch (_) {}
          try { this.viewer.cesiumWidget?.showErrorPanel?.(false); } catch (_) {}
          // Hide any residual error panel DOM Cesium may have inserted.
          try {
            this._cesiumDiv?.querySelectorAll?.('.cesium-widget-errorPanel')?.forEach((el) => el.remove());
          } catch (_) {}
          // Retry after layout recovers.
          setTimeout(() => {
            if (this._destroyed) return;
            this.resize();
            this._safeRequestRender();
          }, 120);
          return;
        }
        console.error('[CesiumGlobe] renderError', error);
      });
    } catch (_) {}

    this._setupScene();
    this._onThemeChanged = (event) => applyCesiumTheme(this.viewer, event?.detail?.theme);
    window.addEventListener('vps-theme-changed', this._onThemeChanged);
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
    this._removePostRender = this.viewer.scene.postRender.addEventListener(() => {
      if (!this._hasRenderableSize(1)) return;
      this._updateStarshipModelMatrix();
      this._updateOverlays();
    });

    try {
      this._buildEntities();
    } catch (error) {
      // Never let a bad VPS row (invalid coords / NAT placeholder) blank the whole homepage.
      window.__DBG__.globeError = error;
      console.error('[CesiumGlobe] rebuild entities failed', error);
    }
    installVisitorBeacon(this);
    this._onCameraChanged();
    this._installAutoRotate();
    if (this.enableStarship) this._installStarshipModel();

    // Force one safe resize after layout settles.
    requestAnimationFrame(() => {
      this.resize();
      this._safeRequestRender();
    });

    window.__DBG__.globe = this;
    window.__DBG__.CESIUM_GLOBE = this;
    getGlobeRuntimeDebug().globeMode = 'Native CesiumJS rebuild v2 (real imagery + clouds + spin + shared-webgl starship)';
  }

  async _installStarshipModel() {
    if (!this.viewer || this._destroyed) return;
    const token = ++this._starshipLoadToken;
    try {
      const model = await Cesium.Model.fromGltfAsync({
        url: this.starshipModelUrl,
        show: true,
        asynchronous: true,
        allowPicking: false,
        cull: false,
        shadows: Cesium.ShadowMode.DISABLED,
        incrementallyLoadTextures: true,
      });
      if (this._destroyed || token !== this._starshipLoadToken) {
        try { model.destroy?.(); } catch (_) {}
        return;
      }
      this._starshipModel = this.viewer.scene.primitives.add(model);
      const playAnimations = () => {
        if (!this._starshipModel || this._destroyed) return;
        try {
          const animations = this._starshipModel.activeAnimations;
          if (animations) {
            try {
              animations.addAll({ loop: Cesium.ModelAnimationLoop.REPEAT });
            } catch (_) {
              try { animations.add({ index: 0, loop: Cesium.ModelAnimationLoop.REPEAT }); } catch (__) {}
            }
          }
        } catch (err) {
          getDashboardDebug('globe').starshipAnimationError = String(err?.message || err);
        }
        this._starshipReady = true;
        this._updateStarshipModelMatrix();
        this.viewer?.scene?.requestRender();
        window.__DBG__.SHARED_WEBGL_STARSHIP = {
          url: this.starshipModelUrl,
          ready: true,
          renderer: 'cesium-model',
        };
      };
      if (model.ready) playAnimations();
      else model.readyEvent.addEventListener(playAnimations);
      getDashboardDebug('globe').starshipMode = 'shared-cesium-webgl';
    } catch (error) {
      getDashboardDebug('globe').starshipError = String(error?.message || error);
      window.__DBG__.SHARED_WEBGL_STARSHIP_ERROR = String(error?.message || error);
      console.warn('[CesiumGlobe] shared-webgl starship load failed', error);
    }
  }

  _updateStarshipModelMatrix() {
    const model = this._starshipModel;
    const viewer = this.viewer;
    if (!model || !viewer || this._destroyed || !model.ready) return;
    const camera = viewer.camera;
    const height = camera.positionCartographic?.height || HOME_HEIGHT;
    const forwardDist = Cesium.Math.clamp(
      height * STARSHIP_FORWARD_HEIGHT_RATIO,
      STARSHIP_FORWARD_MIN_M,
      STARSHIP_FORWARD_MAX_M,
    );
    const s = this._starshipScratch;

    Cesium.Cartesian3.clone(camera.positionWC, s.position);
    Cesium.Cartesian3.clone(camera.rightWC, s.right);
    Cesium.Cartesian3.clone(camera.upWC, s.up);
    Cesium.Cartesian3.clone(camera.directionWC, s.direction);

    Cesium.Cartesian3.multiplyByScalar(s.direction, forwardDist, s.forward);
    Cesium.Cartesian3.add(s.position, s.forward, s.position);
    Cesium.Cartesian3.multiplyByScalar(s.right, forwardDist * STARSHIP_RIGHT_RATIO, s.tmp);
    Cesium.Cartesian3.add(s.position, s.tmp, s.position);
    Cesium.Cartesian3.multiplyByScalar(s.up, forwardDist * STARSHIP_UP_RATIO, s.tmp);
    Cesium.Cartesian3.add(s.position, s.tmp, s.position);

    // Orientation: model +X toward screen-left, +Y camera-up, +Z into the scene.
    Cesium.Cartesian3.negate(s.right, s.tmp);
    Cesium.Matrix3.fromColumnMajorArray([
      s.tmp.x, s.tmp.y, s.tmp.z,
      s.up.x, s.up.y, s.up.z,
      s.direction.x, s.direction.y, s.direction.z,
    ], s.rot);

    // Cache native model radius once. Cesium boundingSphere can become world-scaled after modelMatrix updates.
    if (!Number.isFinite(this._starshipNativeRadius) || this._starshipNativeRadius <= 0) {
      const rawRadius = model.boundingSphere?.radius;
      // Prefer a stable native radius by undoing current model.scale when available.
      const currentScale = Number(model.scale) > 0 ? Number(model.scale) : 1;
      this._starshipNativeRadius = Math.max((rawRadius || 1) / currentScale, 1e-3);
    }
    const modelRadius = this._starshipNativeRadius;
    const targetRadius = forwardDist * STARSHIP_TARGET_RADIUS_RATIO;
    const scale = Math.max(0.05, targetRadius / modelRadius);

    Cesium.Matrix4.fromRotationTranslation(s.rot, s.position, s.modelMatrix);
    model.modelMatrix = Cesium.Matrix4.clone(s.modelMatrix, model.modelMatrix || new Cesium.Matrix4());
    model.scale = scale;
    model.show = !isMobileGlobe();

    window.__DBG__.SHARED_WEBGL_STARSHIP = {
      ...(window.__DBG__.SHARED_WEBGL_STARSHIP || {}),
      ready: true,
      renderer: 'cesium-model',
      url: this.starshipModelUrl,
      forwardDist: Math.round(forwardDist),
      scale: Number(scale.toFixed(3)),
      modelRadius: Number(modelRadius.toFixed(3)),
      show: model.show,
    };
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
    // Theme state must enter Cesium itself; CSS/body backgrounds cannot recolor
    // the WebGL canvas. Apply after viewer construction and on every theme event.
    applyCesiumTheme(this.viewer);
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
    window.__DBG__.customSkyBoxSources = null;
    window.__DBG__.starProjectionBackground = '/globe/star-projection-bg.png';

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
    // Native Cesium zoom inertia + our custom free-spin momentum together approximate
    // Google Earth's weighted, floating feel while keeping the globe centered.
    c.inertiaSpin = 0.0;
    c.inertiaTranslate = 0.0;
    c.inertiaZoom = 0.15;
    c.maximumMovementRatio = GE_MAX_MOVEMENT_RATIO;
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
      Object.assign(base, { show: true, alpha: 1.0, ...(isMobileGlobe() ? MOBILE_IMAGERY_TONE : DESKTOP_BASE_IMAGERY_TONE) });
      this._baseLayer = base;
      this._safeRequestRender();

      // 主图层: ArcGIS World Imagery 真实卫星, 各缩放级别常驻 (Google Earth 观感)
      try {
        const satProvider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(ARCGIS_WORLD_IMAGERY_URL, {
          enablePickFeatures: false,
        });
        if (this._destroyed) return;
        const sat = layers.addImageryProvider(satProvider, 1);
        Object.assign(sat, { show: true, alpha: 1.0, ...(isMobileGlobe() ? MOBILE_IMAGERY_TONE : DESKTOP_SAT_IMAGERY_TONE) });
        this._satLayer = sat;
      } catch (e) {
        getDashboardDebug('globe').imageryError = String(e?.message || e);
      }

      // 云层: 半透明全球云图, 远景显示近景淡出
      try {
        const cloudProvider = await Cesium.SingleTileImageryProvider.fromUrl(CLOUDS_TEXTURE_URL, {
          rectangle: FULL_GLOBE_RECTANGLE,
        });
        if (this._destroyed) return;
        const clouds = layers.addImageryProvider(cloudProvider, 2);
        Object.assign(clouds, { show: true, alpha: CLOUD_MAX_ALPHA, brightness: 1.32, contrast: 1.08, gamma: 0.86 });
        this._cloudLayer = clouds;
      } catch (e) {
        getDashboardDebug('globe').imageryError = String(e?.message || e);
      }

      getDashboardDebug('globe').imageryMode = 'ArcGIS World Imagery + Blue Marble base + cloud overlay';
      this._onCameraChanged();
      this._safeRequestRender();
    } catch (e) {
      getDashboardDebug('globe').imageryError = String(e?.message || e);
    }
  }

  async _installWorldTerrain() {
    // Public homepage must not depend on Cesium Ion. Empty/expired Ion token makes
    // asset 1 return 401. Keep ellipsoid terrain: zoom/rotation/imagery tiles still work.
    this._terrainReady = false;
    getDashboardDebug('globe').terrainMode = 'EllipsoidTerrainProvider (Ion terrain disabled)';
    getDashboardDebug('globe').terrainError = '';
    try { this.viewer?.scene?.requestRender(); } catch (_) {}
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
    const mobileHomeHeight = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 640px)').matches) ? 10_800_000 : HOME_HEIGHT;
    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(target.lon, target.lat, mobileHomeHeight),
    });
  }

  _buildEntities() {
    rebuildVpsEntities(this);
    this._safeRequestRender();
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
    const supportsPointerEvents = typeof window !== 'undefined' && 'PointerEvent' in window;
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
    this._googleEarthDragProfile = () => {
      this._updateClusterFanoutOverlay();
    const height = this.viewer.camera.positionCartographic?.height || HOME_HEIGHT;
      const zoomT = clamp01((height - MIN_ZOOM) / Math.max(1, MAX_ZOOM - MIN_ZOOM));
      // Google-Maps-style 6-tier curve: each zoom band has its own drag sensitivity.
      //   <500m        → GE_MAP_SPIN_SPEED   (street-level, barely moves)
      //   500m–50km    → GE_NEAR_SPIN_SPEED  (map level)
      //   50km–500km   → GE_MID_SPIN_SPEED   (district level)
      //   500km–3000km → GE_MID2_SPIN_SPEED  (regional level)
      //   3000km–8000km→ GE_HIGH_SPIN_SPEED  (country level)
      //   8000km+      → GE_FAR_SPIN_SPEED   (space, whole-globe sweep)
      const t1   = smoothstep(500,       50_000,     height);
      const t2   = smoothstep(50_000,   500_000,    height);
      const t3   = smoothstep(500_000,  3_000_000,  height);
      const t4   = smoothstep(3_000_000,8_000_000,  height);
      const t5   = smoothstep(8_000_000,MAX_ZOOM,   height);
      const s1 = Cesium.Math.lerp(GE_MAP_SPIN_SPEED,  GE_NEAR_SPIN_SPEED, t1);
      const s2 = Cesium.Math.lerp(s1,                  GE_MID_SPIN_SPEED,   t2);
      const s3 = Cesium.Math.lerp(s2,                  GE_MID2_SPIN_SPEED,  t3);
      const s4 = Cesium.Math.lerp(s3,                  GE_HIGH_SPIN_SPEED,  t4);
      const spinSpeed = Cesium.Math.lerp(s4,            GE_FAR_SPIN_SPEED,   t5);
      const m1 = Cesium.Math.lerp(GE_MAP_MAX_STEP,  GE_NEAR_MAX_STEP, t1);
      const m2 = Cesium.Math.lerp(m1,               GE_MID_MAX_STEP,  t2);
      const m3 = Cesium.Math.lerp(m2,               GE_MID2_MAX_STEP, t3);
      const m4 = Cesium.Math.lerp(m3,               GE_HIGH_MAX_STEP, t4);
      const maxStep = Cesium.Math.lerp(m4,           GE_FAR_MAX_STEP,  t5);
      const dragScale = spinSpeed / GE_MAP_SPIN_SPEED;
      return { height, zoomT, midT: t2, farT: t5, dragScale, maxStep, spinSpeed };
    };
    this._applyFreeSpinDelta = (dx, dy, fromMomentum = false) => {
      if (Math.abs(dx) + Math.abs(dy) < 0.015) return;
      // Quaternion free-spin around Earth center. This avoids Cesium rotateUp polar clamps,
      // so vertical dragging can cross both poles and continue through a full 360°.
      const camera = this.viewer.camera;
      const profile = this._googleEarthDragProfile();
      const stepX = Math.max(-profile.maxStep, Math.min(profile.maxStep, dx));
      const stepY = Math.max(-profile.maxStep, Math.min(profile.maxStep, dy));
      getDashboardDebug().freeSpinLast = {
        dx: +dx.toFixed(2), dy: +dy.toFixed(2), stepX: +stepX.toFixed(2), stepY: +stepY.toFixed(2),
        height: Math.round(profile.height), zoomT: +profile.zoomT.toFixed(3), dragScale: +profile.dragScale.toFixed(3),
        maxStep: +profile.maxStep.toFixed(2), spinSpeed: +profile.spinSpeed.toFixed(6), momentum: !!fromMomentum,
        inertia: GE_SPIN_INERTIA, maxMovementRatio: GE_MAX_MOVEMENT_RATIO,
      };
      if (Math.abs(stepX) >= 0.01) this._rotateCameraAroundEarth(Cesium.Cartesian3.UNIT_Z, -stepX * profile.spinSpeed);
      if (Math.abs(stepY) >= 0.01) this._rotateCameraAroundEarth(camera.rightWC, -stepY * profile.spinSpeed);
      camera.constrainedAxis = undefined;
      this._forceLitGlobe();
      this._updateOverlays();
      this._safeRequestRender();
    };
    this._onPointerDown = (event) => {
      if (!isPlainPrimaryDrag(event)) return;
      pause();
      this._freeSpinMomentumActive = false;
      this._freeSpinVelocity = { x: 0, y: 0 };
      const startPoint = getCanvasPoint(event);
      this._dragMovedPx = 0;
      freeSpin = { pointerId: eventKey(event), startX: startPoint.x, startY: startPoint.y, ...startPoint };
      canvas.setPointerCapture?.(event.pointerId);
      getDashboardDebug().freeSpinStarted = (getDashboardDebug().freeSpinStarted || 0) + 1;
    };
    this._onPointerMove = (event) => {
      if (!freeSpin || freeSpin.pointerId !== eventKey(event)) return;
      const p = getCanvasPoint(event);
      const dx = p.x - freeSpin.x;
      const dy = p.y - freeSpin.y;
      this._dragMovedPx = Math.max(this._dragMovedPx || 0, Math.hypot(p.x - (freeSpin.startX ?? p.x), p.y - (freeSpin.startY ?? p.y)));
      freeSpin = { pointerId: eventKey(event), startX: freeSpin.startX, startY: freeSpin.startY, ...p };
      this._freeSpinVelocity = { x: dx * 0.82 + this._freeSpinVelocity.x * 0.18, y: dy * 0.82 + this._freeSpinVelocity.y * 0.18 };
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      getDashboardDebug().freeSpinMoves = (getDashboardDebug().freeSpinMoves || 0) + 1;
      this._applyFreeSpinDelta(dx, dy);
    };
    const startMomentum = () => {
      const v = this._freeSpinVelocity || { x: 0, y: 0 };
      const height = this.viewer.camera.positionCartographic?.height || HOME_HEIGHT;
      const allowMomentum = height >= AUTOROTATE_MIN_HEIGHT;
      this._freeSpinMomentumActive = allowMomentum && Math.abs(v.x) + Math.abs(v.y) > GE_SPIN_STOP_EPS;
      if (!this._freeSpinMomentumActive) this._freeSpinVelocity = { x: 0, y: 0 };
      getDashboardDebug().freeSpinMomentumStart = {
        x: +v.x.toFixed(2), y: +v.y.toFixed(2), height: Math.round(height),
        allowMomentum, active: this._freeSpinMomentumActive,
      };
    };
    this._onPointerUp = (event) => {
      if (freeSpin && (!event || freeSpin.pointerId === eventKey(event))) {
        if ((this._dragMovedPx || 0) > 6) this._clickSuppressUntil = Date.now() + 450;
        freeSpin = null;
        startMomentum();
      }
      scheduleResume();
    };
    this._onMouseDown = (event) => {
      if (supportsPointerEvents) return;
      if (!isPlainPrimaryDrag(event)) return;
      pause();
      this._freeSpinMomentumActive = false;
      this._freeSpinVelocity = { x: 0, y: 0 };
      const startPoint = getCanvasPoint(event);
      this._dragMovedPx = 0;
      freeSpin = { pointerId: 'mouse', startX: startPoint.x, startY: startPoint.y, ...startPoint };
      getDashboardDebug().freeSpinStarted = (getDashboardDebug().freeSpinStarted || 0) + 1;
    };
    this._onMouseMove = (event) => {
      if (supportsPointerEvents) return;
      if (!freeSpin || freeSpin.pointerId !== 'mouse') return;
      const p = getCanvasPoint(event);
      const dx = p.x - freeSpin.x;
      const dy = p.y - freeSpin.y;
      this._dragMovedPx = Math.max(this._dragMovedPx || 0, Math.hypot(p.x - (freeSpin.startX ?? p.x), p.y - (freeSpin.startY ?? p.y)));
      freeSpin = { pointerId: 'mouse', startX: freeSpin.startX, startY: freeSpin.startY, ...p };
      this._freeSpinVelocity = { x: dx * 0.82 + this._freeSpinVelocity.x * 0.18, y: dy * 0.82 + this._freeSpinVelocity.y * 0.18 };
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      getDashboardDebug().freeSpinMoves = (getDashboardDebug().freeSpinMoves || 0) + 1;
      this._applyFreeSpinDelta(dx, dy);
    };
    this._onMouseUp = () => { if (supportsPointerEvents) return; if (freeSpin?.pointerId === 'mouse') { if ((this._dragMovedPx || 0) > 6) this._clickSuppressUntil = Date.now() + 450; freeSpin = null; startMomentum(); } scheduleResume(); };
    this._onWheel = () => {
      pause();
      this._freeSpinMomentumActive = false;
      this._freeSpinVelocity = { x: 0, y: 0 };
      this.viewer.camera.constrainedAxis = undefined;
      this._updateOverlays();
      this._safeRequestRender();
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
      if (this._freeSpinMomentumActive && !document.hidden) {
        this._applyFreeSpinDelta(this._freeSpinVelocity.x, this._freeSpinVelocity.y, true);
        this._freeSpinVelocity.x *= GE_SPIN_INERTIA;
        this._freeSpinVelocity.y *= GE_SPIN_INERTIA;
        if (Math.abs(this._freeSpinVelocity.x) + Math.abs(this._freeSpinVelocity.y) < GE_SPIN_STOP_EPS) {
          this._freeSpinMomentumActive = false;
          this._freeSpinVelocity = { x: 0, y: 0 };
        }
      }
      const shouldSpin = this._autoRotateEnabled && !this._userInteracting && !this._freeSpinMomentumActive
        && !document.hidden && height >= AUTOROTATE_MIN_HEIGHT;
      if (shouldSpin) {
        // 绕地球自转轴 (世界 Z 轴) 缓慢旋转相机, 视觉上即地球自西向东自转
        this.viewer.camera.rotate(Cesium.Cartesian3.UNIT_Z, -AUTOROTATE_SPEED);
        this._updateOverlays();
        this._safeRequestRender();
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
    const mobile = isMobileGlobe();
    if (this._baseLayer) Object.assign(this._baseLayer, mobile ? MOBILE_IMAGERY_TONE : DESKTOP_BASE_IMAGERY_TONE);
    if (this._satLayer) Object.assign(this._satLayer, mobile ? MOBILE_IMAGERY_TONE : DESKTOP_SAT_IMAGERY_TONE);
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
    getGlobeRuntimeDebug().globeView = {
      height: Math.round(height),
      latAbs: Math.round(latAbs),
      cloudAlpha: this._cloudLayer ? +this._cloudLayer.alpha.toFixed(2) : null,
      spinning: this._autoRotateEnabled && !this._userInteracting && !this._freeSpinMomentumActive && height >= AUTOROTATE_MIN_HEIGHT,
      freeSpinMomentum: !!this._freeSpinMomentumActive,
      googleEarthFeel: this._googleEarthDragProfile ? this._googleEarthDragProfile() : null,
    };
  }

  _updateOverlays() {
    if (this._destroyed || !this.viewer) return;
    this._updateClusterFanoutOverlay();
    const height = this.viewer.camera.positionCartographic?.height || HOME_HEIGHT;
    const cityMode = height < 400_000;
    getDashboardDebug().overlaySyncTick = (getDashboardDebug().overlaySyncTick || 0) + 1;
    try { updatePlaceLabels(this, height); } catch (_) {}
    try { updateHtmlNodeLabels(this, cityMode); } catch (_) {}
  }

  _updateClusterFanoutOverlay() {
    const overlay = this._clusterFanoutOverlay;
    if (!overlay || !this._clusterFanoutLayer) return;
    const { scene, camera } = this.viewer;
    const surfaceNormal = Cesium.Ellipsoid.WGS84.geodeticSurfaceNormal(overlay.anchor, new Cesium.Cartesian3());
    const cameraNormal = Cesium.Cartesian3.normalize(camera.positionWC, new Cesium.Cartesian3());
    const frontFacing = Cesium.Cartesian3.dot(surfaceNormal, cameraNormal) >= -0.35;
    const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(scene, overlay.anchor);
    const width = scene.canvas.clientWidth || scene.canvas.width;
    const height = scene.canvas.clientHeight || scene.canvas.height;
    const visible = frontFacing && Number.isFinite(windowPosition?.x) && Number.isFinite(windowPosition?.y)
      && windowPosition.x >= -40 && windowPosition.x <= width + 40 && windowPosition.y >= -40 && windowPosition.y <= height + 40;
    this._clusterFanoutLayer.hidden = !visible;
    if (!visible) return;
    this._clusterFanoutLayer.style.setProperty('--cluster-anchor-x', `${windowPosition.x}px`);
    this._clusterFanoutLayer.style.setProperty('--cluster-anchor-y', `${windowPosition.y}px`);
  }

  _onClick(movement) {
    if (Date.now() < (this._clickSuppressUntil || 0)) {
      getDashboardDebug().nodeClickSuppressed = { at: Date.now(), dragMovedPx: +(this._dragMovedPx || 0).toFixed(1) };
      return;
    }
    const picks = this.viewer.scene.drillPick(movement.position) || [];
    for (const picked of picks) {
      const props = picked?.id?.properties;
      const serverId = props?.serverId?.getValue ? props.serverId.getValue() : props?.serverId;
      if (serverId == null) continue;
      const serverData = props?.serverData?.getValue ? props.serverData.getValue() : props?.serverData;
      const clusterMembers = props?.clusterMembers?.getValue ? props.clusterMembers.getValue() : props?.clusterMembers;
      const clusterCentroid = props?.clusterCentroid?.getValue ? props.clusterCentroid.getValue() : props?.clusterCentroid;
      const vpsClusterClick = props?.vpsClusterClick?.getValue ? props.vpsClusterClick.getValue() : props?.vpsClusterClick;
      if (vpsClusterClick && typeof this.onNodeClick === 'function') {
        this.onNodeClick(serverData, clusterMembers, clusterCentroid);
        return;
      }
      if (serverData && typeof this.onNodeClick === 'function') {
        this.onNodeClick(serverData, clusterMembers, null);
        return;
      }
    }
    this.onBlankClick?.();
  }

  _hideCollapsedClusterForFanout(clusterKey, fanout) {
    this._restoreCollapsedClusterAfterFanout();
    const memberIds = new Set((fanout || []).flatMap((item) => item.group?.members || []).map((member) => String(member?.id)).filter(Boolean));
    const matchesCluster = (entity) => {
      const properties = entity?.properties;
      const entityClusterKey = properties?.clusterKey?.getValue ? properties.clusterKey.getValue() : properties?.clusterKey;
      const clusterMembers = properties?.clusterMembers?.getValue ? properties.clusterMembers.getValue() : properties?.clusterMembers;
      return (clusterKey && entityClusterKey === clusterKey)
        || (!clusterKey && Array.isArray(clusterMembers) && clusterMembers.length > 1
          && clusterMembers.every((member) => memberIds.has(String(member?.id))));
    };
    const entities = (this._arcEntities || []).filter(matchesCluster).map((entity) => ({ entity, previousShow: entity.show }));
    const labels = [...(this._htmlLabels?.values() || [])]
      .filter((label) => (clusterKey && label.dataset.clusterKey === clusterKey)
        || (!clusterKey && memberIds.has(String(label.dataset.nodeId))))
      .map((label) => ({ label, previousDisplay: label.style.display }));
    for (const { entity } of entities) entity.show = false;
    for (const { label } of labels) label.style.display = 'none';
    this._hiddenClusterFanoutVisuals = { entities, labels };
  }

  _restoreCollapsedClusterAfterFanout() {
    const hidden = this._hiddenClusterFanoutVisuals;
    if (!hidden) return;
    for (const { entity, previousShow } of hidden.entities) entity.show = previousShow;
    for (const { label, previousDisplay } of hidden.labels) label.style.display = previousDisplay;
    this._hiddenClusterFanoutVisuals = null;
  }

  showClusterFanout(clusterKey, lat, lon, fanout, onMemberClick) {
    this.clearClusterFanout({ cancelExpansion: false });
    this._hideCollapsedClusterForFanout(clusterKey, fanout);
    this._clusterFanoutLayer.replaceChildren();
    for (const item of fanout) {
      const member = document.createElement('button');
      member.type = 'button'; member.className = 'cluster-screen-fanout-member';
      member.style.setProperty('--member-x', `${item.offsetX}px`);
      member.style.setProperty('--member-y', `${item.offsetY}px`);
      member.style.setProperty('--member-color', item.appearance.color);
      member.style.setProperty('--member-radius', `${item.radiusPx}px`);
      member.style.setProperty('--member-angle', `${item.angleDeg}deg`);
      member.dataset.shape = item.appearance.shape;
      member.setAttribute('aria-label', `查看 ${String(item.group?.name || '默认分组')}`);
      const leader = document.createElement('span'); leader.className = 'cluster-screen-fanout-leader';
      const marker = document.createElement('span'); marker.className = 'cluster-screen-fanout-marker';
      const name = document.createElement('span'); name.className = 'cluster-screen-fanout-name'; name.textContent = String(item.group?.name || '默认分组');
      member.append(leader, marker, name);
      member.addEventListener('click', (event) => { event.stopPropagation(); onMemberClick?.(item.group); });
      this._clusterFanoutLayer.appendChild(member);
    }
    this._clusterFanoutOverlay = { anchor: Cesium.Cartesian3.fromDegrees(lon, lat, 180) };
    this._updateClusterFanoutOverlay();
    this._safeRequestRender();
  }

  expandClusterFanout({ clusterKey, lat, lon, fanout, onMemberClick }) {
    const centerLat = Number(lat); const centerLon = Number(lon);
    if (this._destroyed || !Number.isFinite(centerLat) || !Number.isFinite(centerLon) || !Array.isArray(fanout) || !fanout.length) return;
    this.showClusterFanout(clusterKey, centerLat, centerLon, fanout, onMemberClick);
  }

  clearClusterFanout({ cancelExpansion = true } = {}) {
    if (cancelExpansion) this._clusterFanoutExpansionId += 1;
    this._clusterFanoutLayer?.replaceChildren();
    if (this._clusterFanoutLayer) this._clusterFanoutLayer.hidden = true;
    this._clusterFanoutOverlay = null;
    this._restoreCollapsedClusterAfterFanout();
    this.viewer?.scene?.requestRender();
  }

  // ── 公共 API (main.js 契约) ──────────────────────────────
  updateServers(servers) {
    this.clearClusterFanout();
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

  flyToCity(lon, lat, height = 600_000, options = {}) {
    this._userInteracting = true;
    if (this._resumeTimer) { clearTimeout(this._resumeTimer); this._resumeTimer = null; }
    this.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
      duration: 1.6,
      complete: options.complete,
      cancel: options.cancel,
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

  resize() {
    if (!this.viewer || this._destroyed) return;
    try {
      const canvas = this.viewer.scene?.canvas;
      const host = this._cesiumDiv || this.container;
      const w = Math.max(
        host?.clientWidth || 0,
        canvas?.clientWidth || 0,
        canvas?.width || 0,
      );
      const h = Math.max(
        host?.clientHeight || 0,
        canvas?.clientHeight || 0,
        canvas?.height || 0,
      );
      // Cesium throws DeveloperError: Expected width to be greater than 0
      // when resize runs before layout (0×0 container).
      if (w < 1 || h < 1) return;
      this.viewer.resize();
    } catch (error) {
      console.warn('[CesiumGlobe] resize skipped', error);
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._layoutWaitTimer) {
      clearTimeout(this._layoutWaitTimer);
      this._layoutWaitTimer = null;
    }
    try { this._layoutObserver?.disconnect?.(); } catch (_) {}
    this._layoutObserver = null;
    this.clearClusterFanout();
    this._starshipLoadToken += 1;
    if (this._starshipModel && this.viewer?.scene?.primitives) {
      try { this.viewer.scene.primitives.remove(this._starshipModel); } catch (_) {}
    }
    try { this._starshipModel?.destroy?.(); } catch (_) {}
    this._starshipModel = null;
    this._starshipReady = false;
    this._starshipNativeRadius = null;
    if (this._raf) { try { cancelAnimationFrame(this._raf); } catch (_) {} this._raf = null; }
    if (this._resumeTimer) { try { clearTimeout(this._resumeTimer); } catch (_) {} this._resumeTimer = null; }
    if (this._onThemeChanged) window.removeEventListener('vps-theme-changed', this._onThemeChanged);
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
    try { this._removeRenderError?.(); } catch (_) {}
    try { this._handler?.destroy(); } catch (_) {}
    try { this._nasaParallaxBackground?.destroy(); } catch (_) {}
    this._nasaParallaxBackground = null;
    try { this._starEffectsLayer?.destroy(); } catch (_) {}
    this._starEffectsLayer = null;
    this._htmlLabels?.forEach((el) => el.remove());
    this._htmlLabels = new Map();
    if (this.viewer) { try { this.viewer.destroy(); } catch (_) {} this.viewer = null; }
    if (this.container) this.container.replaceChildren();
  }
}
