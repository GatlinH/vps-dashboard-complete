import * as THREE from 'three';

// Solar system widget: real orbital revolution, keyboard-reachable bodies,
// a single rAF loop that also drives the camera approach tween.

const MOBILE_QUERY = '(max-width: 720px)';

// name, radius, orbital radius, angular speed (rad/s), colour, mobile-only-drop flag
const PLANET_TABLE = [
  { name: 'Mercury', radius: 0.7, orbit: 9, speed: 0.62, color: 0x9c8a7a, mobile: false },
  { name: 'Venus', radius: 1.1, orbit: 13.5, speed: 0.44, color: 0xd8a05a, mobile: true },
  { name: 'Earth', radius: 1.25, orbit: 19, speed: 0.31, color: 0x3f7fd8, mobile: true },
  { name: 'Mars', radius: 0.95, orbit: 25, speed: 0.24, color: 0xc1552f, mobile: true },
  { name: 'Jupiter', radius: 2.4, orbit: 33, speed: 0.14, color: 0xd2a679, mobile: false },
  { name: 'Saturn', radius: 2.0, orbit: 41, speed: 0.10, color: 0xe0cba0, mobile: false }
];

export class SolarSystem {
  constructor(container, options = {}) {
    this.container = typeof container === 'string'
      ? document.querySelector(container)
      : container;

    this.options = options;
    this.running = false;
    this.disposed = false;

    this.bodies = [];        // { name, mesh, angle, speed, orbit, spin, parent }
    this.disposables = [];   // geometries + materials to release in destroy()
    this.hitButtons = [];    // { el, body }

    this.clock = null;
    this.frameId = 0;
    this.cameraTween = null; // { t, dur, from, to, lookFrom, lookTo, done }

    this.debug = (window.__DBG__ = window.__DBG__ || {});
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
    this._buildStars();
    this._buildSun();
    this._buildPlanets();
    this._buildMoon();
    this._buildHitButtons();
    this._bindEvents();

    this.clock = new THREE.Clock();
    this.resume();
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

    this.camera = new THREE.PerspectiveCamera(52, width / height, 0.1, 500);
    this.camera.position.set(0, 26, 48);
    this.cameraTarget = new THREE.Vector3(0, 0, 0);
    this.camera.lookAt(this.cameraTarget);

    // Home pose: immutable clones so tween math can never mutate them.
    this.homeCameraPosition = this.camera.position.clone();
    this.homeCameraTarget = this.cameraTarget.clone();

    // Point light lives inside the sun so planets get real directional shading.
    this.sunLight = new THREE.PointLight(0xffffff, 2.2, 0, 2);
    this.scene.add(this.sunLight);

    // Weak ambient so the dark side is not pure black.
    this.scene.add(new THREE.AmbientLight(0x404a66, 0.35));

    this.renderer.setSize(width, height, false);
  }

