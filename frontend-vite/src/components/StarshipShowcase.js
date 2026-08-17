import '../globals/dashboardGlobals.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { engineFXMethods, updateEngineFX } from './starship/EngineFX.js';
import { bussardFXMethods } from './starship/BussardFX.js';
import { applyShipMaterials, shipMaterialMethods } from './starship/ShipMaterials.js';

export class StarshipShowcase {
  constructor(selector = '#starship-gltf-stage', options = {}) {
    this.container = typeof selector === 'string' ? document.querySelector(selector) : selector;
    this.options = {
      // Full original xinjian1 (textures + denser meshes).
      modelUrl: '/globe/xinjian1.glb?v=20260728',
      // A model setup failure must fail-soft; never download a second copy of the
      // same 55MB asset as a supposed fallback.
      fallbackModelUrl: '',
      deferMs: 120,
      ...options,
    };
    this._frame = null;
    this._destroyed = false;
    this._initTimer = null;
    this.ship = null;
    this.gltfMixer = null;
    this.gltfClock = new THREE.Clock();
    this.gltfLastUpdate = null;
    this.gltfAnimationActions = [];
    this.registryDecal = null;
    this.exhaustGroup = null;
    this.exhaustVersion = 'minimal-nacelle-propulsion-v1';
    this.composer = null;
    this.userOffset = new THREE.Vector2(0, 0);
    // Desktop hero scale — matched to the reference: prominent on the right,
    // but still leaves the globe and node callouts readable.
    // Keep the saucer registry readable at the normal desktop viewport while
    // preserving the right-side globe composition and label safe area.
    // Keep the complete Enterprise silhouette inside the desktop hero frame.
    this.userScale = 0.86;
    this.userYaw = 0;
    this.userRoll = 0;
    this.userFlip = 1;
    this._dragging = false;
    this._rotating = false;
    this._lastPointer = null;
    if (!this.container) return;
    // Wait until the stage has real layout. Cesium + Three both throw
    // "Expected width to be greater than 0" when initialized at 0×0.
    this._scheduleInit(Math.max(0, Number(this.options.deferMs) || 0));
  }

  _scheduleInit(delayMs = 0, attempt = 0) {
    if (this._destroyed || !this.container) return;
    if (this._initTimer) {
      clearTimeout(this._initTimer);
      this._initTimer = null;
    }
    this._initTimer = window.setTimeout(() => {
      this._initTimer = null;
      if (this._destroyed) return;
      const size = this._measureSize();
      // Use raw layout size, not the window fallback — otherwise we never wait for CSS.
      if ((size.rawW < 2 || size.rawH < 2) && attempt < 40) {
        this._scheduleInit(attempt < 8 ? 50 : 100, attempt + 1);
        return;
      }
      try {
        this._init();
      } catch (error) {
        this._failSoft(error, 'init');
      }
    }, Math.max(0, delayMs));
  }

  _measureSize() {
    const el = this.container;
    const rect = el?.getBoundingClientRect?.();
    const w = Math.max(
      0,
      Math.floor(el?.clientWidth || rect?.width || window.innerWidth || 0),
    );
    const h = Math.max(
      0,
      Math.floor(el?.clientHeight || rect?.height || window.innerHeight || 0),
    );
    return {
      w: w > 0 ? w : Math.max(1, window.innerWidth || 1),
      h: h > 0 ? h : Math.max(1, window.innerHeight || 1),
      rawW: w,
      rawH: h,
    };
  }

  _safeSetRendererSize(w, h) {
    const width = Math.max(1, Math.floor(Number(w) || 0));
    const height = Math.max(1, Math.floor(Number(h) || 0));
    if (!this.renderer || !this.camera) return { width, height };
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    // Three.js / render targets reject 0-sized framebuffers with DeveloperError-like throws.
    this.renderer.setSize(width, height, false);
    this.composer?.setSize?.(width, height);
    this.bloomPass?.setSize?.(width, height);
    return { width, height };
  }

  _dbgSet(key, value) {
    try {
      window.__DBG__ = window.__DBG__ || {};
      window.__DBG__[key] = value;
    } catch (_) {}
  }

