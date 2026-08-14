import '../globals/dashboardGlobals.js';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

  async _rehydrateGltfTextures(gltf) {
    const parser = gltf?.parser;
    const json = parser?.json;
    if (!parser || !json?.images?.length || !json?.materials?.length) {
      return { attempted: 0, attached: 0, reason: 'no-parser-json' };
    }

    const textureCache = new Map();
    const loadTextureByIndex = async (textureIndex, colorSpace) => {
      if (textureIndex == null || textureIndex < 0) return null;
      const cacheKey = `${textureIndex}:${colorSpace || 'default'}`;
      if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);

      const texDef = json.textures?.[textureIndex];
      if (!texDef) return null;
      const sourceIndex = texDef.source;
      const imageDef = json.images?.[sourceIndex];
      if (!imageDef || imageDef.bufferView == null) return null;

      const bufferView = await parser.getDependency('bufferView', imageDef.bufferView);
      // Offline GLB already contrast-boosted; avoid double-processing that can posterize.
      let imageBitmap;
      try {
        const blob = new Blob([bufferView], { type: imageDef.mimeType || 'image/png' });
        imageBitmap = await createImageBitmap(blob);
      } catch (err) {
        console.warn('[StarshipShowcase] createImageBitmap failed', textureIndex, err);
        return null;
      }

      const texture = new THREE.Texture(imageBitmap);
      texture.flipY = false;
      texture.needsUpdate = true;
      texture.colorSpace = colorSpace || THREE.NoColorSpace;
      texture.anisotropy = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
      texture.userData = {
        rehydrated: true,
        contrastBoosted: colorSpace === THREE.SRGBColorSpace,
        textureIndex,
        sourceIndex,
        mimeType: imageDef.mimeType || 'image/png',
      };

      // Apply sampler wrap/filter when present.
      const sampler = json.samplers?.[texDef.sampler ?? 0] || {};
      if (sampler.wrapS != null) texture.wrapS = sampler.wrapS;
      if (sampler.wrapT != null) texture.wrapT = sampler.wrapT;
      if (sampler.magFilter != null) texture.magFilter = sampler.magFilter;
      if (sampler.minFilter != null) texture.minFilter = sampler.minFilter;

      textureCache.set(cacheKey, texture);
      return texture;
    };

    let attempted = 0;
    let attached = 0;
    const materialTextures = [];

    for (let i = 0; i < json.materials.length; i += 1) {
      const matDef = json.materials[i];
      const pbr = matDef.pbrMetallicRoughness || {};
      const slots = [];
      if (pbr.baseColorTexture?.index != null) {
        slots.push({ slot: 'map', index: pbr.baseColorTexture.index, colorSpace: THREE.SRGBColorSpace });
      }
      if (pbr.metallicRoughnessTexture?.index != null) {
        slots.push({ slot: 'metalnessMap', index: pbr.metallicRoughnessTexture.index, colorSpace: THREE.NoColorSpace });
        slots.push({ slot: 'roughnessMap', index: pbr.metallicRoughnessTexture.index, colorSpace: THREE.NoColorSpace });
      }
      if (matDef.normalTexture?.index != null) {
        slots.push({ slot: 'normalMap', index: matDef.normalTexture.index, colorSpace: THREE.NoColorSpace });
      }
      if (matDef.emissiveTexture?.index != null) {
        slots.push({ slot: 'emissiveMap', index: matDef.emissiveTexture.index, colorSpace: THREE.SRGBColorSpace });
      }
      if (matDef.occlusionTexture?.index != null) {
        slots.push({ slot: 'aoMap', index: matDef.occlusionTexture.index, colorSpace: THREE.NoColorSpace });
      }
      if (!slots.length) continue;

      const loaded = {};
      for (const s of slots) {
        attempted += 1;
        // metalness/roughness share one texture object; load once
        if (loaded[s.slot]) continue;
        // eslint-disable-next-line no-await-in-loop
        const tex = await loadTextureByIndex(s.index, s.colorSpace);
        if (tex) {
          loaded[s.slot] = tex;
          attached += 1;
        }
      }
      if (Object.keys(loaded).length) {
        materialTextures.push({ materialIndex: i, name: matDef.name || `mat_${i}`, maps: loaded });
      }
    }

    // Assign onto live scene materials by material index when available, else by name.
    this.ship?.traverse((obj) => {
      if (!obj.isMesh || !obj.material) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((mat) => {
        // Prefer exact gltf material index if three stored it.
        const idx = mat.userData?.gltfExtensions ? null : (mat.userData?.materialIndex ?? null);
        let entry = null;
        if (idx != null) entry = materialTextures.find((m) => m.materialIndex === idx);
        if (!entry && mat.name) entry = materialTextures.find((m) => m.name === mat.name);
        if (!entry) return;
        Object.entries(entry.maps).forEach(([slot, tex]) => {
          if (!mat[slot]) {
            mat[slot] = tex;
            // roughness/metalness often share the same texture instance
            if (slot === 'metalnessMap' && !mat.roughnessMap) mat.roughnessMap = tex;
            if (slot === 'roughnessMap' && !mat.metalnessMap) mat.metalnessMap = tex;
          }
        });
        mat.needsUpdate = true;
      });
    });

    // Second pass: match by material definition order if names collided.
    // Collect unique materials currently used and map by name only (already done).

    return {
      attempted,
      attached,
      materialsWithMaps: materialTextures.length,
      textureObjects: textureCache.size,
    };
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
      let texStatsBefore = { total: 0, withMap: 0, withNormal: 0, withEmissiveMap: 0, samples: [] };
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
      let texStats = { total: 0, withMap: 0, withNormal: 0, withEmissiveMap: 0, samples: [] };
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

      // Preserve original maps. Only clone+boost a few named emitters so shared materials
      // are not cross-contaminated. Never repaint the whole hull when a map exists.
      this.ship.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const srcMats = Array.isArray(obj.material) ? obj.material : [obj.material];
        const mats = srcMats.map((m) => {
          const c = m.clone();
          c.map = m.map || null;
          c.normalMap = m.normalMap || null;
          c.roughnessMap = m.roughnessMap || null;
          c.metalnessMap = m.metalnessMap || null;
          c.emissiveMap = m.emissiveMap || null;
          c.aoMap = m.aoMap || null;
          if (c.map) {
            c.map.colorSpace = THREE.SRGBColorSpace;
            c.map.needsUpdate = true;
          }
          c.userData = { ...(m.userData || {}), clonedFrom: m.name || 'mat', hadMap: !!m.map };
          return c;
        });
        obj.material = Array.isArray(obj.material) ? mats : mats[0];
        mats.forEach((mat) => {
          const materialName = `${mat.name || ''} ${obj.name || ''}`.toLowerCase();
          const hasMap = !!(mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap || mat.emissiveMap);
          const isRegistry = /registry|decal|letter|ncc|label_\d+/.test(materialName);
          const isWarpCoil = /warp[_-]?coils?|warpcoil/.test(materialName);
          // Do not recolor or boost model nav-light materials. The user requested removal
          // of the artificial red/green saucer lamps; native GLB material values remain untouched.
          const isGreenNav = false;
          const isRedNav = false;
          const isWindow = /window|pilot_light|force_field|sensor_ball/.test(materialName);
          const isEngine = /(bussard_dome|bussard|impulse_engines|thruster|plasma)/.test(materialName) && !isWarpCoil;

          if (isRegistry) {
            if (!hasMap && mat.color) mat.color.set(0x101820);
            if ('emissive' in mat) mat.emissive.set(0x000000);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0;
            if ('metalness' in mat) mat.metalness = Math.min(Number(mat.metalness ?? 0.2), 0.25);
            if ('roughness' in mat) mat.roughness = Math.max(Number(mat.roughness ?? 0.5), 0.45);
          } else if (isGreenNav || isRedNav) {
            const navColor = isGreenNav ? 0x2dff7a : 0xff2a3a;
            if (!hasMap && mat.color) mat.color.set(navColor);
            if ('emissive' in mat) mat.emissive.set(navColor);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = 2.6;
            mat.toneMapped = false;
          } else if (isWarpCoil) {
            // Preserve the strip texture but enforce the classic electric-blue energy tint.
            // Texture acts as a mask/detail layer; blue must remain visible at homepage distance.
            if (mat.color) mat.color.set(0x58c7ff);
            if ('emissive' in mat) mat.emissive.set(0x138dff);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(Number(mat.emissiveIntensity || 0), 4.4);
            if ('metalness' in mat) mat.metalness = 0.22;
            if ('roughness' in mat) mat.roughness = 0.20;
            mat.envMapIntensity = 0.65;
            mat.toneMapped = false;
          } else if (isEngine) {
            // Bussard collectors need an unmistakable warm contrast against blue warp strips.
            if (mat.color) mat.color.set(0xff7628);
            if ('emissive' in mat) mat.emissive.set(0xff4b12);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(Number(mat.emissiveIntensity || 0), 4.8);
            if ('metalness' in mat) mat.metalness = 0.18;
            if ('roughness' in mat) mat.roughness = 0.26;
            mat.envMapIntensity = 0.45;
            mat.toneMapped = false;
          } else if (isWindow) {
            if ('emissive' in mat && (!mat.emissive || mat.emissive.getHex() === 0)) mat.emissive.set(0x8ec7ff);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(Number(mat.emissiveIntensity || 0), 0.55);
            mat.toneMapped = false;
          } else {
            // HULL: stronger metallization — brushed-steel look. Keep maps intact
            // (never repaint textured panels), only raise metalness toward full and
            // drop roughness for sharper specular/reflection. Lift envMapIntensity so
            // the metal actually catches reflections. Warp/Bussard/nav/registry/window
            // are handled in their own branches above and stay untouched.
            if (!hasMap) {
              const base = mat.color ? mat.color.getHex() : 0xffffff;
              // Neutral steel tint for untextured hull panels.
              if (mat.color && base === 0xffffff) mat.color.set(0xc2cad4);
            } else if (mat.color) {
              // Keep the panel map readable but let the metal tint show through.
              mat.color.set(0xdde3ea);
            }
            if ('metalness' in mat) mat.metalness = Math.max(Number(mat.metalness || 0), hasMap ? 0.92 : 0.88);
            if ('roughness' in mat) {
              const r = Number(mat.roughness ?? 0.5);
              // Lower ceiling => shinier, more reflective metal; keep a floor so it
              // is brushed steel, not a chrome mirror.
              mat.roughness = Math.min(Math.max(r, 0.16), 0.32);
            }
            mat.envMapIntensity = Math.max(Number(mat.envMapIntensity || 0), hasMap ? 1.5 : 1.3);
          }
          obj.castShadow = false;
          obj.receiveShadow = false;
          mat.needsUpdate = true;
        });
      });

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


  _makeGlowTexture(r, g, b) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const gradient = ctx.createRadialGradient(48, 48, 0, 48, 48, 48);
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`);
    gradient.addColorStop(0.24, `rgba(${r}, ${g}, ${b}, .92)`);
    gradient.addColorStop(0.58, `rgba(${r}, ${g}, ${b}, .28)`);
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 96, 96);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.needsUpdate = true;
    return texture;
  }

  _addBussardCollectorFidelity() {
    if (!this.ship || this.bussardCollectorEffects) return;
    this.bussardCollectorEffects = new THREE.Group();
    this.bussardCollectorEffects.name = 'Visible animated Bussard collector glows';

    const orangeTexture = this._makeGlowTexture(255, 92, 18);
    const makeCollector = (engineName, id) => {
      const engine = this.ship.getObjectByName(engineName);
      if (!engine) return null;

      // Find actual forward-most local mesh point from the animated Bussard hierarchy.
      // A small camera-facing sprite avoids hiding the native rotating dome yet guarantees
      // that its orange collection glow is visible at the homepage hero distance.
      const box = new THREE.Box3().setFromObject(engine);
      const center = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3());
      const localCenter = this.ship.worldToLocal(center.clone());
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: orangeTexture,
        color: 0xff6a20,
        transparent: true,
        opacity: 0.88,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }));
      sprite.name = `${id} visible orange Bussard collector`;
      sprite.position.copy(localCenter);
      // Raw GLB local units; box size gives a scale that reads as a compact dome, not HUD.
      const glow = Math.max(44, Math.min(92, Math.max(size.x, size.y, size.z) * 0.56));
      sprite.scale.set(glow, glow, 1);
      sprite.renderOrder = 54;
      sprite.userData = { engineName, localCenter: localCenter.toArray(), glow };
      this.bussardCollectorEffects.add(sprite);
      return sprite;
    };

    this.bussardCollectorRight = makeCollector('bussard_right', 'Starboard');
    this.bussardCollectorLeft = makeCollector('bussard_left', 'Port');
    if (this.bussardCollectorRight || this.bussardCollectorLeft) {
      this.ship.add(this.bussardCollectorEffects);
    }
    this._dbgSet('starshipBussardCollectors', {
      left: this.bussardCollectorLeft?.userData || null,
      right: this.bussardCollectorRight?.userData || null,
      visibleOrange: !!(this.bussardCollectorLeft || this.bussardCollectorRight),
    });
  }

  _addColdEdgeShell(source) {
    // clonefix1: keep bussard/exhaust animation, but do not clone entire GLTF scene.
    return;
    if (!this.anchor || !source || this.edgeShell) return;
    this.edgeShell = source.clone(true);
    this.edgeShell.name = 'Cold blue 2px-style edge shell';
    this.edgeShell.scale.multiplyScalar(1.012);
    this.edgeShell.traverse((obj) => {
      if (!obj.isMesh) return;
      obj.material = new THREE.MeshBasicMaterial({
        color: 0x7799cc,
        transparent: true,
        opacity: 0.055,
        blending: THREE.AdditiveBlending,
        side: THREE.BackSide,
        depthWrite: false,
      });
      obj.renderOrder = 2;
    });
    this.anchor.add(this.edgeShell);
  }

  _addChromaticEdgePass(source) {
    // clonefix1: keep bussard/exhaust animation, but do not clone entire GLTF scene.
    return;
    if (!this.anchor || !source || this.chromaticEdges) return;
    this.chromaticEdges = new THREE.Group();
    const passes = [
      { color: 0xff4f45, x: 0.018, opacity: 0.035 },
      { color: 0x5f9cff, x: -0.018, opacity: 0.045 },
    ];
    passes.forEach((pass) => {
      const ghost = source.clone(true);
      ghost.name = `Subtle ${pass.color.toString(16)} chromatic edge pass`;
      ghost.position.x += pass.x;
      ghost.scale.multiplyScalar(1.004);
      ghost.traverse((obj) => {
        if (!obj.isMesh) return;
        obj.material = new THREE.MeshBasicMaterial({
          color: pass.color,
          transparent: true,
          opacity: pass.opacity,
          blending: THREE.AdditiveBlending,
          side: THREE.FrontSide,
          depthWrite: false,
        });
        obj.renderOrder = 1;
      });
      this.chromaticEdges.add(ghost);
    });
    this.anchor.add(this.chromaticEdges);
  }


  _makeIrregularPlasmaPlumeGeometry(length = 10.8, baseRadius = 0.82, radialSegments = 96, lengthSegments = 32, seed = 7) {
    const positions = [];
    const uvs = [];
    const indices = [];
    const rand = (n) => {
      const x = Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    const radiusAt = (t, a, ring) => {
      // Not a cone: pinch at nozzle, rapid expansion, turbulent waist, then stretched filament tail.
      const rootPinch = 0.58 + 0.42 * Math.min(t / 0.16, 1.0);
      const pressureBulge = 0.34 * Math.exp(-Math.pow((t - 0.22) / 0.16, 2));
      const taper = Math.pow(1.0 - t, 0.58);
      const wakeFloor = 0.075 * Math.pow(1.0 - t, 0.18);
      const pulse = 1.0
        + Math.sin(t * 22.0 + seed * 0.73) * 0.075
        + Math.sin(t * 47.0 + seed * 1.91) * 0.038;
      const angular = 1.0
        + Math.sin(a * 3.0 + t * 13.0 + seed) * 0.075
        + Math.sin(a * 7.0 - t * 21.0 + seed * 2.1) * 0.045
        + (rand(ring * 17.0 + Math.floor(a * 9.0)) - 0.5) * 0.055;
      const tornTail = 1.0 - smoothstep(0.68, 1.0, t) * (0.10 + 0.10 * Math.sin(a * 5.0 + seed));
      return baseRadius * Math.max(0.035, (rootPinch * taper + pressureBulge + wakeFloor) * pulse * angular * tornTail);
    };
    function smoothstep(edge0, edge1, x) {
      const tt = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
      return tt * tt * (3 - 2 * tt);
    }
    for (let j = 0; j <= lengthSegments; j += 1) {
      const t = j / lengthSegments;
      const y = -length / 2 + t * length;
      const wobble = smoothstep(0.10, 1.0, t) * Math.pow(t, 0.75);
      const cx = Math.sin(t * 10.5 + seed * 0.6) * baseRadius * 0.045 * wobble;
      const cz = Math.cos(t * 8.4 + seed * 0.9) * baseRadius * 0.035 * wobble;
      for (let i = 0; i <= radialSegments; i += 1) {
        const u = i / radialSegments;
        const a = u * Math.PI * 2;
        const r = radiusAt(t, a, j);
        positions.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
        uvs.push(u, t);
      }
    }
    for (let j = 0; j < lengthSegments; j += 1) {
      for (let i = 0; i < radialSegments; i += 1) {
        const row = radialSegments + 1;
        const a = j * row + i;
        const b = a + 1;
        const c = (j + 1) * row + i;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    return geo;
  }

  _makeExhaustMaterial() {
    return new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: { uTime: { value: 0 }, uOpacity: { value: 0.62 } },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vPos;
        void main() {
          vUv = uv;
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uOpacity;
        varying vec2 vUv;
        varying vec3 vPos;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453123); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);
          float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
          vec2 u=f*f*(3.-2.*f);
          return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
        }
        void main() {
          float radial = abs(vUv.x - 0.5) * 2.0;
          float along = clamp(vUv.y, 0.0, 1.0);
          float n1 = noise(vec2(radial * 7.2, along * 15.5 - uTime * 3.7));
          float n2 = noise(vec2(vUv.x * 31.0 + uTime * 0.9, along * 7.2 - uTime * 2.4));
          float n3 = noise(vec2(vUv.x * 11.0 - uTime * 0.35, along * 18.0 + uTime * 1.1));
          float tear = (n1 - 0.5) * 0.68 + (n2 - 0.5) * 0.46;
          float edge = smoothstep(1.34, 0.035, radial + tear);
          float rootHot = 1.0 - smoothstep(0.00, 0.16, along);
          float rootBloom = 1.0 - smoothstep(0.00, 0.30, along);
          float tailFade = pow(1.0 - along, 0.20) * (1.0 - smoothstep(0.78, 1.0, along) * 0.78);
          float breakup = mix(1.0, smoothstep(0.58, 0.98, n3), smoothstep(0.22, 1.0, along));
          float core = smoothstep(0.135, 0.0, radial) * pow(1.0 - along, 0.58);
          float blueBody = edge * (1.0 - smoothstep(0.93, 1.0, along));
          float magentaGate = smoothstep(0.24, 0.44, along) * (1.0 - smoothstep(0.96, 1.0, along));
          float magentaRibbon = smoothstep(0.08, 0.84, radial) * edge * magentaGate * (0.34 + n2 * 1.38);
          float splitLines = smoothstep(0.44, 0.94, n2) * edge * magentaGate * (0.62 + n3 * 0.92);
          vec3 cCore = vec3(1.00, 1.00, 1.00);
          vec3 cHot  = vec3(0.58, 0.82, 1.00);
          vec3 cMid  = vec3(0.00, 0.22, 1.00);
          vec3 cDeep = vec3(0.00, 0.02, 0.54);
          vec3 cEdge = vec3(0.78, 0.00, 1.00);
          vec3 cPink = vec3(1.00, 0.00, 0.78);
          vec3 cTail = vec3(0.00, 0.00, 0.16);
          vec3 col = mix(cTail, cDeep, edge);
          col = mix(col, cMid, blueBody * 0.86);
          col = mix(col, cEdge, magentaRibbon * 0.52);
          col = mix(col, cPink, splitLines * 0.34);
          col = mix(col, cHot, rootBloom * edge * 0.38);
          col = mix(col, cCore, clamp(core * 0.62 + rootHot * 0.18, 0.0, 1.0));
          col *= 3.25;
          float alpha = (edge * 0.42 + core * 0.62 + magentaRibbon * 0.86 + splitLines * 0.68) * tailFade * breakup;
          alpha *= 0.56 + n1 * 0.62;
          gl_FragColor = vec4(col, alpha * uOpacity);
        }
      `,
    });
  }

  _addExhaustRig() {
    if (this.exhaustGroup) return;
    // High-detail propulsion, constrained to two real nacelle anchors. It deliberately
    // restores structured engine motion without reintroducing any saucer/HUD overlays.
    this.exhaustGroup = new THREE.Group();
    this.exhaustGroup.name = 'High-detail dual nacelle propulsion rig';
    this.exhaustNiagaraLayers = { EnergyCore: new THREE.Group(), Thrusters: new THREE.Group(), Particulates: new THREE.Group() };
    Object.values(this.exhaustNiagaraLayers).forEach((group) => this.exhaustGroup.add(group));
    this.exhaustCoreMaterials = [];
    this.exhaustTailMaterials = [];
    this.plasmaFilamentMaterials = [];
    this.particlePlumeMaterials = [];
    const ports = [[-4.00, 3.20, -4.50], [-4.00, -3.20, -4.50]];
    ports.forEach(([x, y, z], idx) => {
      const scale = idx === 0 ? 0.72 : 1.0;
      const width = idx === 0 ? 0.76 : 1.08;
      const coreMat = new THREE.MeshBasicMaterial({ color: 0xe5f8ff, transparent: true, opacity: 0.96, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.20 * scale, 16, 10), coreMat);
      core.name = `High-detail nacelle hot core ${idx + 1}`;
      core.position.set(x, y, z - 0.05);
      core.renderOrder = 22;
      this.exhaustNiagaraLayers.EnergyCore.add(core);
      this.exhaustCoreMaterials.push(coreMat);

      // The two purple flipbook flame sheets and matching filaments previously added
      // here are deliberately omitted. Keep propulsion anchored as compact white-blue
      // cores plus particle detail, without flames through the middle of the hull.

      // No synthetic purple particle trails: the original GLB's engine surfaces and
      // compact core above provide the intended high-detail read without loose sparks.
    });
    (this.ship || this.anchor || this.scene).add(this.exhaustGroup);
    this.exhaustGroup.userData.boundToShip = !!this.ship;
    this.exhaustGroup.userData.weiyanVersion = 'high-detail-dual-nacelle-v1';
    this.exhaustGroup.userData.niagaraEmitters = ['dual-core'];
    this.exhaustGroup.userData.atmosphericEffects = true;
  }

  _makeGlowSprite(r = 115, g = 205, b = 255, size = 0.7, opacity = 0.8) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0.00, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.18, `rgba(${r},${g},${b},0.95)`);
    gradient.addColorStop(0.56, `rgba(${r},${g},${b},0.32)`);
    gradient.addColorStop(1.00, 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity, blending: THREE.NormalBlending, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(size, size, 1);
    return sprite;
  }


  _makeExhaustRibbonTexture() {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 192;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const grad = ctx.createLinearGradient(0, 0, canvas.width, 0);
    grad.addColorStop(0.00, 'rgba(255,255,255,0.96)');
    grad.addColorStop(0.10, 'rgba(120,205,255,0.86)');
    grad.addColorStop(0.34, 'rgba(0,60,255,0.74)');
    grad.addColorStop(0.62, 'rgba(235,0,255,0.78)');
    grad.addColorStop(0.82, 'rgba(255,0,210,0.58)');
    grad.addColorStop(1.00, 'rgba(0,0,0,0.00)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(0, 96);
    ctx.bezierCurveTo(120, 24, 320, 28, 1024, 82);
    ctx.lineTo(1024, 112);
    ctx.bezierCurveTo(320, 166, 120, 168, 0, 96);
    ctx.closePath();
    ctx.fill();

    // torn plasma streaks: magenta/blue irregular filaments fading down the tail
    ctx.globalCompositeOperation = 'lighter';
    const streaks = [
      ['rgba(255,80,220,0.55)', 0.54, 0.18, 22],
      ['rgba(80,150,255,0.60)', 0.44, -0.14, 18],
      ['rgba(190,50,255,0.46)', 0.66, 0.06, 14],
      ['rgba(255,255,255,0.58)', 0.20, 0.00, 10],
    ];
    streaks.forEach(([color, start, offset, width], i) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const sx = canvas.width * start;
      const sy = 96 + offset * 96;
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(sx + 120, sy - 18 - i * 3, 820, sy + 30 - i * 8, 1010, sy + 4);
      ctx.stroke();
    });

    // Punch irregular holes mostly in the back half so the tail breaks apart instead of ending as a clean sheet.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 72; i += 1) {
      const t = i / 71;
      const x = 470 + t * 520 + Math.sin(i * 2.17) * 26;
      const y = 96 + Math.sin(i * 1.73) * (22 + t * 42);
      const rx = 12 + t * 48 + (i % 3) * 7;
      const ry = 5 + t * 24 + (i % 4) * 3;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, Math.sin(i) * 0.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Add separated tail shards after the holes: blue/pink fragments that fade into space.
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 30; i += 1) {
      const t = i / 29;
      const x = 560 + t * 450;
      const y = 96 + Math.sin(i * 1.31) * (30 + t * 36);
      const len = 58 - t * 34;
      ctx.strokeStyle = i % 2 === 0 ? `rgba(80,150,255,${0.34 - t * 0.18})` : `rgba(255,55,205,${0.30 - t * 0.16})`;
      ctx.lineWidth = 8 - t * 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + len, y + Math.sin(i * 0.9) * 12);
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    return texture;
  }

  _makeExhaustRibbonMesh(length = 9.4, width = 1.15) {
    if (!this.exhaustRibbonTexture) this.exhaustRibbonTexture = this._makeExhaustRibbonTexture();
    const mat = new THREE.MeshBasicMaterial({
      map: this.exhaustRibbonTexture,
      transparent: true,
      opacity: 0.24,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const geo = new THREE.PlaneGeometry(length, width, 1, 1);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
  }

  _getWeiyanTexture(name = 'T_Noise.png') {
    if (!this.weiyanTextures) this.weiyanTextures = new Map();
    if (this.weiyanTextures.has(name)) return this.weiyanTextures.get(name);
    const texture = new THREE.TextureLoader().load(`/globe/weiyan/${name}`);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.weiyanTextures.set(name, texture);
    return texture;
  }

  _makeWeiyanTexturedSprite(textureName = 'T_Smoke_Grunge.png', r = 115, g = 205, b = 255, opacity = 0.55, additive = false) {
    const texture = this._getWeiyanTexture(textureName);
    const material = new THREE.SpriteMaterial({
      // weiyan9c: extracted UE textures have black RGB backgrounds but no useful alpha.
      // Reuse the brightness channel as alpha so black tiles are cut out instead of rendered.
      map: texture,
      alphaMap: textureName.includes('Alpha') ? null : texture,
      alphaTest: textureName.includes('Alpha') ? 0.025 : (textureName.includes('Smoke') ? 0.085 : 0.045),
      color: new THREE.Color(r / 255, g / 255, b / 255),
      transparent: true,
      opacity,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
    });
    material.userData.weiyan9cAlphaMasked = true;
    material.userData.weiyan9dRgbaSmoke = textureName.includes('Alpha');
    material.userData.alphaCut = material.alphaTest;
    material.userData.textureName = textureName;
    material.userData.ueNiagaraExtracted = true;
    material.userData.assetPath = `/globe/weiyan/${textureName}`;
    const sprite = new THREE.Sprite(material);
    sprite.frustumCulled = false;
    sprite.raycast = () => {};
    return sprite;
  }

  _makeProceduralExhaustFlipbookTexture() {
    if (this.exhaustFlipbookTexture) return this.exhaustFlipbookTexture;
    const grid = 4;
    const cell = 256;
    const canvas = document.createElement('canvas');
    canvas.width = cell * grid;
    canvas.height = cell * grid;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const noise = (n) => {
      const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453123;
      return x - Math.floor(x);
    };
    for (let frame = 0; frame < grid * grid; frame += 1) {
      const ox = (frame % grid) * cell;
      const oy = Math.floor(frame / grid) * cell;
      const ph = frame / (grid * grid);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.globalCompositeOperation = 'lighter';

      const g = ctx.createLinearGradient(8, cell * 0.5, cell - 10, cell * 0.5);
      g.addColorStop(0.00, 'rgba(238,252,255,0.95)');
      g.addColorStop(0.10, 'rgba(72,210,255,0.78)');
      g.addColorStop(0.34, 'rgba(20,90,255,0.52)');
      g.addColorStop(0.64, 'rgba(155,35,255,0.36)');
      g.addColorStop(0.86, 'rgba(255,42,194,0.20)');
      g.addColorStop(1.00, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(5, cell * 0.50);
      for (let i = 0; i <= 26; i += 1) {
        const t = i / 26;
        const amp = (16 + t * 48) * (1.0 - t * 0.22);
        const y = cell * 0.50 - (0.12 + Math.sin(t * 11 + ph * 6.283) * 0.05) * amp - noise(frame * 13 + i) * amp * 0.12;
        ctx.lineTo(7 + t * 238, y);
      }
      for (let i = 26; i >= 0; i -= 1) {
        const t = i / 26;
        const amp = (16 + t * 50) * (1.0 - t * 0.18);
        const y = cell * 0.50 + (0.20 + Math.cos(t * 9 + ph * 6.283) * 0.06) * amp + noise(frame * 19 + i) * amp * 0.14;
        ctx.lineTo(7 + t * 238, y);
      }
      ctx.closePath();
      ctx.fill();

      const streakColors = [
        'rgba(235,252,255,0.82)',
        'rgba(70,205,255,0.68)',
        'rgba(70,85,255,0.52)',
        'rgba(255,55,205,0.42)',
      ];
      for (let k = 0; k < 18; k += 1) {
        const t0 = noise(frame * 31 + k * 3) * 0.45;
        const len = 0.18 + noise(frame * 37 + k) * 0.42;
        const y = cell * (0.50 + (noise(frame * 41 + k) - 0.5) * (0.18 + t0 * 0.62));
        const x = cell * (0.05 + t0 + ph * 0.18) % (cell * 0.98);
        ctx.strokeStyle = streakColors[k % streakColors.length];
        ctx.lineWidth = 2 + noise(frame * 43 + k) * 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + cell * len * 0.34, y + Math.sin(k + ph * 8) * 10, x + cell * len * 0.72, y + Math.cos(k * 1.7 + ph * 7) * 18, x + cell * len, y + Math.sin(k * 2.1) * 8);
        ctx.stroke();
      }

      ctx.globalCompositeOperation = 'destination-out';
      for (let h = 0; h < 24; h += 1) {
        const t = h / 23;
        const x = cell * (0.28 + t * 0.66 + (noise(frame * 53 + h) - 0.5) * 0.08);
        const y = cell * (0.50 + (noise(frame * 59 + h) - 0.5) * (0.16 + t * 0.46));
        const rx = cell * (0.018 + t * 0.070 * noise(frame * 61 + h));
        const ry = cell * (0.010 + t * 0.046 * noise(frame * 67 + h));
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, Math.sin(h + frame) * 1.1, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    this.exhaustFlipbookTexture = texture;
    return texture;
  }

  _makeFlipbookExhaustMesh(length = 11.0, width = 1.2, phase = 0.0, opacity = 0.32) {
    const texture = this._makeProceduralExhaustFlipbookTexture();
    const geo = new THREE.PlaneGeometry(length, width, 1, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uMap: { value: texture },
        uNoiseMap: { value: this._getWeiyanTexture('T_Noise.png') },
        uParticulateMap: { value: this._getWeiyanTexture('T_Particulate.png') },
        uGrungeMap: { value: this._getWeiyanTexture('T_Smoke_Grunge.png') },
        uPhase: { value: phase },
        uOpacity: { value: opacity },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform sampler2D uMap;
        uniform sampler2D uNoiseMap;
        uniform sampler2D uParticulateMap;
        uniform sampler2D uGrungeMap;
        uniform float uPhase;
        uniform float uOpacity;
        varying vec2 vUv;
        vec4 sampleFrame(float f) {
          float frame = mod(f, 16.0);
          float col = mod(frame, 4.0);
          float row = floor(frame / 4.0);
          vec2 uv = vec2((vUv.x + col) / 4.0, (vUv.y + row) / 4.0);
          return texture2D(uMap, uv);
        }
        void main() {
          float frameF = mod(uTime * 15.0 + uPhase * 16.0, 16.0);
          float frame0 = floor(frameF);
          float frame1 = mod(frame0 + 1.0, 16.0);
          float blendT = smoothstep(0.12, 0.88, fract(frameF));
          vec4 tex = mix(sampleFrame(frame0), sampleFrame(frame1), blendT);
          float along = clamp(vUv.x, 0.0, 1.0);
          float cross = abs(vUv.y - 0.5) * 2.0;
          vec2 flowUv = vec2(along * 1.65 - uTime * 0.28 + uPhase, vUv.y * 1.35 + sin(along * 7.0 - uTime * 1.2) * 0.045);
          vec2 shredUv = vec2(along * 3.10 - uTime * 0.74 + uPhase * 1.7, vUv.y * 2.25 + uTime * 0.11);
          vec4 ueNoise = texture2D(uNoiseMap, flowUv);
          vec4 uePart = texture2D(uParticulateMap, shredUv);
          vec4 ueGrunge = texture2D(uGrungeMap, vec2(along * 1.10 - uTime * 0.13, vUv.y * 1.55 + uPhase));
          float root = 1.0 - smoothstep(0.0, 0.11, along);
          float tail = pow(1.0 - along, 0.30) * (1.0 - smoothstep(0.84, 1.0, along) * 0.92);
          float edgeSoft = 1.0 - smoothstep(0.22, 1.0, cross + along * 0.10);
          float hollow = 0.68 + 0.32 * smoothstep(0.10, 0.88, cross + along * 0.06);
          float ueBreak = smoothstep(0.18, 0.92, ueNoise.r * 0.58 + uePart.a * 0.62 + ueGrunge.r * 0.28);
          float sootBreak = mix(0.72, 1.18, ueBreak) * mix(1.0, smoothstep(0.32, 0.88, ueGrunge.g), smoothstep(0.18, 0.92, along));
          float alpha = tex.a * tail * (0.54 + root * 0.24) * edgeSoft * hollow * sootBreak * uOpacity;
          if (alpha < 0.012) discard;
          float white = min(min(tex.r, tex.g), tex.b);
          vec3 cyan = vec3(0.10, 0.84, 1.00);
          vec3 blue = vec3(0.00, 0.24, 1.00);
          vec3 violet = vec3(0.43, 0.05, 1.00);
          vec3 pink = vec3(1.00, 0.03, 0.72);
          vec3 emberBlue = mix(blue, cyan, ueNoise.b * 0.42 + root * 0.36);
          vec3 chroma = mix(emberBlue, violet, smoothstep(0.18, 0.72, along) * (0.46 + ueNoise.g * 0.42));
          chroma = mix(chroma, pink, smoothstep(0.44, 0.96, along) * (0.14 + cross * 0.48 + uePart.r * 0.22));
          chroma = mix(chroma, cyan, root * 0.42 + (1.0 - cross) * 0.12);
          vec3 colr = mix(tex.rgb, chroma, 0.50 + smoothstep(0.30, 0.90, white) * 0.28);
          colr *= (1.30 + root * 0.52 + ueBreak * 0.22);
          gl_FragColor = vec4(colr, alpha * 0.84);
        }
      `,
    });
    this.plasmaFilamentMaterials?.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
  }

  _makeWeiyanHeatHazeMesh(length = 7.0, width = 0.9, phase = 0.0) {
    const geo = new THREE.PlaneGeometry(length, width, 12, 3);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.NormalBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uHeatMap: { value: this._getWeiyanTexture('T_HeatHaze.png') },
        uNoiseMap: { value: this._getWeiyanTexture('T_Noise.png') },
        uPhase: { value: phase },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uPhase;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 p = position;
          float along = uv.x;
          float cross = uv.y - 0.5;
          float flutter = sin(along * 16.0 - uTime * 3.0 + uPhase * 11.0) * 0.020
                        + sin(along * 41.0 + cross * 9.0 - uTime * 7.0) * 0.010;
          p.y += flutter * (0.45 + along * 1.5);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform sampler2D uHeatMap;
        uniform sampler2D uNoiseMap;
        uniform float uPhase;
        varying vec2 vUv;
        void main() {
          float along = clamp(vUv.x, 0.0, 1.0);
          float cross = abs(vUv.y - 0.5) * 2.0;
          vec2 uv1 = vec2(along * 1.8 - uTime * 0.34 + uPhase, vUv.y * 1.15 + sin(along * 9.0 - uTime * 1.8) * 0.035);
          vec2 uv2 = vec2(along * 3.2 - uTime * 0.78 + uPhase * 1.6, vUv.y * 2.8 + uTime * 0.09);
          vec4 heat = texture2D(uHeatMap, uv1);
          vec4 noise = texture2D(uNoiseMap, uv2);
          float center = 1.0 - smoothstep(0.08, 1.0, cross + along * 0.05);
          float root = 1.0 - smoothstep(0.0, 0.16, along);
          float tail = pow(1.0 - along, 0.58) * (1.0 - smoothstep(0.72, 1.0, along) * 0.94);
          float turbulent = smoothstep(0.22, 0.86, heat.a * 0.55 + heat.r * 0.32 + noise.g * 0.42);
          float alpha = center * tail * turbulent * (0.040 + root * 0.030);
          if (alpha < 0.004) discard;
          vec3 col = mix(vec3(0.02, 0.18, 0.56), vec3(0.12, 0.82, 1.0), root * 0.42 + noise.b * 0.28);
          col = mix(col, vec3(0.80, 0.08, 1.0), smoothstep(0.36, 0.92, along) * noise.r * 0.34);
          gl_FragColor = vec4(col * (0.75 + turbulent * 0.45), alpha);
        }
      `,
    });
    this.plasmaFilamentMaterials?.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
  }

  _makeFluidVaporSheet(length = 11.0, width = 1.2, phase = 0.0) {
    const geo = new THREE.PlaneGeometry(length, width, 18, 5);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uPhase: { value: phase },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uPhase;
        varying vec2 vUv;
        varying float vWarp;
        void main() {
          vUv = uv;
          vec3 p = position;
          float along = uv.x;
          float cross = uv.y - 0.5;
          float wave = sin(along * 17.0 - uTime * 3.4 + uPhase * 9.0) * 0.045
                     + sin(along * 39.0 + cross * 8.0 - uTime * 7.2) * 0.022;
          p.y += wave * (0.25 + along * 1.25);
          p.z += sin(along * 22.0 + uPhase * 5.0 - uTime * 2.0) * 0.018 * along;
          vWarp = wave;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uPhase;
        varying vec2 vUv;
        varying float vWarp;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(101.3,271.9))) * 41758.5453); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);
          float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
          vec2 u=f*f*(3.-2.*f);
          return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
        }
        void main() {
          float along = clamp(vUv.x, 0.0, 1.0);
          float cross = abs(vUv.y - 0.5) * 2.0;
          float flowA = noise(vec2(along * 9.0 - uTime * 1.7 + uPhase * 3.0, vUv.y * 5.0));
          float flowB = noise(vec2(along * 27.0 - uTime * 5.1, vUv.y * 12.0 + uPhase * 7.0));
          float lane = smoothstep(0.45, 1.0, flowA * 0.72 + flowB * 0.48);
          float center = 1.0 - smoothstep(0.05, 0.96, cross + (flowB - 0.5) * 0.30);
          float packet = smoothstep(0.18, 0.86, sin(along * 51.0 - uTime * 11.0 + uPhase * 13.0) * 0.5 + 0.5);
          float tail = pow(1.0 - along, 0.36) * (1.0 - smoothstep(0.82, 1.0, along) * 0.92);
          float root = 1.0 - smoothstep(0.0, 0.13, along);
          float alpha = (lane * packet * 0.70 + root * 0.34) * center * tail;
          vec3 blue = vec3(0.00, 0.24, 1.00);
          vec3 cyan = vec3(0.30, 0.88, 1.00);
          vec3 pink = vec3(1.00, 0.02, 0.78);
          vec3 col = mix(blue, pink, smoothstep(0.28, 0.88, along) * (0.30 + flowB * 0.58));
          col = mix(col, cyan, center * (0.30 + root * 0.48));
          if (alpha < 0.018) discard;
          gl_FragColor = vec4(col * (1.55 + root * 1.45), alpha * 0.30);
        }
      `,
    });
    this.plasmaFilamentMaterials?.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
  }


  _addWeiyan4NozzleEmitter(parent, spec) {
    const { x, y, z, scale = 1, tint = [0.1, 0.62, 1.0], accent = [0.9, 0.05, 1.0], seed = 1, name = 'Nozzle' } = spec;
    const group = new THREE.Group();
    group.name = `weiyan4 ${name} UE-like nozzle emitter`;
    group.position.set(x, y, z);
    group.userData.kind = 'HotCore+VolumeSmoke+FlameSheet+Sparks';
    parent.add(group);

    const hot = this._makeGlowSprite(235, 250, 255, 1.0, 1.0);
    hot.name = `weiyan4 ${name} white-hot nozzle core`;
    hot.position.set(0, 0, 0.02);
    hot.scale.set(0.46 * scale, 0.30 * scale, 1);
    hot.renderOrder = 45;
    group.add(hot);

    const coreGeo = new THREE.CylinderGeometry(0.035 * scale, 0.18 * scale, 2.8 * scale, 32, 1, true);
    const coreMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uTint: { value: new THREE.Color(tint[0], tint[1], tint[2]) },
        uAccent: { value: new THREE.Color(accent[0], accent[1], accent[2]) },
        uSeed: { value: seed },
      },
      vertexShader: `
        varying vec2 vUv;
        varying float vRadial;
        void main(){
          vUv = uv;
          vRadial = clamp(length(position.xz) / 0.18, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime; uniform vec3 uTint; uniform vec3 uAccent; uniform float uSeed;
        varying vec2 vUv; varying float vRadial;
        float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7))) * 43758.5453);}
        float noise(vec2 p){vec2 i=floor(p),f=fract(p);float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));vec2 u=f*f*(3.-2.*f);return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;}
        void main(){
          float along = clamp(vUv.y,0.0,1.0);
          float n = noise(vec2(vUv.x*8.0+uSeed, along*18.0-uTime*4.0));
          float radial = 1.0 - smoothstep(0.04, 1.0, vRadial + (n-.5)*0.16);
          float root = 1.0 - smoothstep(0.0,0.28,along);
          float tail = pow(1.0-along,0.52) * (1.0-smoothstep(0.74,1.0,along)*0.9);
          float stripe = smoothstep(.62,1.0,n) * smoothstep(.18,.92,along);
          vec3 col = mix(uTint, uAccent, stripe*.42 + along*.22);
          col = mix(col, vec3(1.0), radial*.64 + root*.52);
          float alpha = (radial*.68 + root*.34 + stripe*.24) * tail;
          if(alpha < .018) discard;
          gl_FragColor = vec4(col*(2.2+root*2.6), alpha*.58);
        }
      `,
    });
    this.exhaustCoreMaterials?.push(coreMat);
    const core = new THREE.Mesh(coreGeo, coreMat);
    core.name = `weiyan4 ${name} narrow bright jet core`;
    core.rotation.x = -Math.PI / 2;
    core.position.z = -1.35 * scale;
    core.frustumCulled = false;
    core.raycast = () => {};
    group.add(core);

    const smokeCount = 16;
    for (let i = 0; i < smokeCount; i += 1) {
      const t = i / (smokeCount - 1);
      const spr = this._makeGlowSprite(
        Math.floor(40 + tint[0] * 150),
        Math.floor(70 + tint[1] * 145),
        Math.floor(110 + tint[2] * 120),
        1.0,
        (0.18 + (1.0 - t) * 0.18) * (1.0 - t * 0.55)
      );
      spr.name = `weiyan4 ${name} volume smoke puff ${i+1}`;
      const ang = i * 2.399 + seed;
      const spread = (0.10 + t * 0.70) * scale;
      spr.position.set(Math.cos(ang)*spread*0.55, Math.sin(ang)*spread*0.38, -t * 4.8 * scale);
      const sz = (0.44 + t * 1.22) * scale;
      spr.scale.set(sz * (1.15 + Math.sin(i)*0.18), sz * (0.82 + Math.cos(i*1.7)*0.18), 1);
      spr.renderOrder = 37;
      spr.frustumCulled = false;
      spr.raycast = () => {};
      group.add(spr);
    }

    const flame = this._makeFlipbookExhaustMesh(5.4 * scale, 1.25 * scale, seed * 0.137, 0.46);
    flame.name = `weiyan4 ${name} torn flame sheet using UE noise/grunge`;
    flame.position.set(0, 0, -2.35 * scale);
    flame.rotation.y = Math.PI / 2;
    flame.rotation.z = (seed % 2 ? 0.16 : -0.16);
    flame.renderOrder = 46;
    group.add(flame);

    const particles = this._makeParticlePlumeMesh({ x: 0, y: 0, z: 0, count: Math.floor(420 * scale), length: 5.8 * scale, radialScale: 0.34 * scale, brightness: 1.12, speed: 1.28, seed: 80 + seed, layer: 'sheath' });
    particles.name = `weiyan4 ${name} ejected sparks and plasma particulates`;
    particles.renderOrder = 47;
    group.add(particles);
    return group;
  }


  _addWeiyan5DualNacelleWarpTrails(parent) {
    if (!parent || parent.userData.weiyan5Added) return;
    const root = new THREE.Group();
    root.name = 'weiyan8 reference-matched vertical UE plume rig';
    root.userData.weiyan8 = true;
    const nacelles = [
      { name: 'upper-nacelle', x: -6.42, y: 10.48, z: -15.50, scale: 0.72, width: 1.05, seed: 71, variant: 'cyan-violet' },
      { name: 'lower-nacelle', x: -5.86, y: 1.26, z: -20.20, scale: 1.05, width: 1.42, seed: 82, variant: 'large-cyan-purple' },
    ];
    const rand = (n) => {
      const v = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
      return v - Math.floor(v);
    };
    nacelles.forEach(({ name, x, y, z, scale, width, seed, variant }, idx) => {
      const group = new THREE.Group();
      group.name = `weiyan8 ${name} reference UE plume emitter`;
      group.position.set(x, y, z);
      group.rotation.y = 0;
      group.rotation.z = idx === 0 ? -0.08 : -0.04;
      root.add(group);

      // Dark ribbed nozzle proxy like the reference cylinders: visible enough to give plume an origin.
      const nozzleMat = new THREE.MeshStandardMaterial({
        color: 0x080c14,
        metalness: 0.72,
        roughness: 0.38,
        emissive: idx === 0 ? 0x12304a : 0x20124a,
        emissiveIntensity: 0.34,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      });
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.28 * width, 0.33 * width, 0.62 * scale, 28, 1, true), nozzleMat);
      nozzle.name = `weiyan8 ${name} dark ribbed nozzle silhouette`;
      nozzle.position.set(0, 0, 0.10 * scale);
      nozzle.rotation.x = Math.PI / 2;
      nozzle.renderOrder = 73;
      nozzle.raycast = () => {};
      group.add(nozzle);

      // Hot core: compact white/cyan root, brightest at the nozzle.
      const hot = this._makeGlowSprite(255, 255, 255, 1.0, idx === 0 ? 1.62 : 1.86);
      hot.name = `weiyan9e ${name} intensified white-blue HotCore root bloom`;
      hot.position.set(0, 0, -0.22 * scale);
      hot.scale.set(0.86 * width, 0.52 * width, 1);
      hot.renderOrder = 82;
      hot.frustumCulled = false;
      hot.raycast = () => {};
      group.add(hot);

      for (let k = 0; k < (idx === 0 ? 5 : 7); k += 1) {
        const part = this._makeWeiyanTexturedSprite('T_Particulate.png', 235, 248, 255, 0.48 + k * 0.026, true);
        part.name = `weiyan9 ${name} extracted particulate hot speckle ${k + 1}`;
        part.position.set((rand(seed + k * 13.1) - 0.5) * 0.34 * width, (rand(seed + k * 17.7) - 0.5) * 0.34 * width, -(0.22 + k * 0.17) * scale);
        part.scale.set((0.24 + k * 0.035) * width, (0.20 + k * 0.030) * width, 1);
        part.renderOrder = 85;
        group.add(part);
      }

      const coreColumn = this._makeFlipbookExhaustMesh(3.10 * scale, 0.34 * width, seed * 0.011, 0.96);
      coreColumn.name = `weiyan9e ${name} extended narrow white-blue core column`;
      coreColumn.position.set(0, 0, -1.16 * scale);
      coreColumn.rotation.y = Math.PI / 2;
      coreColumn.rotation.z = idx === 0 ? 0.03 : -0.02;
      coreColumn.renderOrder = 81;
      group.add(coreColumn);

      const coreNeedle = this._makeFlipbookExhaustMesh(3.85 * scale, 0.18 * width, seed * 0.017 + 0.18, 0.72);
      coreNeedle.name = `weiyan9e ${name} razor white inner core needle`;
      coreNeedle.position.set(0, idx === 0 ? 0.015 : -0.015, -1.42 * scale);
      coreNeedle.rotation.y = Math.PI / 2;
      coreNeedle.rotation.z = idx === 0 ? -0.015 : 0.018;
      coreNeedle.renderOrder = 86;
      group.add(coreNeedle);

      // Thick stacked plume: bulbous near middle, dissipating at the tail like the reference gallery image.
      const smokeCount = idx === 0 ? 12 : 17;
      for (let i = 0; i < smokeCount; i += 1) {
        const t = i / Math.max(1, smokeCount - 1);
        const bulb = Math.sin(Math.PI * Math.min(1, t * 1.08));
        const jitterX = (rand(seed + i * 3.7) - 0.5) * width * (0.10 + t * 0.55);
        const jitterY = (rand(seed + i * 9.1) - 0.5) * width * (0.12 + t * 0.62);
        const colors = variant === 'large-cyan-purple'
          ? [[210,250,255], [74,210,255], [86,92,255], [190,66,255]]
          : [[235,252,255], [96,225,255], [80,112,255], [230,80,225]];
        const c = colors[i % colors.length];
        const op = (0.28 + (1 - t) * 0.30) * (idx === 0 ? 0.72 : 0.82);
        const puff = this._makeWeiyanTexturedSprite('T_Smoke_Grunge_Alpha.png', c[0], c[1], c[2], op * 0.92, false);
        puff.name = `weiyan8 ${name} thick reference VolumeSmoke puff ${i + 1}`;
        puff.position.set(jitterX, jitterY, -(0.52 + Math.pow(t, 0.82) * 4.85) * scale);
        const spread = (0.48 + bulb * 1.05 + t * 0.58) * width;
        puff.scale.set(spread * (0.78 + rand(seed + i) * 0.26), spread * (0.54 + rand(seed + i * 2) * 0.30), 1);
        puff.material.opacity *= 1.0 - t * 0.18;
        puff.renderOrder = 72 - i * 0.01;
        puff.frustumCulled = false;
        puff.raycast = () => {};
        group.add(puff);

        const softPuff = this._makeGlowSprite(c[0], c[1], c[2], 1.0, op * 0.025);
        softPuff.name = `weiyan9f ${name} sparse reduced soft underlay ${i + 1}`;
        softPuff.position.copy(puff.position);
        softPuff.scale.copy(puff.scale).multiplyScalar(0.92);
        softPuff.renderOrder = 69 - i * 0.01;
        softPuff.frustumCulled = false;
        softPuff.raycast = () => {};
        group.add(softPuff);
      }

      // Torn flame sheets: narrow bright tongues embedded in the smoke, not long warp ribbons.
      const tongueA = this._makeFlipbookExhaustMesh(4.85 * scale, 0.46 * width, seed * 0.019 + 0.31, 0.62);
      tongueA.name = `weiyan9e ${name} longer torn FlameSheet cyan-magenta tongue A`;
      tongueA.position.set(0, idx === 0 ? 0.045 : -0.045, -1.72 * scale);
      tongueA.rotation.y = Math.PI / 2;
      tongueA.rotation.z = idx === 0 ? 0.44 : -0.40;
      tongueA.renderOrder = 80;
      group.add(tongueA);

      const tongueB = this._makeFlipbookExhaustMesh(4.15 * scale, 0.30 * width, seed * 0.027 + 0.73, 0.54);
      tongueB.name = `weiyan9e ${name} longer torn FlameSheet violet inner tongue B`;
      tongueB.position.set(0, idx === 0 ? -0.075 : 0.09, -1.48 * scale);
      tongueB.rotation.y = Math.PI / 2;
      tongueB.rotation.z = idx === 0 ? -0.62 : 0.56;
      tongueB.renderOrder = 83;
      group.add(tongueB);

      const tongueC = this._makeFlipbookExhaustMesh(4.45 * scale, 0.20 * width, seed * 0.033 + 0.57, 0.44);
      tongueC.name = `weiyan9e ${name} thin torn white-cyan lick C`;
      tongueC.position.set(0, idx === 0 ? 0.16 : -0.15, -1.88 * scale);
      tongueC.rotation.y = Math.PI / 2;
      tongueC.rotation.z = idx === 0 ? 0.18 : -0.16;
      tongueC.renderOrder = 84;
      group.add(tongueC);

      const tongueD = this._makeFlipbookExhaustMesh(3.25 * scale, 0.18 * width, seed * 0.041 + 0.22, 0.34);
      tongueD.name = `weiyan9f ${name} asymmetric forked cyan branch D`;
      tongueD.position.set(0, idx === 0 ? -0.22 : 0.20, -2.18 * scale);
      tongueD.rotation.y = Math.PI / 2;
      tongueD.rotation.z = idx === 0 ? -0.32 : 0.30;
      tongueD.renderOrder = 79;
      group.add(tongueD);

      const tongueE = this._makeFlipbookExhaustMesh(2.85 * scale, 0.15 * width, seed * 0.047 + 0.84, 0.28);
      tongueE.name = `weiyan9f ${name} faint violet fork branch E`;
      tongueE.position.set(0, idx === 0 ? 0.30 : -0.28, -2.55 * scale);
      tongueE.rotation.y = Math.PI / 2;
      tongueE.rotation.z = idx === 0 ? 0.46 : -0.42;
      tongueE.renderOrder = 78;
      group.add(tongueE);

      const sparks = this._makeParticlePlumeMesh({
        x: 0,
        y: 0,
        z: -0.20 * scale,
        count: idx === 0 ? 860 : 1260,
        length: 4.85 * scale,
        radialScale: 0.62 * width,
        brightness: 1.02,
        speed: 0.78,
        seed,
        layer: 'reference-sparks',
      });
      sparks.name = `weiyan8 ${name} reference white-blue-violet Sparks`; 
      sparks.renderOrder = 84;
      group.add(sparks);
    });
    parent.add(root);
    parent.userData.weiyan5Added = true;
    this.weiyan5Root = root;
  }

  _addWeiyan4FiveNozzleVolumePlumes(parent) {
    if (!parent || parent.userData.weiyan4Added) return;
    const root = new THREE.Group();
    root.name = 'weiyan4 five UE-reference nozzle volume plume rig';
    root.userData.weiyan4 = true;
    const specs = [
      { name: 'port-outer-warm-trim', x: -0.58, y: 0.00, z: 0.20, scale: 0.38, tint: [1.00,0.40,0.06], accent: [1.00,0.78,0.12], seed: 11 },
      { name: 'port-cyan-engine', x: -0.30, y: 0.00, z: 0.10, scale: 0.46, tint: [0.04,0.86,1.00], accent: [0.78,1.00,1.00], seed: 22 },
      { name: 'center-white-pink-engine', x: 0.00, y: 0.00, z: 0.02, scale: 0.42, tint: [0.90,0.90,1.00], accent: [1.00,0.10,0.78], seed: 33 },
      { name: 'starboard-violet-engine', x: 0.30, y: 0.00, z: 0.10, scale: 0.48, tint: [0.08,0.28,1.00], accent: [1.00,0.06,0.82], seed: 44 },
      { name: 'starboard-large-cyan-violet', x: 0.62, y: 0.00, z: 0.20, scale: 0.54, tint: [0.02,0.72,1.00], accent: [0.54,0.04,1.00], seed: 55 },
    ];
    specs.forEach(spec => this._addWeiyan4NozzleEmitter(root, spec));
    // Anchor at the real rear of the normalized GLB: raw model length is Y -5.916..20.316.
    // Local emitters build their plume down -Z, so rotate the rig so plume direction becomes model -Y.
    root.position.set(0.00, -6.05, -1.95);
    root.scale.set(1.05, 1.05, 1.05);
    root.rotation.x = -Math.PI / 2;
    root.rotation.z = -0.03;
    parent.add(root);
    parent.userData.weiyan4Added = true;
    this.weiyan4Root = root;
  }

  _makeParticlePlumeMesh({ x = 0, y = 0, z = 0, count = 1000, length = 12, radialScale = 1, brightness = 1, speed = 0.7, seed = 1, layer = 'core' } = {}) {
    const layerId = layer === 'nearfield' ? 0 : (layer === 'core' ? 1 : (layer === 'sheath' ? 2 : 3));
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    const angles = new Float32Array(count);
    const radii = new Float32Array(count);
    const rand = (n) => {
      const v = Math.sin(n * 12.9898 + seed * 78.233) * 43758.5453123;
      return v - Math.floor(v);
    };
    for (let i = 0; i < count; i += 1) {
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      seeds[i] = rand(i * 3.17 + 1.0);
      angles[i] = rand(i * 5.91 + 2.0) * Math.PI * 2;
      const rr = rand(i * 7.77 + 8.0);
      radii[i] = layerId === 1 ? Math.pow(rr, 3.6) : (layerId === 0 ? Math.pow(rr, 1.8) : Math.pow(rr, 0.58));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    geo.setAttribute('aAngle', new THREE.BufferAttribute(angles, 1));
    geo.setAttribute('aRadius', new THREE.BufferAttribute(radii, 1));
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uLength: { value: length },
        uRadialScale: { value: radialScale },
        uBrightness: { value: brightness },
        uSpeed: { value: speed },
        uLayer: { value: layerId },
      },
      vertexShader: `
        uniform float uTime;
        uniform float uLength;
        uniform float uRadialScale;
        uniform float uBrightness;
        uniform float uSpeed;
        uniform float uLayer;
        attribute float aSeed;
        attribute float aAngle;
        attribute float aRadius;
        varying float vAlpha;
        varying vec3 vColor;
        varying float vLayer;
        float hash(float n){ return fract(sin(n) * 43758.5453123); }
        void main() {
          float layer = uLayer;
          float speedMul = layer < 0.5 ? 1.18 : (layer < 1.5 ? 1.00 : (layer < 2.5 ? 0.66 : 0.42));
          float t = fract(aSeed + uTime * uSpeed * speedMul);
          float packet = layer < 0.5
            ? smoothstep(0.32, 1.0, sin(t * 52.0 + aSeed * 37.0) * 0.5 + 0.5)
            : (layer < 1.5
              ? smoothstep(0.36, 1.0, sin(t * 112.0 + aSeed * 49.0) * 0.5 + 0.5)
              : (layer < 2.5
                ? smoothstep(0.30, 1.0, sin(t * 74.0 + aSeed * 61.0) * 0.5 + 0.5)
                : smoothstep(0.42, 1.0, sin(t * 39.0 + aSeed * 83.0) * 0.5 + 0.5)));
          float root = 1.0 - smoothstep(0.00, layer < 0.5 ? 0.72 : 0.10, t);
          float tailFade = layer < 0.5
            ? (1.0 - smoothstep(0.62, 1.0, t))
            : (pow(1.0 - t, layer < 1.5 ? 0.46 : 0.30) * (1.0 - smoothstep(layer < 2.5 ? 0.82 : 0.66, 1.0, t) * (layer < 2.5 ? 0.82 : 0.94)));
          float pinch = layer < 0.5 ? 0.14 : (layer < 1.5 ? 0.10 : 0.22);
          float expand = smoothstep(0.04, layer < 2.5 ? 0.34 : 0.58, t);
          float taper = pow(1.0 - t, layer < 1.5 ? 0.92 : (layer < 2.5 ? 0.48 : 0.18));
          float bulge = layer < 0.5 ? 0.20 * exp(-pow((t - 0.18) / 0.18, 2.0)) : (layer < 2.5 ? 0.22 * exp(-pow((t - 0.34) / 0.24, 2.0)) : 0.0);
          float envelope = (pinch + expand * taper + bulge) * uRadialScale;
          if (layer > 2.5) envelope = (0.18 + t * 0.62) * pow(1.0 - t, 0.20) * uRadialScale;
          float swirlRate = layer < 1.5 ? 1.2 : (layer < 2.5 ? 6.4 : 3.0);
          float swirl = aAngle + t * swirlRate + sin(t * 18.0 + aSeed * 11.0) * (layer < 1.5 ? 0.08 : 0.55);
          float lateral = aRadius * envelope;
          float shear = smoothstep(0.18, 1.0, t) * (layer < 1.5 ? 0.010 : (layer < 2.5 ? 0.052 : 0.082)) * uRadialScale;
          vec3 p = position;
          p.z -= t * uLength;
          p.x += cos(swirl) * lateral + sin(t * 23.0 + aSeed * 19.0) * shear;
          p.y += sin(swirl) * lateral * (layer < 1.5 ? 0.58 : 0.82) + cos(t * 17.0 + aSeed * 29.0) * shear * 0.72;
          vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
          float baseSize = layer < 0.5 ? 2.6 : (layer < 1.5 ? 1.85 : (layer < 2.5 ? 2.8 : 1.65));
          gl_PointSize = baseSize * (1.18 - t * (layer < 2.5 ? 0.62 : 0.28)) * (300.0 / max(80.0, -mvPosition.z));
          gl_Position = projectionMatrix * mvPosition;
          vec3 cyan = vec3(0.16, 0.78, 1.00);
          vec3 blue = vec3(0.00, 0.30, 1.00);
          vec3 deep = vec3(0.03, 0.05, 0.58);
          vec3 violet = vec3(0.34, 0.04, 1.00);
          vec3 mag = vec3(1.00, 0.00, 0.82);
          vec3 nearCol = mix(cyan, vec3(0.48, 0.95, 1.0), root * 0.32 + (1.0 - aRadius) * 0.22);
          vec3 coreCol = mix(blue, cyan, (1.0 - aRadius) * 0.70);
          vec3 sheathCol = mix(violet, mag, smoothstep(0.18, 0.82, t) * (0.34 + aRadius * 0.78));
          vec3 tailCol = mix(violet, deep, t * 0.86);
          vColor = layer < 0.5 ? nearCol : (layer < 1.5 ? coreCol : (layer < 2.5 ? sheathCol : tailCol));
          float alphaBase = layer < 0.5 ? 0.92 : (layer < 1.5 ? 0.82 : (layer < 2.5 ? 0.68 : 0.42));
          vAlpha = tailFade * packet * alphaBase * uBrightness * (0.55 + (1.0 - aRadius) * 0.78);
          vLayer = layer;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        varying float vLayer;
        void main() {
          vec2 p = gl_PointCoord - vec2(0.5);
          float d = length(p) * 2.0;
          float core = 1.0 - smoothstep(0.0, 0.32, d);
          float glow = 1.0 - smoothstep(0.20, 1.0, d);
          float alpha = (core * 0.96 + glow * (vLayer < 0.5 ? 0.10 : 0.035)) * vAlpha;
          if (alpha < 0.012) discard;
          vec3 col = mix(vColor, vec3(0.42, 0.92, 1.0), core * (vLayer < 1.5 ? 0.18 : 0.02));
          gl_FragColor = vec4(col * (1.85 + core * 1.70), alpha * 0.72);
        }
      `,
    });
    this.particlePlumeMaterials?.push(mat);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    points.raycast = () => {};
    return points;
  }

  _makePlasmaFilamentMesh(length = 10.8, width = 0.6, phase = 0.0, intensity = 1.0) {
    const geo = new THREE.PlaneGeometry(length, width, 1, 1);
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      uniforms: {
        uTime: { value: 0 },
        uPhase: { value: phase },
        uIntensity: { value: intensity },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform float uPhase;
        uniform float uIntensity;
        varying vec2 vUv;
        float hash(vec2 p){ return fract(sin(dot(p, vec2(41.7,289.3))) * 11943.5453); }
        float noise(vec2 p){
          vec2 i=floor(p), f=fract(p);
          float a=hash(i), b=hash(i+vec2(1.,0.)), c=hash(i+vec2(0.,1.)), d=hash(i+vec2(1.,1.));
          vec2 u=f*f*(3.-2.*f);
          return mix(a,b,u.x)+(c-a)*u.y*(1.-u.x)+(d-b)*u.x*u.y;
        }
        void main() {
          float along = clamp(vUv.x, 0.0, 1.0);
          float cross = abs(vUv.y - 0.5) * 2.0;
          float flow = along * 42.0 - uTime * 13.0 + uPhase * 17.0;
          float shear = sin(flow + sin(along * 10.0 + uPhase) * 1.4);
          float shear2 = sin(along * 76.0 - uTime * 19.0 + uPhase * 29.0);
          float n = noise(vec2(along * 18.0 - uTime * 4.5, cross * 8.0 + uPhase * 3.0));
          float lane = smoothstep(0.82, 1.0, shear * 0.5 + 0.5);
          float lane2 = smoothstep(0.90, 1.0, shear2 * 0.5 + 0.5) * 0.55;
          float center = 1.0 - smoothstep(0.05, 0.92, cross + (n - 0.5) * 0.22);
          float root = 1.0 - smoothstep(0.00, 0.16, along);
          float tail = pow(1.0 - along, 0.32) * (1.0 - smoothstep(0.80, 1.0, along) * 0.82);
          float broken = mix(1.0, smoothstep(0.28, 0.92, n), smoothstep(0.30, 1.0, along));
          float alpha = (lane + lane2 + root * 0.42) * center * tail * broken * uIntensity;
          vec3 blue = vec3(0.00, 0.26, 1.00);
          vec3 cyan = vec3(0.34, 0.86, 1.00);
          vec3 mag = vec3(1.00, 0.00, 0.86);
          vec3 white = vec3(1.00, 1.00, 1.00);
          vec3 col = mix(blue, mag, smoothstep(0.30, 0.88, along) * (0.35 + lane2));
          col = mix(col, cyan, center * 0.42);
          col = mix(col, white, root * 0.46 + lane * center * 0.16);
          gl_FragColor = vec4(col * (1.65 + lane * 1.15), alpha * 0.46);
        }
      `,
    });
    this.plasmaFilamentMaterials?.push(mat);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    return mesh;
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
    if (this.exhaustGroup) {
      if (this.exhaustGroup.parent === this.ship || this.exhaustGroup.parent === this.anchor) {
        this.exhaustGroup.position.set(0, 0, 0);
        this.exhaustGroup.rotation.set(0, 0, 0);
        this.exhaustGroup.scale.set(1, 1, 1);
      } else {
        this.exhaustGroup.position.copy(this.anchor.position);
        this.exhaustGroup.rotation.copy(this.anchor.rotation);
        this.exhaustGroup.scale.copy(this.anchor.scale);
      }
      const propulsionPulse = 0.5 + 0.5 * Math.sin(t * 4.0);
      this.exhaustCoreMaterials?.forEach((mat) => { mat.opacity = 0.76 + propulsionPulse * 0.18; });
      this.exhaustTailMaterials?.forEach((mat) => {
        if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t;
        if ('opacity' in (mat || {})) mat.opacity = 0.46 + propulsionPulse * 0.20;
      });
      this.plasmaFilamentMaterials?.forEach((mat) => { if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t; });
      this.particlePlumeMaterials?.forEach((mat) => { if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t; });
      this.exhaustGroup.userData.liveLayerCounts = Object.fromEntries(Object.entries(this.exhaustNiagaraLayers || {}).map(([k, g]) => [k, g.children.length]));
      this._dbgSet('starshipPropulsionPulse', Number(propulsionPulse.toFixed(3)));
    }
    const coilPulse = 0.50 + 0.50 * Math.sin(t * 3.2);
    this.ship?.traverse?.((obj) => {
      if (!obj.isMesh || !obj.material) return;
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((mat) => {
        if (/warp[_-]?coils?|warpcoil/i.test(`${mat.name || ''} ${obj.name || ''}`) && 'emissiveIntensity' in mat) {
          mat.emissiveIntensity = 1.55 + coilPulse * 0.85;
        }
      });
    });
    this._dbgSet('starshipWarpPulse', Number(coilPulse.toFixed(3)));
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
