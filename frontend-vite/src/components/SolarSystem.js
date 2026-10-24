import * as THREE from 'three';
import { physicalToDisplay } from './solar/CoordinateMapper.js';
import { loadP1Ephemerides } from './solar/EphemerisProvider.js';
import { advanceOrbitalBodies, advanceSimulationTime, hasGenericOrbitRing, updateEphemerisTargets } from './solar/SolarEphemerisRuntime.js';
import { createContinuousEphemerisProviders } from './solar/TwoBodyEphemeris.js';
import { DustTailRenderer } from './solar/DustTailRenderer.js';
import { DustTailManager } from './solar/DustTailManager.js';
import { TEXTURE_MANIFEST_URL, fetchTextureManifest, remapRingToPolarUv, resolveTierAsset, threeColorSpace } from './solar/PlanetTextureLoader.js';

// Solar system widget: real orbital revolution, keyboard-reachable bodies,
// a single rAF loop that also drives the camera approach tween.

const MOBILE_QUERY = '(max-width: 720px)';
const HOME_FOV = 52;
const TARGET_RADIUS = (19 + 2.6 + 1.25) * 1.1;
const MOON_DISPLAY_UNITS_PER_AU = 1089.68;

// name, radius, orbital radius, angular speed (rad/s), colour, mobile-only-drop flag.
// roughness/metalness follow the P3-B material table: rocky bodies are pure
// diffuse (0.95/0), Venus' sulphuric haze 0.90/0, Earth keeps a faint ocean
// sheen (0.65/0.05) and the gas giants stay soft-banded (0.75/0).
export const PLANET_TABLE = [
  { name: 'Mercury', radius: 0.7, orbit: 9, speed: 0.62, color: 0x9c8a7a, tilt: 0.001, mobile: false, roughness: 0.95, metalness: 0, legibilityEmissive: 0.22 },
  { name: 'Venus', radius: 1.1, orbit: 13.5, speed: 0.44, color: 0xd8a05a, tilt: 3.096, mobile: true, roughness: 0.90, metalness: 0, legibilityEmissive: 0 },
  { name: 'Earth', radius: 1.25, orbit: 19, speed: 0.31, color: 0x3f7fd8, tilt: 0.409, mobile: true, roughness: 0.65, metalness: 0.05, legibilityEmissive: 0 },
  { name: 'Mars', radius: 0.95, orbit: 25, speed: 0.24, color: 0xc1552f, tilt: 0.440, mobile: true, roughness: 0.95, metalness: 0, legibilityEmissive: 0.16 },
  { name: 'Jupiter', radius: 2.4, orbit: 33, speed: 0.14, color: 0xd2a679, tilt: 0.055, mobile: false, ring: [3.0, 4.13], roughness: 0.75, metalness: 0, legibilityEmissive: 0.82 },
  { name: 'Saturn', radius: 2.0, orbit: 41, speed: 0.10, color: 0xe0cba0, tilt: 0.466, mobile: false, ring: [2.6, 4.4], roughness: 0.75, metalness: 0, legibilityEmissive: 0.2 },
  { name: 'Uranus', radius: 1.55, orbit: 52, speed: 0.068, color: 0x55b8c8, tilt: 1.706, mobile: false, ring: [2.1, 2.95], roughness: 0.75, metalness: 0, legibilityEmissive: 0.22 },
  { name: 'Neptune', radius: 1.48, orbit: 62, speed: 0.048, color: 0x2e58c8, tilt: 0.494, mobile: false, ring: [2.05, 2.8], roughness: 0.75, metalness: 0, legibilityEmissive: 0.40 }
];

export class SolarSystem {
  constructor(container, options = {}) {
    this.container = typeof container === 'string'
      ? document.querySelector(container)
      : container;

    this.options = options;
    this.running = false;
    this.simulationTime = 2446078.5;
    this.simulationDaysPerSecond = options.simulationDaysPerSecond || 12;
    this.ephemerides = null;
    // Dust tail is created only after the P1 ephemeris resolves; never
    // dereferenced during construction.
    this.dustTailRenderer = null;
    this.dustTailManager = null;
    // Planets are registered before the Moon, so its offset uses this frame's Earth position.
    this.ephemerisTargets = {};
    this.ephemerisStatus = {
      status: 'idle', error: null,
      targets: Object.fromEntries(
        [...PLANET_TABLE.map((spec) => spec.name.toLowerCase()), 'moon', 'halley'].map((name) => [name, {
          ok: false, error: null, lastJd: null, lastPhysicalPosition: null, lastTailDirection: null
        }])
      )
    };
    this.debug = (window.__DBG__ = window.__DBG__ || {});
    this.debug.solarEphemeris = this.ephemerisStatus;
    this.disposed = false;

    this.bodies = [];        // { name, mesh, angle, speed, orbit, spin, parent }
    this.disposables = [];   // geometries + materials to release in destroy()
    this.hitButtons = [];    // { el, body }
    this._hitWorldScratch = new THREE.Vector3();

    this.clock = null;
    this.frameId = 0;
    this.cameraTween = null; // { t, dur, from, to, lookFrom, lookTo, done }
    this.cameraAtHome = true;
    this.orbitState = { spherical: new THREE.Spherical(), isDragging: false, pointerStart: new THREE.Vector2(), dragMoved: false, motionState: 'running', resumeTimerId: null, resumeDelayMs: 10000, pauseStartTime: 0 };
    this._touchState = null;

    this.debug.solarSystem = this;

    if (!this.container) {
      this.debug.solarSystemError = 'container not found';
      return;
    }

    this.isMobile = this._detectMobile();

    try {
      this._buildRenderer();
    } catch (err) {
      this._failSoft(err);
      return;
    }

    this._buildScene();
    this._buildSun();
    this._buildPlanets();
    this._buildMoon();
    this._buildHitButtons();
    this._bindEvents();
    this._loadEphemerides();

    this._tick = this._tick.bind(this);
    this.clock = new THREE.Clock();
    this.resume();

    // First frame is already on screen with procedural canvas textures; the
    // CC-BY package is fetched afterwards and hot-swapped in when it lands.
    this.textureLoadPromise = this._loadPlanetaryTextures();
  }