  _failSoft(error, phase = 'unknown') {
    console.warn(`[StarshipShowcase] ${phase} failed — homepage globe continues without starship`, error);
    this._dbgSet('starshipError', String(error?.message || error || phase));
    this._dbgSet('starshipPhase', phase);
    try {
      this.container?.classList?.add('is-error');
      this.container?.classList?.remove('is-loaded');
    } catch (_) {}
    // Tear down partial GPU resources so Cesium can keep the page alive.
    try { this.destroy(); } catch (_) {}
  }

  _init() {
    if (this._destroyed || !this.container) return;
    const size = this._measureSize();
    const w = Math.max(1, size.w);
    const h = Math.max(1, size.h);
    this._dbgSet('starshipInitSize', { w, h, rawW: size.rawW, rawH: size.rawH });
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, w / h, 0.1, 100);
    // Keep the complete silhouette in frame; the right-side hero layout is
    // achieved with anchor placement rather than clipping it at the viewport edge.
    this.camera.position.set(0.0, 0.06, 9.35);

    // Homepage already runs Cesium WebGL. Prefer a lighter second context.
    // failIfMajorPerformanceCaveat avoids software GL that freezes mobile tabs.
    const canvas = document.createElement('canvas');
    // Seed a non-zero drawing buffer before WebGL init — some drivers reject 0×0.
    canvas.width = w;
    canvas.height = h;
    const gl =
      canvas.getContext('webgl2', { alpha: true, antialias: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true })
      || canvas.getContext('webgl', { alpha: true, antialias: true, powerPreference: 'high-performance', failIfMajorPerformanceCaveat: true })
      || canvas.getContext('webgl2', { alpha: true, antialias: false, powerPreference: 'default' })
      || canvas.getContext('webgl', { alpha: true, antialias: false, powerPreference: 'default' });
    if (!gl) {
      throw new Error('WebGL unavailable for starship overlay');
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    const isMobile = window.matchMedia?.('(max-width: 640px)')?.matches;
    // Restore desktop detail without reintroducing the old multi-target post-process path.
    // Mobile remains deliberately lower density to protect its shared GPU budget with Cesium.
    // Force enough raster samples for panel maps even when the host reports DPR=1
    // (headless browsers and some remote desktop sessions).
    // 1.75 DPR with 25 rehydrated 1536px textures stalls shared Cesium/Three frames.
    // Keep panel readability while preserving interactive/screenshot stability.
    this.renderer.setPixelRatio(isMobile ? 1 : 1.25);
    this._safeSetRendererSize(w, h);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;
    this.renderer.useLegacyLights = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Darker exposure so contrast-boosted panel maps don't wash to chalk white.
    this.renderer.toneMappingExposure = isMobile ? 0.90 : 0.82;
    this.renderer.shadowMap.enabled = false;
    this.composer = null;
    this.bloomPass = null;

    // Limited environment reflection so the metallized hull has something to
    // reflect (high-metalness materials render near-black with no envMap). A
    // lightweight procedural RoomEnvironment via PMREM gives soft studio
    // reflections without shipping an HDR asset. Kept subtle (low intensity) to
    // preserve the hand-authored GLB look and not wash out warp/Bussard glows.
    this.scene.environment = null;
    this.scene.environmentIntensity = 0;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      import('three/examples/jsm/environments/RoomEnvironment.js')
        .then(({ RoomEnvironment }) => {
          const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
          this.scene.environment = envRT.texture;
          this.scene.environmentIntensity = 0.6;
          this._dbgSet('starshipEnvConfigured', true);
        })
        .catch((e) => this._dbgSet('starshipEnvError', String(e).slice(0, 120)));
    } catch (e) {
      this._dbgSet('starshipEnvError', String(e).slice(0, 120));
    }
    this._dbgSet('starshipDetailProfile', {
      profile: isMobile ? 'mobile-safe' : 'desktop-panel-readable',
      pixelRatio: this.renderer.getPixelRatio(),
      exposure: this.renderer.toneMappingExposure,
      environmentIntensity: this.scene.environmentIntensity,
    });

    this.renderer.domElement.className = 'starship-gltf-canvas';
    this.container.appendChild(this.renderer.domElement);
    this.hitbox = document.createElement('div');
    this.hitbox.className = 'starship-interaction-hitbox';
    this.hitbox.setAttribute('aria-label', 'Hover starship: drag to move, wheel to scale, right-drag to rotate, double-click to flip');
    this.container.appendChild(this.hitbox);