  _measure() {
    const rect = this.container.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width || this.container.clientWidth || 640));
    const height = Math.max(1, Math.round(rect.height || this.container.clientHeight || 360));
    return { width, height };
  }

  _track(...items) {
    items.forEach((item) => this.disposables.push(item));
  }

  _buildStars() {
    const count = this.isMobile ? 500 : 2200;
    const positions = new Float32Array(count * 3);

    for (let i = 0; i < count; i += 1) {
      const radius = 120 + Math.random() * 160;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos((Math.random() * 2) - 1);

      positions[i * 3 + 0] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      color: 0xffffff,
      size: this.isMobile ? 1.1 : 0.8,
      sizeAttenuation: true
    });

    this.stars = new THREE.Points(geometry, material);
    this.scene.add(this.stars);
    this._track(geometry, material);
  }

  _buildSun() {
    const geometry = new THREE.SphereGeometry(3.4, this.isMobile ? 20 : 40, this.isMobile ? 14 : 28);
    const material = new THREE.MeshBasicMaterial({ color: 0xffcf40 });

    this.sun = new THREE.Mesh(geometry, material);
    this.sun.name = 'Sun';
    this.scene.add(this.sun);
    this._track(geometry, material);

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
      points.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x5a6a8c,
      transparent: true,
      opacity: 0.28
    });

    const ring = new THREE.LineLoop(geometry, material);
    this.scene.add(ring);
    this._track(geometry, material);
  }

  _buildPlanets() {
    // On narrow screens keep only the planets flagged for mobile (Earth included).
    const list = this.isMobile
      ? PLANET_TABLE.filter((p) => p.mobile)
      : PLANET_TABLE;

    list.forEach((spec, index) => {
      const segW = this.isMobile ? 16 : 32;
      const segH = this.isMobile ? 12 : 24;

      const geometry = new THREE.SphereGeometry(spec.radius, segW, segH);
      const material = new THREE.MeshStandardMaterial({
        color: spec.color,
        roughness: 0.85,
        metalness: 0.05
      });

      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = spec.name;
      this.scene.add(mesh);
      this._track(geometry, material);

      this._buildOrbitRing(spec.orbit);

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

      if (spec.name === 'Earth') {
        this.earth = mesh;
        this.earthBody = body;
      }
    });
  }

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
    this.scene.add(this.moon);
    this._track(geometry, material);

    // parent set to the Earth body: its orbit is measured from Earth's position.
    this.moonBody = {
      name: 'Moon',
      mesh: this.moon,
      angle: 1.2,
      speed: 2.4,
      orbit: 2.6,
      spin: 0.3,
      parent: this.earthBody
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
      { mesh: this.sun, label: 'Sun', handler: this.options.onSunClick },
      { mesh: this.earth, label: 'Earth', handler: () => this._approachEarth() },
      { mesh: this.moon, label: 'Moon', handler: this.options.onMoonClick }
    ];

    targets.forEach((target) => {
      if (!target.mesh) {
        return;
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'solar-system-hit';
      button.setAttribute('aria-label', target.label);
      button.style.position = 'absolute';
      button.style.padding = '0';
      button.style.margin = '0';
      button.style.border = '0';
      button.style.background = 'transparent';
      button.style.cursor = 'pointer';
      button.style.transform = 'translate(-50%, -50%)';

      const onActivate = () => this._activate(target.label);
      button.addEventListener('click', onActivate);

      this.container.appendChild(button);
      this.hitButtons.push({ el: button, mesh: target.mesh, onActivate });
    });
  }

  _bindEvents() {
    this._onResize = () => this.resize();
    this._onPointerDown = (event) => this._pickAt(event);

    window.addEventListener('resize', this._onResize);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

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

    this._advanceBodies(dt);
    this._stepCameraTween(dt);
    this._syncHitButtons();

    if (this.stars) {
      this.stars.rotation.y += dt * 0.005;
    }

    this.renderer.render(this.scene, this.camera);

    this.frameId = requestAnimationFrame(this._tick);
  }

  // Genuine revolution: angle accumulates, position is derived from it.
  _advanceBodies(dt) {
    this.bodies.forEach((body) => {
      body.angle += body.speed * dt;

      if (body.orbit > 0) {
        const x = Math.cos(body.angle) * body.orbit;
        const z = Math.sin(body.angle) * body.orbit;

        if (body.parent) {
          body.mesh.position.set(
            body.parent.mesh.position.x + x,
            body.parent.mesh.position.y,
            body.parent.mesh.position.z + z
          );
        } else {
          body.mesh.position.set(x, 0, z);
        }
      }

      body.mesh.rotation.y += body.spin * dt;
    });

    this.sunLight.position.copy(this.sun.position);
  }

  // Project each tracked mesh to screen space and park its hit button there.
  _syncHitButtons() {
    const rect = this.canvas.getBoundingClientRect();
    const projected = new THREE.Vector3();

    this.hitButtons.forEach((entry) => {
      projected.copy(entry.mesh.position).project(this.camera);

      const visible = projected.z < 1;
      const left = (projected.x * 0.5 + 0.5) * rect.width;
      const top = (-projected.y * 0.5 + 0.5) * rect.height;

      const scale = entry.mesh.geometry.parameters.radius || 1;
      const size = Math.max(24, Math.min(120, (scale * 260) / Math.max(6, this.camera.position.distanceTo(entry.mesh.position))));

      entry.el.style.left = `${left}px`;
      entry.el.style.top = `${top}px`;
      entry.el.style.width = `${size}px`;
      entry.el.style.height = `${size}px`;
      entry.el.style.visibility = visible ? 'visible' : 'hidden';
    });
  }

  // -------------------------------------------------------------- public

  resetCamera() {
    if (this.disposed || !this.camera) {
      return this;
    }

    this.cameraTween = null;
    this.camera.position.copy(this.homeCameraPosition);
    this.cameraTarget.copy(this.homeCameraTarget);
    this.camera.lookAt(this.cameraTarget);

    return this;
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

    this.running = true;
    this.clock.getDelta();

    this._tick = this._tick.bind(this);
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
    this.renderer.setSize(width, height, false);

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

    window.removeEventListener('resize', this._onResize);

    if (this.canvas && this._onPointerDown) {
      this.canvas.removeEventListener('pointerdown', this._onPointerDown);
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