  // Async, best-effort upgrade path. Any failure (manifest, single file,
  // disposal mid-flight) leaves the procedural textures untouched: the scene
  // must never regress to an unlit or blank body because the network blinked.
  async _loadPlanetaryTextures() {
    const tier = this.isMobile ? 'mobile' : 'desktop';

    let manifest;
    try {
      manifest = await fetchTextureManifest(TEXTURE_MANIFEST_URL);
    } catch (error) {
      console.warn('[SolarTexture] manifest load failed, keeping procedural textures', error);
      return;
    }
    if (this.disposed) return;

    const loader = typeof this.options.textureLoaderFactory === 'function'
      ? this.options.textureLoaderFactory()
      : new THREE.TextureLoader();

    const jobs = [];
    for (const [name, meta] of Object.entries(manifest.textures)) {
      const target = this._resolveTextureTarget(name);
      if (!target) continue;
      const asset = resolveTierAsset(meta, tier);
      if (!asset) continue;
      jobs.push(this._swapPlanetTexture(loader, name, asset, target));
    }

    await Promise.all(jobs);
  }

  // Maps a manifest key onto the live material slot it feeds. Unknown keys and
  // bodies that were not built (mobile drops, missing ring) resolve to null.
  _resolveTextureTarget(name) {
    if (name === 'earth_clouds') {
      return this.earthCloudMesh ? { material: this.earthCloudMesh.material, slot: 'alphaMap' } : null;
    }
    if (name === 'saturn_ring') {
      return this.saturnRing ? { material: this.saturnRing.material, slot: 'map' } : null;
    }
    const mesh = name === 'moon' ? this.moon : this.ephemerisTargets?.[name];
    return mesh?.material ? { material: mesh.material, slot: 'map' } : null;
  }

  // Resolves (never rejects) so one broken file cannot cancel the others.
  _swapPlanetTexture(loader, name, asset, target) {
    return new Promise((resolve) => {
      loader.load(asset.url, (texture) => {
        if (this.disposed) {
          texture.dispose();
          resolve(false);
          return;
        }

        // Albedo maps follow the manifest's declared colour space; anything
        // bound to a data slot (cloud alpha) must stay unconverted or gamma
        // decoding would distort its linear opacity ramp.
        texture.colorSpace = target.slot === 'alphaMap' ? THREE.NoColorSpace : threeColorSpace(asset.colorSpace);
        texture.generateMipmaps = true;
        texture.minFilter = THREE.LinearMipmapLinearFilter;

        const material = target.material;
        const previous = material[target.slot];
        material[target.slot] = texture;
        if (target.slot === 'map' && previous && material.emissiveMap === previous) material.emissiveMap = texture;
        // The procedural stand-in was tinted by the planet's base colour; a
        // real albedo map must not be multiplied by it a second time.
        if (target.slot === 'map' && material.color) material.color.setRGB(1, 1, 1);
        material.needsUpdate = true;

        // Release the procedural texture so the two never co-reside in VRAM.
        if (previous && previous.isTexture) {
          previous.dispose();
          const index = this.disposables.indexOf(previous);
          if (index !== -1) this.disposables.splice(index, 1);
        }
        this._track(texture);
        resolve(true);
      }, undefined, (error) => {
        console.warn(`[SolarTexture] ${name} texture failed, keeping procedural fallback`, error);
        resolve(false);
      });
    });
  }

  async _loadEphemerides() {
    this.ephemerisStatus.status = 'loading';
    try {
      const loaded = await loadP1Ephemerides();
      this.ephemerides = { ...loaded, providers: createContinuousEphemerisProviders(loaded.providers) };
      this.ephemerisStatus.status = 'ready';
      this.ephemerisStatus.error = null;
      if (this.disposed) return;
      this._initializeDustTail(this.ephemerides);
    } catch (error) {
      this.ephemerides = null;
      this.ephemerisStatus.status = 'error';
      this.ephemerisStatus.error = error instanceof Error ? error.message : String(error);
      for (const [name, target] of Object.entries(this.ephemerisTargets)) {
        target.visible = false;
        Object.assign(this.ephemerisStatus.targets[name], { ok: false, error: this.ephemerisStatus.error, lastJd: null, lastPhysicalPosition: null, lastTailDirection: null });
      }
    }
  }

  // Single wiring point for the Finson–Probstein dust tail. Only runs after a
  // successful async ephemeris load, guarded against disposal and double init.
  _initializeDustTail(loaded) {
    if (this.disposed || this.dustTailManager || !loaded?.providers?.halley || !loaded?.range) return;
    try {
      this.dustTailRenderer = new DustTailRenderer({ scene: this.scene, physicalToDisplay });
      this.dustTailManager = new DustTailManager({
        halleyProvider: loaded.providers.halley,
        renderer: this.dustTailRenderer,
        workerFactory: this.options.workerFactory || null,
        range: loaded.range
      });
    } catch (err) {
      this.dustTailRenderer?.dispose?.();
      this.dustTailManager?.dispose?.();
      this.dustTailRenderer = null;
      this.dustTailManager = null;
    }
  }

  // ---------------------------------------------------------------- setup

  _detectMobile() {
    if (typeof window.matchMedia === 'function') {
      return window.matchMedia(MOBILE_QUERY).matches;
    }
    return window.innerWidth <= 720;
  }