    this.renderer.domElement.addEventListener('webglcontextlost', (ev) => {
      ev.preventDefault();
      this._failSoft(new Error('webglcontextlost'), 'contextlost');
    }, false);

    // 172 lighting: warm key from upper-right, cool fill and rim, restrained ambient.
    const ambientFloor = new THREE.AmbientLight(0x0a1220, isMobile ? 0.16 : 0.14);
    this.scene.add(ambientFloor);
    const key = new THREE.DirectionalLight(0xe8f1ff, isMobile ? 2.2 : 2.90);
    key.position.set(5.8, 4.6, 6.2);
    key.castShadow = false;
    this.scene.add(key);
    const coolFill = new THREE.HemisphereLight(0x5478a8, 0x05070d, isMobile ? 0.22 : 0.30);
    this.scene.add(coolFill);
    const rim = new THREE.DirectionalLight(0xb4c8ff, isMobile ? 0.55 : 0.95);
    rim.position.set(-4.5, 2.8, -5.0);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff6a38, isMobile ? 0.42 : 0.70, 5.6);
    warm.position.set(-2.8, 1.8, 2.6);
    this.scene.add(warm);
    const windowGlow = new THREE.PointLight(0xdff0ff, isMobile ? 0.42 : 0.70, 4.8);
    windowGlow.position.set(0.6, 0.35, 1.8);
    this.scene.add(windowGlow);

    this.anchor = new THREE.Group();
    // Closer to 172's right-side hero pose.
    // Full Enterprise silhouette stays inside a 1280px desktop hero frame.
    this.basePosition = new THREE.Vector3(2.15, -0.16, 0.0);
    this.baseRotation = new THREE.Euler(0.62, -0.72, 0.18);
    this.anchor.position.copy(this.basePosition);
    this.anchor.rotation.copy(this.baseRotation);
    this.anchor.scale.setScalar(this.userScale);
    this.scene.add(this.anchor);

    this._loadModel(this.options.modelUrl, true);

    this._installInteractionHandlers();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    this._start = performance.now();
    this._tick();
    this._dbgSet('starshipMode', 'independent-three-overlay-safe');
  }

  _loadModel(url, allowFallback = false) {
    if (this._destroyed || !url) return;
    const gltfLoader = new GLTFLoader();
    this._dbgSet('starshipModelUrl', url);
    gltfLoader.load(
      url,
      (gltf) => {
        // GLTFLoader may resolve materials before ImageBitmap textures finish, or drop maps
        // in some browser paths. Always rehydrate maps from the GLB binary after load.
        this._finishModelLoad(gltf, url, allowFallback).catch((error) => {
          this._failSoft(error, 'model-setup');
        });
      },
      undefined,
      (error) => {
        console.warn('[StarshipShowcase] GLB load failed', url, error);
        if (allowFallback && this.options.fallbackModelUrl && this.options.fallbackModelUrl !== url) {
          this._dbgSet('starshipFallback', this.options.fallbackModelUrl);
          this._loadModel(this.options.fallbackModelUrl, false);
          return;
        }
        this.container?.classList?.add('is-error');
        this._dbgSet('starshipError', String(error?.message || error || 'glb-load-failed'));
      },
    );
  }

  async _finishModelLoad(gltf, url, allowFallback) {
    try {
      if (this._destroyed) return;
      this.ship = gltf.scene;
      this.ship.name = 'User DSC Enterprise GLB Starship';
      if (gltf.animations && gltf.animations.length) {
        this.gltfMixer = new THREE.AnimationMixer(this.ship);
        this.gltfAnimationActions = gltf.animations.map((clip) => {
          const action = this.gltfMixer.clipAction(clip);
          action.enabled = true;
          action.setLoop(THREE.LoopRepeat, Infinity);
          action.play();
          return action;
        });
        this.ship.userData.gltfAnimationInfo = gltf.animations.map((clip) => ({
          name: clip.name,
          duration: clip.duration,
          tracks: clip.tracks?.map((track) => track.name) || [],
        }));
        this._dbgSet('starshipGltfAnimationInfo', this.ship.userData.gltfAnimationInfo);
      }
      this._normalizeUserModel(this.ship);

      // Inventory BEFORE rehydrate
      const texStatsBefore = { total: 0, withMap: 0, withNormal: 0, withEmissiveMap: 0, samples: [] };
      this.ship.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const srcMats = Array.isArray(obj.material) ? obj.material : [obj.material];
        srcMats.forEach((m) => {
          texStatsBefore.total += 1;
          if (m.map) texStatsBefore.withMap += 1;
          if (m.normalMap) texStatsBefore.withNormal += 1;
          if (m.emissiveMap) texStatsBefore.withEmissiveMap += 1;
          if (texStatsBefore.samples.length < 6) {
            texStatsBefore.samples.push({
              name: m.name,
              type: m.type,
              hasMap: !!m.map,
              mapSize: m.map?.image?.width || m.map?.source?.data?.width || 0,
              color: m.color?.getHexString?.(),
            });
          }
        });
      });
      this._dbgSet('starshipTextureInventoryBefore', texStatsBefore);

      const rehydrate = await this._rehydrateGltfTextures(gltf);
      this._dbgSet('starshipTextureRehydrate', rehydrate);

      // Inventory AFTER rehydrate, before semantic mutation
      const texStats = { total: 0, withMap: 0, withNormal: 0, withEmissiveMap: 0, samples: [] };
      this.ship.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const srcMats = Array.isArray(obj.material) ? obj.material : [obj.material];
        srcMats.forEach((m) => {
          texStats.total += 1;
          if (m.map) texStats.withMap += 1;
          if (m.normalMap) texStats.withNormal += 1;
          if (m.emissiveMap) texStats.withEmissiveMap += 1;
          if (texStats.samples.length < 8) {
            texStats.samples.push({
              name: m.name,
              type: m.type,
              hasMap: !!m.map,
              mapSize: m.map?.image?.width || m.map?.source?.data?.width || 0,
              color: m.color?.getHexString?.(),
            });
          }
        });
      });
      this._dbgSet('starshipTextureInventory', texStats);

      applyShipMaterials(this);

      this.anchor.add(this.ship);
      this._addExhaustRig();
      this._addBussardCollectorFidelity();
      // Keep native GLB label/nav geometry only. Do not add screen-facing registry text
      // or synthetic red/green saucer lamps.
      this._dbgSet('starshipAnimationContract', {
        clips: this.gltfAnimationActions.length,
        bussardTracks: this.ship.userData.gltfAnimationInfo?.flatMap((clip) => clip.tracks || []).filter((track) => /bussard/i.test(track)) || [],
        exhaustAttached: !!this.exhaustGroup,
      });
      this.container.classList.add('is-loaded');
      this.container.classList.remove('is-error');
      this._dbgSet('starshipLoaded', true);
      this._dbgSet('starshipModelUrlFinal', url);
    } catch (error) {
      if (allowFallback && this.options.fallbackModelUrl && this.options.fallbackModelUrl !== url) {
        this._dbgSet('starshipFallback', this.options.fallbackModelUrl);
        this._loadModel(this.options.fallbackModelUrl, false);
        return;
      }
      this._failSoft(error, 'model-setup');
    }
  }


  _normalizeUserModel(ship) {
    const box = new THREE.Box3().setFromObject(ship);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 0.001);
    const target = 4.85;
    const scale = target / maxDim;
    ship.scale.setScalar(scale);
    // Important: Object3D translation is not affected by its own scale. Offset by scaled center.
    ship.position.set(-center.x * scale, -center.y * scale, -center.z * scale);
    // Low underside/readable saucer pose: exposes the belly, pylons, nacelles and registry markings.
    ship.rotation.set(0.62, Math.PI / 2 + 0.62, -0.34);
    this._modelInfo = { size: size.toArray(), center: center.toArray(), scale, centeredPosition: ship.position.toArray() };
  }


  _addShowcaseGlowRig() {
    if (!this.anchor || this.glowRig) return;
    this.glowRig = new THREE.Group();
    const cyan = this._makeGlowSprite(170, 221, 255, 0.68, 0.40);
    cyan.position.set(0.10, -0.28, 0.46);
    this.glowRig.add(cyan);
    this.anchor.add(this.glowRig);
  }


  _addWindowGlowRig() {
    if (!this.anchor || this.windowGlowRig) return;
    this.windowGlowRig = new THREE.Group();
    [
      [-0.78, 0.02, 0.34, 0.18], [-0.46, 0.04, 0.36, 0.16], [-0.12, 0.05, 0.35, 0.15],
      [0.24, 0.03, 0.32, 0.16], [0.58, 0.01, 0.28, 0.15], [0.92, -0.02, 0.20, 0.14],
      [-0.62, -0.20, 0.12, 0.13], [-0.22, -0.23, 0.09, 0.12], [0.24, -0.22, 0.06, 0.12],
    ].forEach(([x, y, z, size]) => {
      const windowGlow = this._makeGlowSprite(170, 221, 255, size, 0.45);
      windowGlow.position.set(x, y, z);
      this.windowGlowRig.add(windowGlow);
    });
    this.anchor.add(this.windowGlowRig);
  }


  _installInteractionHandlers() {
    const target = window;
    const boundsEl = this.renderer?.domElement;
    if (!boundsEl) return;
    this._shipScreenTest = (ev) => this._isPointerNearShip(ev.clientX, ev.clientY);
    this._setHover = (hover) => {
      this.hitbox?.classList.toggle('is-hovering-ship', !!hover);
      document.body.classList.toggle('starship-hovering', !!hover);
    };
    this._onPointerDown = (ev) => {
      if (!this._shipScreenTest(ev)) return;
      this._dragging = true;
      this._rotating = ev.button === 2 || ev.shiftKey || ev.altKey;
      this._lastPointer = { x: ev.clientX, y: ev.clientY };
      this._lastShipInteraction = performance.now();
      this.hitbox?.classList.add('is-grabbing');
      document.body.classList.add('starship-grabbing');
      ev.preventDefault();
      ev.stopPropagation();
    };
    this._onPointerMove = (ev) => {
      if (!this._dragging || !this._lastPointer) {
        this._setHover(this._shipScreenTest(ev));
        return;
      }
      const dx = ev.clientX - this._lastPointer.x;
      const dy = ev.clientY - this._lastPointer.y;
      this._lastPointer = { x: ev.clientX, y: ev.clientY };
      const rect = boundsEl.getBoundingClientRect();
      this._lastShipInteraction = performance.now();
      if (this._rotating) {
        this.userYaw += dx / Math.max(1, rect.width) * 3.6;
        this.userRoll += dy / Math.max(1, rect.height) * 1.8;
      } else {
        this.userOffset.x = THREE.MathUtils.clamp(this.userOffset.x + dx / Math.max(1, rect.width) * 5.8, -4.20, 3.80);
        this.userOffset.y = THREE.MathUtils.clamp(this.userOffset.y - dy / Math.max(1, rect.height) * 3.6, -2.75, 2.75);
      }
      ev.preventDefault();
      ev.stopPropagation();
    };
    this._onPointerUp = (ev) => {
      if (!this._dragging) return;
      this._dragging = false;
      this._rotating = false;
      this._lastPointer = null;
      this.hitbox?.classList.remove('is-grabbing');
      document.body.classList.remove('starship-grabbing');
      this._setHover(this._shipScreenTest(ev));
      ev.preventDefault();
      ev.stopPropagation();
    };
    this._onWheel = (ev) => {
      if (!this._shipScreenTest(ev)) return;
      this._lastShipInteraction = performance.now();
      if (ev.shiftKey || ev.altKey) {
        this.userYaw += ev.deltaY > 0 ? -0.16 : 0.16;
      } else {
        this.userScale = THREE.MathUtils.clamp(this.userScale * (ev.deltaY > 0 ? 0.90 : 1.10), 0.28, 2.35);
      }
      ev.preventDefault();
      ev.stopPropagation();
    };
    this._onDoubleClick = (ev) => {
      const recent = performance.now() - (this._lastShipInteraction || 0) < 1600;
      if (!this._shipScreenTest(ev) && !recent) return;
      this.userFlip *= -1;
      ev.preventDefault();
      ev.stopPropagation();
    };
    this._onContextMenu = (ev) => {
      const recent = performance.now() - (this._lastShipInteraction || 0) < 1600;
      if (!this._shipScreenTest(ev) && !recent) return;
      this.userFlip *= -1;
      ev.preventDefault();
      ev.stopPropagation();
    };
    target.addEventListener('pointerdown', this._onPointerDown, true);
    target.addEventListener('pointermove', this._onPointerMove, true);
    target.addEventListener('pointerup', this._onPointerUp, true);
    target.addEventListener('pointercancel', this._onPointerUp, true);
    target.addEventListener('wheel', this._onWheel, { passive: false, capture: true });
    target.addEventListener('dblclick', this._onDoubleClick, true);
    target.addEventListener('contextmenu', this._onContextMenu, true);
  }

  _isPointerNearShip(clientX, clientY) {
    if (!this.anchor || !this.camera || !this.renderer) return false;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const p = this.anchor.position.clone().project(this.camera);
    const sx = rect.left + (p.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-p.y * 0.5 + 0.5) * rect.height;
    const rx = Math.max(150, 360 * this.userScale);
    const ry = Math.max(90, 185 * this.userScale);
    const dx = (clientX - sx) / rx;
    const dy = (clientY - sy) / ry;
    return dx * dx + dy * dy <= 1.0;
  }

  _tick() {
    if (this._destroyed) return;
    const t = (performance.now() - this._start) / 1000;
    if (this.gltfMixer) {
      const now = performance.now();
      const dt = this.gltfLastUpdate == null ? 0.016 : Math.min(0.25, Math.max(0, (now - this.gltfLastUpdate) / 1000));
      this.gltfLastUpdate = now;
      this.gltfMixer.update(dt);
      window.__DBG__.starshipGltfMixerTime = this.gltfMixer.time;
      window.__DBG__.starshipGltfMixerTicks = (window.__DBG__.starshipGltfMixerTicks || 0) + 1;
    }
    this.anchor.position.set(
      this.basePosition.x + this.userOffset.x,
      this.basePosition.y + this.userOffset.y + Math.sin(t * 0.72) * 0.045,
      this.basePosition.z
    );
    this.anchor.scale.set(this.userScale * this.userFlip, this.userScale, this.userScale);
    this.anchor.rotation.x = this.baseRotation.x + this.userRoll;
    this.anchor.rotation.y = this.baseRotation.y + this.userYaw + Math.sin(t * 0.42) * 0.035;
    this.anchor.rotation.z = this.baseRotation.z + Math.sin(t * 0.58) * 0.014;
    updateEngineFX(this, t);
    // Use direct transparent rendering on the homepage. EffectComposer/UnrealBloomPass
    // outputs an opaque black rectangle in a partial overlay canvas, which darkens the Earth
    // or forces screen blending that makes the ship look transparent.
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this._frame = requestAnimationFrame(() => this._tick());
  }

  resize() {
    if (!this.container || !this.renderer || !this.camera || this._destroyed) return;
    const size = this._measureSize();
    // Skip 0×0 frames (hidden route / display:none) — never call setSize(0, *).
    if (size.rawW < 1 || size.rawH < 1) return;
    this._safeSetRendererSize(size.w, size.h);
  }

  destroy() {
    this._destroyed = true;
    if (this._initTimer) {
      clearTimeout(this._initTimer);
      this._initTimer = null;
    }
    if (this._frame) cancelAnimationFrame(this._frame);
    this._frame = null;
    this.gltfMixer?.stopAllAction?.();
    this.gltfMixer = null;
    this.gltfLastUpdate = null;
    this.gltfAnimationActions = [];
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    this.scene?.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      mats.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
    });
    // Interaction listeners are attached to the hitbox/target, not always window.
    try {
      const target = this.hitbox || this.renderer?.domElement;
      if (target) {
        if (this._onPointerDown) target.removeEventListener('pointerdown', this._onPointerDown, true);
        if (this._onPointerMove) target.removeEventListener('pointermove', this._onPointerMove, true);
        if (this._onPointerUp) {
          target.removeEventListener('pointerup', this._onPointerUp, true);
          target.removeEventListener('pointercancel', this._onPointerUp, true);
        }
        if (this._onWheel) target.removeEventListener('wheel', this._onWheel, { capture: true });
        if (this._onDoubleClick) target.removeEventListener('dblclick', this._onDoubleClick, true);
        if (this._onContextMenu) target.removeEventListener('contextmenu', this._onContextMenu, true);
      }
    } catch (_) {}
    document.body.classList.remove('starship-hovering', 'starship-grabbing');
    this.composer?.dispose?.();
    this.renderer?.dispose?.();
    this.hitbox?.remove?.();
    this.renderer?.domElement?.remove?.();
  }
}

Object.assign(StarshipShowcase.prototype, engineFXMethods, bussardFXMethods, shipMaterialMethods);