  _buildRenderer() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: !this.isMobile,
      alpha: false
    });

    const cap = this.isMobile ? 1.5 : 2;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));

    this.canvas = this.renderer.domElement;
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.container.appendChild(this.canvas);
  }

  // If WebGL is missing we still leave a readable placeholder instead of a blank panel.
  _failSoft(err) {
    this.debug.solarSystemError = (err && err.message) ? err.message : String(err);

    const note = document.createElement('div');
    note.className = 'solar-system-fallback';
    note.style.padding = '16px';
    note.style.font = '13px/1.5 system-ui, sans-serif';
    note.style.opacity = '0.75';
    note.textContent = 'Solar system view unavailable (WebGL not supported).';

    this.fallbackNode = note;
    this.container.appendChild(note);
  }

  _buildScene() {
    const { width, height } = this._measure();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060d);
    const backgroundTexture = new THREE.TextureLoader().load('/globe/backgrounds/heic1509a-bg.jpg', (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      this.scene.background = tex;
    });
    this._track(backgroundTexture);

    this.camera = new THREE.PerspectiveCamera(HOME_FOV, width / height, 0.1, 500);
    this.camera.position.set(0, 26, 48);
    this.cameraTarget = new THREE.Vector3(0, 0, 0);
    this.camera.lookAt(this.cameraTarget);

    // Home pose: immutable clones so tween math can never mutate them.
    this.baseCameraPosition = this.camera.position.clone();
    this.homeCameraPosition = this._fitHomeCamera(width, height);
    this.homeCameraTarget = this.cameraTarget.clone();
    this._snapToHome();

    // Point light lives inside the sun so planets get real directional shading.
    this.sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 0);
    this.scene.add(this.sunLight);

    // Weak ambient so the dark side is not pure black.
    this.ambientLight = new THREE.AmbientLight(0x708090, 0.42);
    this.fillLight = new THREE.DirectionalLight(0x4a5878, 0.28);
    this.fillLight.position.set(10, 30, 20);
    this.scene.add(this.ambientLight, this.fillLight);
    this._track(this.ambientLight, this.fillLight);

    this.renderer.setSize(width, height, false);
  }

  _measure() {
    const rect = this.container.getBoundingClientRect();
    // CSS owns the content box, including fractional mobile 16:9 heights.
    // WebGLRenderer rounds only the backing store after applying pixel ratio.
    const width = Math.max(1, rect.width || this.container.clientWidth || 640);
    const height = Math.max(1, rect.height || this.container.clientHeight || 360);
    return { width, height };
  }

  _fitHomeCamera(width, height) {
    const aspect = width / height;
    this.camera.fov = HOME_FOV;
    if (aspect < 1) { /* virtual landscape letterbox */ }
    const hfovHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * aspect);
    const baseDistance = this.baseCameraPosition.length();
    const maxOrbit = Math.max(TARGET_RADIUS, (62 + 2.8) * 1.08);
    const fitTargetRadius = maxOrbit;
    const requiredDist = Math.max(fitTargetRadius / Math.tan(hfovHalf), (fitTargetRadius * 0.88) / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
    const k = Math.max(1, requiredDist / baseDistance);
    return this.baseCameraPosition.clone().multiplyScalar(k);
  }

  _track(...items) {
    items.forEach((item) => this.disposables.push(item));
  }

  _buildSun() {
    const geometry = new THREE.SphereGeometry(3.4, this.isMobile ? 20 : 40, this.isMobile ? 14 : 28);
    const material = new THREE.MeshBasicMaterial({ color: 0xffcf40 });

    this.sun = new THREE.Mesh(geometry, material);
    this.sun.name = 'Sun';
    this.scene.add(this.sun);
    this._track(geometry, material);
    const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 64;
    const gc = glowCanvas.getContext('2d'); const grad = gc.createRadialGradient(32, 32, 2, 32, 32, 32); grad.addColorStop(0, 'rgba(255,255,220,.9)'); grad.addColorStop(1, 'rgba(255,150,20,0)'); gc.fillStyle = grad; gc.fillRect(0,0,64,64);
    const glowTex = new THREE.CanvasTexture(glowCanvas); const glowMat = new THREE.SpriteMaterial({ map: glowTex, color: 0xffb020, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }); const glow = new THREE.Sprite(glowMat); glow.scale.set(28,28,1); this.sun.add(glow); this._track(glowTex, glowMat);

    this.bodies.push({
      name: 'Sun',
      mesh: this.sun,
      angle: 0,
      speed: 0,
      orbit: 0,
      spin: 0.05,
      parent: null
    });
  }

  _buildOrbitRing(radius) {
    const segments = this.isMobile ? 72 : 160;
    const points = [];

    for (let i = 0; i <= segments; i += 1) {
      const a = (i / segments) * Math.PI * 2;
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0, -Math.sin(a) * radius));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: radius > 45 ? 0x2a384e : radius > 30 ? 0x465674 : 0x5a6a8c,
      transparent: true,
      opacity: 0.28
    });

    const ring = new THREE.LineLoop(geometry, material);
    this.scene.add(ring);
    this._track(geometry, material);
  }

  _buildPlanets() {
    const list = PLANET_TABLE;

    list.forEach((spec, index) => {
      const segW = this.isMobile ? 16 : 48;
      const segH = this.isMobile ? 12 : 32;

      const geometry = new THREE.SphereGeometry(spec.radius, segW, segH);
      const texture = this._buildProceduralTexture(spec.name);
      const material = new THREE.MeshStandardMaterial({
        color: spec.color,
        map: texture,
        emissive: new THREE.Color(spec.legibilityEmissive, spec.legibilityEmissive, spec.legibilityEmissive),
        emissiveMap: spec.legibilityEmissive > 0 ? texture : null,
        roughness: spec.roughness,
        metalness: spec.metalness
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = spec.name;
      mesh.visible = false;
      this.ephemerisTargets[spec.name.toLowerCase()] = mesh;
      mesh.rotation.z = spec.tilt;
      this.scene.add(mesh);
      this._track(geometry, material);
      if (spec.name === 'Earth' || spec.name === 'Venus') this._buildAtmosphere(mesh, spec.name);

      if (spec.ring && (!this.isMobile || spec.name === 'Saturn')) {
        const ringGeometry = new THREE.RingGeometry(spec.ring[0], spec.ring[1], this.isMobile ? 48 : 96);
        // Radial strip textures need polar UVs, otherwise the ring renders as
        // straight cartesian bands instead of concentric gaps.
        remapRingToPolarUv(ringGeometry, spec.ring[0], spec.ring[1]);
        const ringMaterial = new THREE.MeshStandardMaterial({ map: this._generateRingTexture(spec.name), side: THREE.DoubleSide, roughness: 0.9, metalness: 0, transparent: true, opacity: spec.name === 'Jupiter' ? 0.12 : 0.8, depthWrite: false });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.rotation.x = Math.PI / 2;
        mesh.add(ring);
        // Saturn's ring is the only one with a published CC-BY strip texture.
        if (spec.name === 'Saturn') this.saturnRing = ring;
        this._track(ringGeometry, ringMaterial);
      }

      if (hasGenericOrbitRing(spec.name)) this._buildOrbitRing(spec.orbit);

      const body = {
        name: spec.name,
        mesh,
        angle: (index / list.length) * Math.PI * 2,
        speed: spec.speed,
        orbit: spec.orbit,
        spin: 0.4,
        parent: null
      };

      this.bodies.push(body);

      if (spec.name === 'Mars') {
        this.marsBody = body;
      }

      if (spec.name === 'Earth') {
        this.earth = mesh;
        this.earthBody = body;
        const cg = new THREE.SphereGeometry(spec.radius * 1.018, segW, segH);
        const ct = this._buildProceduralTexture('EarthClouds');
        // Cloud shell is pure white lit geometry masked by an alpha map: the
        // grey-scale cloud texture drives opacity only, never albedo.
        const cm = new THREE.MeshStandardMaterial({ color: 0xffffff, alphaMap: ct, transparent: true, opacity: 0.85, roughness: 0.95, metalness: 0, depthWrite: false });
        this.earthCloudMesh = new THREE.Mesh(cg, cm);
        mesh.add(this.earthCloudMesh);
        this._track(cg, cm);
      }
    });
    this._buildHalleyComet();
    this.ephemerisTargets.halley = this.halley.group;
    this._buildAsteroidBelt();
  }

  _generateRingTexture(type = 'Saturn', options = {}) { const canvas = document.createElement('canvas'); canvas.width = options.width || (type === 'Saturn' ? 512 : 128); canvas.height = 1; const ctx = canvas.getContext('2d'); const colors = options.colors || (type === 'Uranus' ? ['rgba(190,230,245,.02)','rgba(190,230,245,.75)'] : type === 'Jupiter' ? ['rgba(110,95,80,0)','rgba(110,95,80,.12)','rgba(110,95,80,0)'] : ['rgba(90,70,45,.45)','rgba(210,195,160,.8)','rgba(40,35,30,.2)']); const g = ctx.createLinearGradient(0,0,canvas.width,0); colors.forEach((c,i)=>g.addColorStop(i/(colors.length-1),c)); ctx.fillStyle=g; ctx.fillRect(0,0,canvas.width,1); const tex = new THREE.CanvasTexture(canvas); this._track(tex); return tex; }
  _generateSaturnRingTexture() { return this._generateRingTexture('Saturn'); }
  _buildProceduralTexture(type) {
    const c=document.createElement('canvas'); c.width=this.isMobile?256:512; c.height=this.isMobile?128:256; const x=c.getContext('2d'); const w=c.width,h=c.height;
    const colors={Mercury:'#746e66',Venus:'#e2c286',Earth:'#0f2d5c',Mars:'#b54625',Jupiter:'#cca172',Saturn:'#dfcb9c',Uranus:'#52b5c5',Neptune:'#2452c2'};
    if(type==='EarthClouds'){ x.clearRect(0,0,w,h); for(let i=0;i<30;i++){x.fillStyle=`rgba(255,255,255,${0.15+(i%5)*0.12})`; x.beginPath(); x.ellipse((i*83)%w,(i*47)%h,18+(i%4)*9,4+(i%3)*3,0,0,Math.PI*2); x.fill();} }
    else { x.fillStyle=colors[type]||'#888'; x.fillRect(0,0,w,h); if(type==='Mercury'){for(let i=0;i<40;i++){const a=Math.random()*w,b=Math.random()*h,r=3+Math.random()*10;x.strokeStyle='#a29d95';x.beginPath();x.arc(a,b,r,0,7);x.stroke();x.fillStyle='#3c3832';x.beginPath();x.arc(a,b,r*.45,0,7);x.fill();}} if(type==='Earth'){x.fillStyle='#195e92';for(let i=0;i<20;i++){x.beginPath();x.ellipse((i*97)%w,(i*53)%h,25,12,0,0,7);x.fillStyle=i%2?'#2d6232':'#7a6e45';x.fill();}x.fillStyle='#f2f7fc';x.fillRect(0,0,w,9);x.fillRect(0,h-9,w,9);} if(type==='Jupiter'){for(let y=0;y<h;y+=18){x.fillStyle=y%36?'#e3c39a':'#765846';x.fillRect(0,y,w,12);}x.fillStyle='#a83618';x.beginPath();x.ellipse(w*.68,h*.64,35,18,0,0,7);x.fill();} if(type==='Mars'){x.fillStyle='#592314';x.fillRect(w*.2,h*.35,w*.2,h*.2);x.fillStyle='#fff';x.fillRect(0,0,w,8);x.fillRect(0,h-8,w,8);} if(type==='Neptune'){x.fillStyle='#0d2358';x.beginPath();x.ellipse(w*.62,h*.65,28,14,0,0,7);x.fill();}}
    const t=new THREE.CanvasTexture(c); this._track(t); return t;
  }
  _buildAtmosphere(planetMesh, type) { if (this.isMobile && type !== 'Earth') return null; const g = new THREE.SphereGeometry(planetMesh.geometry.parameters.radius * 1.045, 16, 12); const m = new THREE.MeshBasicMaterial({ color: 0x5cb3ff, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, side: THREE.BackSide, depthWrite: false }); const shell = new THREE.Mesh(g,m); planetMesh.add(shell); this._track(g,m); return shell; }

  _buildHalleyComet() {
    const nucleus = new THREE.Mesh(new THREE.SphereGeometry(.35, 12, 8), new THREE.MeshBasicMaterial({ color: 0xdff6ff }));
    this._track(nucleus.geometry, nucleus.material);

    // Compatibility reference for getP1RuntimeSnapshot's anti-solar axis.
    // It has no geometry/material; DustTailRenderer owns the only visible tail.
    const tail = new THREE.Object3D();
    tail.name = 'halley-anti-solar-reference';
    tail.visible = false;

    // A centered, circular coma: no directional elongation or offset.
    const flameCanvas = document.createElement('canvas');
    flameCanvas.width = flameCanvas.height = 64;
    const fc = flameCanvas.getContext('2d');
    const fg = fc.createRadialGradient(32, 32, 2, 32, 32, 32);
    fg.addColorStop(0, 'rgba(255,255,240,.95)');
    fg.addColorStop(.35, 'rgba(120,220,255,.65)');
    fg.addColorStop(1, 'rgba(80,160,255,0)');
    fc.fillStyle = fg;
    fc.fillRect(0, 0, 64, 64);
    const flameTex = new THREE.CanvasTexture(flameCanvas);
    const flameMat = new THREE.SpriteMaterial({ map: flameTex, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const flame = new THREE.Sprite(flameMat);
    this._track(flameTex, flameMat);

    const group = new THREE.Group();
    group.add(nucleus, tail, flame);
    group.visible = false;
    flame.renderOrder = 1;
    group.renderOrder = 1;
    this.scene.add(group);
    this.halley = { group, nucleus, tail, flame };
  }

  _buildAsteroidBelt() { const count=this.isMobile?500:1200; const geo=new THREE.DodecahedronGeometry(.15,0); const mat=new THREE.MeshStandardMaterial({color:0x887766,roughness:1}); const mesh=new THREE.InstancedMesh(geo,mat,count); const m=new THREE.Matrix4(); this.asteroidData=Array.from({length:count},()=>({r:27.5+Math.random()*4.3,angle:Math.random()*Math.PI*2,y:(Math.random()*2-1)*.35,spin:Math.random(),scale:0.7+Math.random()*0.8})); this.asteroidData.forEach((a,i)=>{m.makeRotationFromEuler(new THREE.Euler(Math.random(),Math.random(),Math.random())); m.scale(new THREE.Vector3(a.scale,a.scale,a.scale)); m.setPosition(a.r*Math.cos(a.angle),a.y,-a.r*Math.sin(a.angle)); mesh.setMatrixAt(i,m);}); this.scene.add(mesh); this.asteroidBelt=mesh; this._track(geo,mat); }

  _buildMoon() {
    if (!this.earthBody) {
      return;
    }

    const geometry = new THREE.SphereGeometry(0.36, this.isMobile ? 14 : 24, this.isMobile ? 10 : 18);
    const material = new THREE.MeshStandardMaterial({
      color: 0xcfcfcf,
      roughness: 0.95,
      metalness: 0.0
    });

    this.moon = new THREE.Mesh(geometry, material);
    this.moon.name = 'Moon';
    this.moon.visible = false;
    this.ephemerisTargets.moon = this.moon;
    this.scene.add(this.moon);
    this._track(geometry, material);

    // parent set to the Earth body: its orbit is measured from Earth's position.
    this.moonBody = {
      name: 'Moon',
      mesh: this.moon,
      angle: 1.2,
      speed: 3.2,
      orbit: 9.0,
      spin: 0.3,
      parent: this.earthBody,
      xFactor: 0.25,
      yFactor: 1.1
    };

    this.bodies.push(this.moonBody);
  }

  // Transparent buttons overlay the canvas and are repositioned each frame,
  // giving Sun / Earth / Moon native Tab focus and Enter/Space activation.
  _buildHitButtons() {
    if (getComputedStyle(this.container).position === 'static') {
      this.container.style.position = 'relative';
    }

    const targets = [
      { mesh: this.sun, name: 'Sun', ariaLabel: '太阳（前往登录）' },
      { mesh: this.earth, name: 'Earth', ariaLabel: '地球（进入三维地球）' },
      { mesh: this.moon, name: 'Moon', ariaLabel: '月球（进入总览）' }
    ];

    targets.forEach((target) => {
      if (!target.mesh) {
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'solar-system-hit';
      button.setAttribute('aria-label', target.ariaLabel);
      button.style.position = 'absolute';
      button.style.padding = '0';
      button.style.margin = '0';
      button.style.border = '0';
      button.style.background = 'transparent';
      button.style.cursor = 'pointer';
      button.style.transform = 'translate(-50%, -50%)';

      const onActivate = () => this._activate(target.name);
      button.addEventListener('click', onActivate);

      this.container.appendChild(button);
      this.hitButtons.push({ el: button, mesh: target.mesh, onActivate });
    });
  }

  _bindEvents() {
    this._onResize = () => this.resize();
    this._onPointerDown = (event) => {
      if (event.button !== 0) return;
      this._resetResumeTimer(); this.orbitState.isDragging = true; this.orbitState.motionState = 'dragging'; this.orbitState.dragMoved = false;
      this.orbitState.pointerStart.set(event.clientX, event.clientY);
    };
    this._onPointerMove = (event) => {
      if (this.orbitState.isDragging) {
        const dx = event.clientX - this.orbitState.pointerStart.x; const dy = event.clientY - this.orbitState.pointerStart.y;
        if (Math.hypot(dx, dy) > 4) { this.orbitState.dragMoved = true; event.preventDefault(); this.orbitState.spherical.theta -= dx * 0.008; this.orbitState.spherical.phi = THREE.MathUtils.clamp(this.orbitState.spherical.phi + dy * 0.008, 0.15, Math.PI / 2 - 0.08); this.orbitState.pointerStart.set(event.clientX, event.clientY); }
        return;
      }
      this._updateHover(event);
    };
    this._onPointerUp = (event) => { if (this.orbitState.isDragging && !this.orbitState.dragMoved) this._pickAt(event); this.orbitState.isDragging = false; if (this.orbitState.dragMoved) this._startResumeTimer(); else this.orbitState.motionState='running'; };
    this._onPointerLeave = () => { this.orbitState.isDragging = false; };
    this._onWheel = (event) => { event.preventDefault(); this._resetResumeTimer(); this._interruptTween(); this.orbitState.spherical.radius = THREE.MathUtils.clamp(this.orbitState.spherical.radius + event.deltaY * 0.08, 25, 140); };

    window.addEventListener('resize', this._onResize);
    // Returning to a visible tab restarts rAF; make sure a moon button detached
    // before the pause is back in the hit-test tree.
    this._onVisibility = () => {
      if (document.visibilityState === 'visible') {
        const moonEntry = this.hitButtons.find((entry) => entry.mesh === this.moon);
        this._ensureMoonAttached(moonEntry);
      }
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    this.canvas.addEventListener('pointermove', this._onPointerMove);
    this.canvas.addEventListener('pointerup', this._onPointerUp);
    this.canvas.addEventListener('pointerleave', this._onPointerLeave);
    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this._boundTouchStart = (e) => this._onTouchStart(e);
    this._boundTouchMove = (e) => this._onTouchMove(e);
    this._boundTouchEnd = (e) => this._onTouchEnd(e);
    this.canvas.addEventListener('touchstart', this._boundTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._boundTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._boundTouchEnd, { passive: false });

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  _interruptTween() { if (this.cameraTween) { this.cameraTween = null; this.cameraAtHome = false; } if (this.camera) this.orbitState.spherical.setFromVector3(this.camera.position.clone().sub(this.cameraTarget)); }
  _updateHover(event) { const rect = this.canvas.getBoundingClientRect(); this.pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1); this.raycaster.setFromCamera(this.pointer, this.camera); const hit = this.raycaster.intersectObjects([this.sun, this.earth, this.moon].filter(Boolean), false)[0]; this.hitButtons.forEach((e) => { const active = hit && hit.object === e.mesh; if (e.mesh.material.emissive) e.mesh.material.emissive.setScalar(active ? 0.35 : 0); else e.mesh.scale.setScalar(active ? 1.06 : 1); }); }
  _onTouchStart(event) { if (event.touches.length === 2) { this._interruptTween(); this._touchState = { start: Date.now(), count: 2, dist: this._touchDistance(event.touches), x: 0, y: 0, moved: false }; } else if (event.touches.length === 1) { const t = event.touches[0]; this._touchState = { start: Date.now(), count: 1, x: t.clientX, y: t.clientY, moved: false }; } }
  _onTouchMove(event) { if (!this._touchState || !event.touches.length) return; if (event.touches.length !== this._touchState.count) { const t = event.touches[0]; this._touchState.count = event.touches.length; this._touchState.x = t.clientX; this._touchState.y = t.clientY; this._touchState.moved = true; if (event.touches.length === 2) this._touchState.dist = this._touchDistance(event.touches); return; } if (event.touches.length === 2) { event.preventDefault(); const d = this._touchDistance(event.touches); this.orbitState.spherical.radius = THREE.MathUtils.clamp(this.orbitState.spherical.radius - (d - this._touchState.dist) * 0.08, 25, 140); this._touchState.dist = d; return; } const t = event.touches[0]; const dx = t.clientX - this._touchState.x; const dy = t.clientY - this._touchState.y; if (Math.hypot(dx, dy) > 6) { event.preventDefault(); this._interruptTween(); this.orbitState.spherical.theta -= dx * 0.008; this.orbitState.spherical.phi = THREE.MathUtils.clamp(this.orbitState.spherical.phi + dy * 0.008, 0.15, Math.PI / 2 - 0.08); this._touchState.x = t.clientX; this._touchState.y = t.clientY; this._touchState.moved = true; } }
  _onTouchEnd(event) { if (this._touchState && !this._touchState.moved && Date.now() - this._touchState.start < 250 && event.changedTouches[0]) this._pickAt(event.changedTouches[0]); this._touchState = null; }
  _startResumeTimer() { clearTimeout(this.orbitState.resumeTimerId); this.orbitState.motionState='paused'; this.orbitState.pauseStartTime=Date.now(); this.orbitState.resumeTimerId=setTimeout(()=>{this.orbitState.motionState='running';this.orbitState.resumeTimerId=null;},this.orbitState.resumeDelayMs); }
  _resetResumeTimer() { if (this.orbitState.motionState==='paused') this._startResumeTimer(); }
  _touchDistance(t) { return Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY); }

  // -------------------------------------------------------------- picking

  _pickAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    this.raycaster.setFromCamera(this.pointer, this.camera);

    const pickable = [this.sun, this.earth, this.moon].filter(Boolean);
    const hits = this.raycaster.intersectObjects(pickable, false);

    if (hits.length > 0) {
      this._activate(hits[0].object.name);
    }
  }

  _activate(name) {
    if (name === 'Sun' && typeof this.options.onSunClick === 'function') {
      this.options.onSunClick();
      return;
    }

    if (name === 'Moon' && typeof this.options.onMoonClick === 'function') {
      this.options.onMoonClick();
      return;
    }

    if (name === 'Earth') {
      this._approachEarth();
    }
  }

  // Camera approach tween: state only, stepped by the shared rAF tick below.
  _approachEarth() {
    if (this.cameraTween || !this.earth) {
      return;
    }

    const earthPos = this.earth.position.clone();
    const offset = new THREE.Vector3(0, 3.2, 8).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.atan2(earthPos.z, earthPos.x)
    );

    this.cameraTween = {
      t: 0,
      dur: 0.4,
      from: this.camera.position.clone(),
      to: earthPos.clone().add(offset),
      lookFrom: this.cameraTarget.clone(),
      lookTo: earthPos
    };
    this.cameraAtHome = false;
  }

  _stepCameraTween(dt) {
    const tween = this.cameraTween;
    if (!tween) {
      return;
    }

    tween.t = Math.min(1, tween.t + (dt / tween.dur));

    // ease-in-out cubic
    const k = tween.t < 0.5
      ? 4 * tween.t * tween.t * tween.t
      : 1 - Math.pow(-2 * tween.t + 2, 3) / 2;

    this.camera.position.lerpVectors(tween.from, tween.to, k);
    this.cameraTarget.lerpVectors(tween.lookFrom, tween.lookTo, k);
    this.camera.lookAt(this.cameraTarget);

    if (tween.t >= 1) {
      this.cameraTween = null;

      if (typeof this.options.onEarthClick === 'function') {
        this.options.onEarthClick();
      }
    }
  }

  // ----------------------------------------------------------- animation

  _tick() {
    if (!this.running || this.disposed) {
      return;
    }

    const dt = Math.min(0.05, this.clock.getDelta());

    const shouldAdvance = !this.orbitState.isDragging && this.orbitState.motionState !== 'paused';
    this._advanceBodies(shouldAdvance ? dt : 0);
    this.dustTailManager?.tick(this.simulationTime, {
      paused: !shouldAdvance,
      bodyValid: this.ephemerisStatus.targets.halley.ok
    });
    this.debug.solarOrbitMotionState = this.orbitState.motionState;
    this.debug.solarOrbitResumeRemainingMs = this.orbitState.motionState === 'paused' ? Math.max(0, this.orbitState.resumeDelayMs - (Date.now() - this.orbitState.pauseStartTime)) : 0;
    this._stepCameraTween(dt);
    if (!this.cameraTween) { this.camera.position.setFromSpherical(this.orbitState.spherical).add(this.cameraTarget); this.camera.lookAt(this.cameraTarget); }
    this._syncHitButtons();

    this.renderer.render(this.scene, this.camera);

    this.frameId = requestAnimationFrame(this._tick);
  }

  // All ephemeris targets share one clock; body spins advance independently.
  _advanceBodies(dt) {
    this.simulationTime = advanceSimulationTime(this.simulationTime, dt, this.simulationDaysPerSecond, this.ephemerides?.range || [2446078.5, 2446643.5]);
    advanceOrbitalBodies(this.bodies, dt, this.earthCloudMesh);

    this.sunLight.position.copy(this.sun.position);
    if (this.asteroidBelt && this.asteroidData) { const m = new THREE.Matrix4(); this.asteroidData.forEach((a,i) => { a.angle += 0.18 * Math.pow(29.6 / a.r, 1.5) * dt; m.makeRotationY(a.spin * dt); m.setPosition(a.r * Math.cos(a.angle), a.y, -a.r * Math.sin(a.angle)); m.scale(new THREE.Vector3(a.scale, a.scale, a.scale)); this.asteroidBelt.setMatrixAt(i,m); }); this.asteroidBelt.instanceMatrix.needsUpdate = true; }
    if (this.ephemerides) updateEphemerisTargets({
      simulationTime: this.simulationTime,
      providers: this.ephemerides.providers,
      targets: this.ephemerisTargets,
      statuses: this.ephemerisStatus.targets,
      applyPosition: (target, position, name) => {
        if (name === 'moon') {
          const [x, y, z] = position;
          target.position.copy(this.earth.position).add(new THREE.Vector3(x, z, -y).multiplyScalar(MOON_DISPLAY_UNITS_PER_AU));
          return;
        }
        const display = physicalToDisplay(position);
        target.position.copy(new THREE.Vector3(display.x, display.y, display.z));
      },
      applyTail: (_target, tail) => {
        const direction = new THREE.Vector3(tail.direction.x, tail.direction.y, tail.direction.z);
        this.halley.tail.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), direction);
        this.halley.flame.scale.setScalar(THREE.MathUtils.clamp(2.4 * (1.2 / tail.distanceAu), 1, 4.8));
      }
    });
  }

  getP1RuntimeSnapshot() {
    const world = (object) => object.getWorldPosition(new THREE.Vector3()).toArray();
    const origin = this.halley.tail.localToWorld(new THREE.Vector3(0, 0, 0));
    const positiveX = this.halley.tail.localToWorld(new THREE.Vector3(1, 0, 0));
    return {
      frameId: this.frameId,
      simulationTime: this.simulationTime,
      marsWorld: world(this.marsBody.mesh),
      halleyWorld: world(this.halley.group),
      marsPhysical: this.ephemerisStatus.targets.mars.lastPhysicalPosition?.slice() || null,
      halleyPhysical: this.ephemerisStatus.targets.halley.lastPhysicalPosition?.slice() || null,
      expectedTailWorldDirection: this.ephemerisStatus.targets.halley.lastTailDirection ? Object.values(this.ephemerisStatus.targets.halley.lastTailDirection) : null,
      tailWorldDirection: positiveX.sub(origin).normalize().toArray(),
    };
  }

  // Project each tracked mesh to screen space and park its hit button there.
  // The joint solver may detach the moon button on degenerate frames. Re-attach
  // must be idempotent and run from every resume path (render loop, resume(),
  // visibilitychange) — a rAF halt while detached must not leave it stranded.
  _ensureMoonAttached(entry) {
    if (entry && entry.mesh === this.moon && !entry.el.isConnected && !entry.__unsolvable) {
      (this.canvas.parentElement || document.body).appendChild(entry.el);
    }
  }

  _syncHitButtons() {
    if (this.disposed || !this.canvas || !this.hitButtons.length) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const entries = this.hitButtons.map((entry) => {
      const world = entry.mesh.getWorldPosition(this._hitWorldScratch).clone();
      const ndc = world.clone().project(this.camera);
      return {
        entry,
        world,
        ndc,
        x: (ndc.x * 0.5 + 0.5) * rect.width,
        y: (-ndc.y * 0.5 + 0.5) * rect.height,
        offsetX: 0,
        offsetY: 0,
      };
    });

    // Clamp base projection points into the canvas so buttons stay clickable;
    // separation offsets then operate on already-valid bases.
    const half0 = 12;
    entries.forEach((row) => {
      row.x = Math.max(half0, Math.min(rect.width - half0, row.x));
      row.y = Math.max(half0, Math.min(rect.height - half0, row.y));
    });

    const sizes = new Map(entries.map(({ entry }) => [entry, 24]));
    const priorityRows = [this.sun, this.earth, this.moon]
      .map((mesh) => entries.find((item) => item.entry.mesh === mesh))
      .filter(Boolean);
    const earthSize = sizes.get(this.hitButtons.find((item) => item.mesh === this.earth)) || 24;
    const moonSize = sizes.get(this.hitButtons.find((item) => item.mesh === this.moon)) || 24;
    const earthMoonThreshold = Math.max((earthSize + moonSize) * 0.5 * 1.1, earthSize + moonSize * 0.5 + 2);

    // Joint hit-target solver: place the Earth/Moon button offsets so that all
    // box-center distances stay above PAIR_MIN (24px boxes + 0.6px float margin;
    // sun pairs use SUN_PAIR_MIN = MAX_OFF + PROBE_CLEAR so an offset box can
    // never land within PROBE_CLEAR of the sun's raw probe — no z-order appeal,
    // PAIR_MIN alone would only guarantee a 13.1px probe margin there) while
    // each button keeps covering its own mesh projection (|offset| <= MAX_OFF,
    // 0.5px inside the box edge). Box-vs-probe clearance (PROBE_CLEAR 13.5 =
    // half-box 12 + 1.5px inter-frame sampling jitter) keeps elementFromPoint
    // at another body's probe from hitting this button.
    const MAX_OFF = 11.5;
    const PROBE_CLEAR = 13.5;         // half-box 12 + 1.5px sampling jitter
    const PAIR_MIN = 24.6;            // earth/moon box-center separation
    const SUN_PAIR_MIN = MAX_OFF + PROBE_CLEAR; // 25.0: sun-pair probe margin
    const sunRow2 = priorityRows.find((row) => row.entry.mesh === this.sun);
    const earthRow = priorityRows.find((row) => row.entry.mesh === this.earth);
    const moonRow2 = priorityRows.find((row) => row.entry.mesh === this.moon);
    // SUN_PAIR_MIN derives from the sun button never being offset (z-order
    // stacking keeps it at offsetX/Y = 0). If a future pass offsets the sun
    // row, recompute SUN_PAIR_MIN with the sun's offset included.
    if (sunRow2 && earthRow && moonRow2 && sunRow2.offsetX === 0 && sunRow2.offsetY === 0) {
      const placementValid = (eoX, eoY, moX, moY) => {
        const eX = earthRow.x + eoX, eY = earthRow.y + eoY;
        const mX = moonRow2.x + moX, mY = moonRow2.y + moY;
        if (Math.hypot(eX - sunRow2.x, eY - sunRow2.y) < SUN_PAIR_MIN) return false;
        if (Math.hypot(mX - sunRow2.x, mY - sunRow2.y) < SUN_PAIR_MIN) return false;
        if (Math.hypot(mX - eX, mY - eY) < PAIR_MIN) return false;
        // Each box must also stay clear of the OTHER body's raw probe point,
        // otherwise elementFromPoint at that probe hits the wrong button.
        if (Math.hypot(eX - moonRow2.x, eY - moonRow2.y) < PROBE_CLEAR) return false;
        if (Math.hypot(mX - earthRow.x, mY - earthRow.y) < PROBE_CLEAR) return false;
        return true;
      };
      moonRow2.entry.__unsolvable = false;
      // Hysteresis: a still-valid placement persists unchanged (no frame-to-
      // frame snapping); the search only runs when the placement went invalid.
      if (!placementValid(earthRow.offsetX, earthRow.offsetY, moonRow2.offsetX, moonRow2.offsetY)) {
        // NOTE: no backoff here — the moon's angular motion changes the probe
        // geometry every frame, so a failed grid can succeed next frame. The
        // first-hit early exit keeps the common-frame cost near zero; only
        // truly unsolvable stretches pay the full ~4k-candidate sweep.
          // Frame-invariant grid: build+sort once, cache on the instance.
          if (!this.__placementGrid) {
            const dirs = [];
            for (let k = 0; k < 16; k += 1) {
              const a = (k / 16) * Math.PI * 2;
              dirs.push([Math.cos(a), Math.sin(a)]);
            }
            const radii = [0, 4, 8, MAX_OFF];
            const grid = [];
            for (const re of radii) {
              for (const de of dirs) {
                for (const rm of radii) {
                  for (const dm of dirs) {
                    grid.push({ eoX: de[0] * re, eoY: de[1] * re, moX: dm[0] * rm, moY: dm[1] * rm, cost: re * re + rm * rm });
                  }
                }
              }
            }
            grid.sort((a, b) => a.cost - b.cost);
            this.__placementGrid = grid;
          }
          let best = null;
          for (const c of this.__placementGrid) {
            if (placementValid(c.eoX, c.eoY, c.moX, c.moY)) {
              best = c;
              break;
            }
          }
        if (best) {
          earthRow.offsetX = best.eoX; earthRow.offsetY = best.eoY;
          moonRow2.offsetX = best.moX; moonRow2.offsetY = best.moY;
        } else {
          moonRow2.entry.__unsolvable = true;
          if (moonRow2.entry.el.isConnected) moonRow2.entry.el.remove();
        }
      }
    }


    entries.forEach(({ entry, ndc: projected, world, x, y, offsetX, offsetY }) => {

      const visible = projected.z < 1 && projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1;

      const size = sizes.get(entry) || 24;
      entry.el.style.left = `${x + offsetX}px`;
      entry.el.style.top = `${y + offsetY}px`;
      entry.el.style.width = `${size}px`;
      entry.el.style.height = `${size}px`;
      // Priority stacking: the Sun (primary CTA) wins elementFromPoint when the
      // moon's tween-time overlap is unavoidable at degenerate viewports.
      entry.el.style.zIndex = entry.mesh === this.sun ? '30' : (entry.mesh === this.earth ? '20' : '10');
      // Moon crossing the Sun's button during camera tween: park the moon button
      // out of the hit-test tree for those frames so it cannot steal the Sun's
      // center/target probes. Re-appended as soon as the overlap clears.
      if (entry.mesh === this.moon && this.sun) {
        const sunEntry = entries.find((item) => item.entry.mesh === this.sun);
        if (sunEntry) {
          const gapToSun = Math.hypot((x + offsetX) - (sunEntry.x + sunEntry.offsetX), (y + offsetY) - (sunEntry.y + sunEntry.offsetY));
          if (gapToSun < size * 0.75) {
            if (entry.el.isConnected) entry.el.remove();
            return;
          }
        }
      }
      this._ensureMoonAttached(entry);
      entry.el.style.visibility = visible ? 'visible' : 'hidden';
    });
  }

  // -------------------------------------------------------------- public

  resetCamera() {
    if (this.disposed || !this.camera) {
      return this;
    }

    this._snapToHome();

    return this;
  }

  _snapToHome() {
    this.cameraTween = null;
    this.cameraAtHome = true;
    this.camera.position.copy(this.homeCameraPosition);
    this.cameraTarget.copy(this.homeCameraTarget);
    this.camera.lookAt(this.cameraTarget);
    this.orbitState.spherical.setFromVector3(this.camera.position.clone().sub(this.cameraTarget));
  }

  resume() {
    if (this.disposed || this.running || !this.renderer) {
      return this;
    }

    // Escape is the only path back into the scene, so the wide shot has to be
    // restored here. Otherwise the camera stays parked at the previous approach
    // tween's destination and the next _approachEarth() tweens from its own
    // endpoint: near-coincident from/to, a tween that finishes in a couple of
    // frames, and an onEarthClick that fires at an unpredictable moment.
    this.resetCamera();

    // If the joint solver detached the moon button while paused (or the tab was
    // hidden and rAF throttled), re-attach before the loop restarts — otherwise
    // the button stays stranded and permanently unclickable.
    const moonEntry = this.hitButtons && this.hitButtons.find((entry) => entry.mesh === this.moon);
    this._ensureMoonAttached(moonEntry);

    this.running = true;
    this.clock.getDelta();

    this._tick();

    return this;
  }

  pause() {
    this.running = false;

    if (this.frameId) {
      cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }

    return this;
  }

  resize() {
    if (this.disposed || !this.renderer) {
      return this;
    }

    const { width, height } = this._measure();

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    const nextHome = this._fitHomeCamera(width, height);
    this.homeCameraPosition = nextHome;
    if (this.cameraAtHome) {
      this.camera.position.lerp(this.homeCameraPosition, 0.25);
      this.camera.lookAt(this.cameraTarget);
    }
    this.renderer.setSize(width, height, false);
    // Redundant on today's paths: lookAt() already refreshes matrixWorldInverse via
    // Camera#updateWorldMatrix, and when cameraAtHome is false the camera has not moved
    // since the last render. Kept as a cheap guard for any future path that moves the
    // camera outside a rendered frame.
    this.camera.updateMatrixWorld();
    this._syncHitButtons();

    return this;
  }

  // External browser tests read this to prove the orbits actually move.
  getBodySnapshot() {
    return this.bodies.map((body) => ({
      name: body.name,
      x: body.mesh.position.x,
      y: body.mesh.position.y,
      z: body.mesh.position.z
    }));
  }

  destroy() {
    this.pause();
    this.disposed = true;

    if (this.dustTailManager) {
      this.dustTailManager.dispose();
      this.dustTailManager = null;
    }
    if (this.dustTailRenderer) {
      this.dustTailRenderer.dispose();
      this.dustTailRenderer = null;
    }

    window.removeEventListener('resize', this._onResize);
    if (this._onVisibility) {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }

    if (this.canvas && this._onPointerDown) {
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
      this.canvas.removeEventListener('pointermove', this._onPointerMove);
      this.canvas.removeEventListener('pointerup', this._onPointerUp);
      this.canvas.removeEventListener('pointerleave', this._onPointerLeave);
      this.canvas.removeEventListener('wheel', this._onWheel);
      this.canvas.removeEventListener('touchstart', this._boundTouchStart);
      this.canvas.removeEventListener('touchmove', this._boundTouchMove);
      this.canvas.removeEventListener('touchend', this._boundTouchEnd);
    }

    this.hitButtons.forEach((entry) => {
      entry.el.removeEventListener('click', entry.onActivate);
      if (entry.el.parentNode) {
        entry.el.parentNode.removeChild(entry.el);
      }
    });
    this.hitButtons.length = 0;

    this.disposables.forEach((item) => {
      if (item && typeof item.dispose === 'function') {
        item.dispose();
      }
    });
    this.disposables.length = 0;

    if (this.scene) {
      this.scene.clear();
    }

    if (this.renderer) {
      this.renderer.dispose();
    }

    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    if (this.fallbackNode && this.fallbackNode.parentNode) {
      this.fallbackNode.parentNode.removeChild(this.fallbackNode);
    }

    this.bodies.length = 0;

    if (this.debug.solarSystem === this) {
      this.debug.solarSystem = null;
    }

    return this;
  }
}

export default SolarSystem;
