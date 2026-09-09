import * as THREE from 'three';

// Solar system widget: real orbital revolution, keyboard-reachable bodies,
// a single rAF loop that also drives the camera approach tween.

const MOBILE_QUERY = '(max-width: 720px)';
const HOME_FOV = 52;
const TARGET_RADIUS = (19 + 2.6 + 1.25) * 1.1; // world units, 10% fit margin

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
    this._hitWorldScratch = new THREE.Vector3();

    this.clock = null;
    this.frameId = 0;
    this.cameraTween = null; // { t, dur, from, to, lookFrom, lookTo, done }
    this.cameraAtHome = true;
    this.orbitState = { spherical: new THREE.Spherical(), isDragging: false, pointerStart: new THREE.Vector2(), dragMoved: false, motionState: 'running', resumeTimerId: null, resumeDelayMs: 2800, pauseStartTime: 0 };
    this._touchState = null;

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
    this._buildSun();
    this._buildPlanets();
    this._buildMoon();
    this._buildHitButtons();
    this._bindEvents();

    this._tick = this._tick.bind(this);
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
    const width = Math.max(1, Math.round(rect.width || this.container.clientWidth || 640));
    const height = Math.max(1, Math.round(rect.height || this.container.clientHeight || 360));
    return { width, height };
  }

  _fitHomeCamera(width, height) {
    const aspect = width / height;
    const hfovHalf = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * aspect);
    const baseDistance = this.baseCameraPosition.length();
    const requiredDist = TARGET_RADIUS / Math.tan(hfovHalf);
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

      if (spec.name === 'Saturn') {
        const ringGeometry = new THREE.RingGeometry(2.6, 4.4, this.isMobile ? 48 : 96);
        const ringMaterial = new THREE.MeshStandardMaterial({ map: this._generateSaturnRingTexture(), side: THREE.DoubleSide, roughness: 0.7, metalness: 0.1, transparent: true });
        const ring = new THREE.Mesh(ringGeometry, ringMaterial);
        ring.rotation.x = Math.PI / 2 - 0.35;
        mesh.add(ring);
        this._track(ringGeometry, ringMaterial);
      }

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
    this._buildHalleyComet();
    this._buildAsteroidBelt();
  }

  _generateSaturnRingTexture() { const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 1; const ctx = canvas.getContext('2d'); const stops = [[0,'rgba(90,70,45,.45)'],[.12,'rgba(180,160,120,.7)'],[.25,'rgba(110,100,90,.5)'],[.38,'rgba(210,195,160,.8)'],[.48,'rgba(30,30,35,.15)'],[.58,'rgba(200,185,150,.75)'],[.8,'rgba(150,130,100,.6)'],[.9,'rgba(40,35,30,.2)'],[1,'rgba(170,150,110,.5)']]; const g=ctx.createLinearGradient(0,0,512,0); stops.forEach(([p,c])=>g.addColorStop(p,c)); ctx.fillStyle=g; ctx.fillRect(0,0,512,1); const tex=new THREE.CanvasTexture(canvas); this._track(tex); return tex; }

  _buildHalleyComet() { const nucleus = new THREE.Mesh(new THREE.SphereGeometry(.35,12,8), new THREE.MeshBasicMaterial({color:0xdff6ff})); this._track(nucleus.geometry,nucleus.material); const tailTexCanvas=document.createElement('canvas'); tailTexCanvas.width=128; tailTexCanvas.height=8; const c=tailTexCanvas.getContext('2d'); const g=c.createLinearGradient(0,0,128,0); g.addColorStop(0,'rgba(220,250,255,.9)'); g.addColorStop(1,'rgba(120,200,255,0)'); c.fillStyle=g;c.fillRect(0,0,128,8); const tailTex=new THREE.CanvasTexture(tailTexCanvas); const tail=new THREE.Mesh(new THREE.PlaneGeometry(1,1),new THREE.MeshBasicMaterial({map:tailTex,transparent:true,side:THREE.DoubleSide,depthWrite:false})); this._track(tail.geometry,tail.material,tailTex); const group=new THREE.Group(); group.add(nucleus,tail); this.scene.add(group); const orbitGeom=new THREE.BufferGeometry().setFromPoints(Array.from({length:128},(_,i)=>{const t=i/128*Math.PI*2,r=14.34/(1+.789*Math.cos(t)); return new THREE.Vector3(r*Math.cos(t),r*Math.sin(t)*Math.sin(Math.PI/12),r*Math.sin(t)*Math.cos(Math.PI/12));})); const orbitMat=new THREE.LineBasicMaterial({color:0x406080,transparent:true,opacity:.18}); this.scene.add(new THREE.LineLoop(orbitGeom,orbitMat)); this._track(orbitGeom,orbitMat); this.halley={group,nucleus,tail,theta:0}; }

  _buildAsteroidBelt() { const count=this.isMobile?500:1200; const geo=new THREE.DodecahedronGeometry(.15,0); const mat=new THREE.MeshStandardMaterial({color:0x887766,roughness:1}); const mesh=new THREE.InstancedMesh(geo,mat,count); const m=new THREE.Matrix4(); for(let i=0;i<count;i++){const r=27.5+Math.random()*4.3,a=Math.random()*Math.PI*2,y=(Math.random()*2-1)*.35; m.makeRotationFromEuler(new THREE.Euler(Math.random(),Math.random(),Math.random())); m.setPosition(r*Math.cos(a),y,r*Math.sin(a)); mesh.setMatrixAt(i,m); mesh.userData={r,a,y,spin:Math.random()};} this.scene.add(mesh); this.asteroidBelt=mesh; this._track(geo,mat); }

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
    if (shouldAdvance) {
      this._advanceBodies(dt);
    }
    this.debug.solarOrbitMotionState = this.orbitState.motionState;
    this.debug.solarOrbitResumeRemainingMs = this.orbitState.motionState === 'paused' ? Math.max(0, this.orbitState.resumeDelayMs - (Date.now() - this.orbitState.pauseStartTime)) : 0;
    this._stepCameraTween(dt);
    if (!this.cameraTween) { this.camera.position.setFromSpherical(this.orbitState.spherical).add(this.cameraTarget); this.camera.lookAt(this.cameraTarget); }
    this._syncHitButtons();

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
    if (this.halley) { const h=this.halley; h.theta += 0.08*Math.pow(38/(14.34/(1+.789*Math.cos(h.theta))),1.25)*dt; const r=14.34/(1+.789*Math.cos(h.theta)); h.group.position.set(r*Math.cos(h.theta),r*Math.sin(h.theta)*Math.sin(Math.PI/12),r*Math.sin(h.theta)*Math.cos(Math.PI/12)); const len=THREE.MathUtils.clamp(16*(8/r),2,15); h.tail.scale.set(len,1,1); h.tail.quaternion.setFromUnitVectors(new THREE.Vector3(1,0,0),h.group.position.clone().normalize()); h.tail.material.opacity=THREE.MathUtils.clamp(.12+(.85-.12)*(8/r),.12,.85); }
  }

  // Project each tracked mesh to screen space and park its hit button there.
  _syncHitButtons() {
    if (this.disposed || !this.canvas || !this.hitButtons.length) {
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const projected = new THREE.Vector3();
    const entries = this.hitButtons.map((entry) => {
      const world = entry.mesh.getWorldPosition(this._hitWorldScratch).clone();
      const ndc = world.clone().project(this.camera);
      return { entry, world, ndc };
    });
    const earthRow = entries.find((item) => item.entry.mesh === this.earth);
    const moonRow = entries.find((item) => item.entry.mesh === this.moon);
    const earth = earthRow && earthRow.entry;
    const moon = moonRow && moonRow.entry;
    let separation = null;
    if (earth && moon) {
      const er = earthRow.ndc;
      const mr = moonRow.ndc;
      separation = {
        dx: (er.x - mr.x) * rect.width * 0.5,
        dy: -(er.y - mr.y) * rect.height * 0.5,
        distance: Math.hypot((er.x - mr.x) * rect.width * 0.5, (er.y - mr.y) * rect.height * 0.5),
      };
    }

    const sizes = new Map(entries.map(({ entry, world }) => {
      const scale = entry.mesh.geometry.parameters.radius || 1;
      return [entry, Math.max(24, Math.min(120, (scale * 260) / Math.max(6, this.camera.position.distanceTo(world))))];
    }));
    const earthSize = sizes.get(earth) || 24;
    const moonSize = sizes.get(moon) || 24;
    // Boxes must not overlap: centres need to clear (sizeA + sizeB) / 2. Keep 10% margin.
    const separationThreshold = (earthSize + moonSize) * 0.5 * 1.1;
    entries.forEach(({ entry, ndc: projected }) => {

      const visible = projected.z < 1 && projected.x >= -1 && projected.x <= 1 && projected.y >= -1 && projected.y <= 1;
      const left = (projected.x * 0.5 + 0.5) * rect.width;
      const top = (-projected.y * 0.5 + 0.5) * rect.height;

      const size = sizes.get(entry) || 24;
      let offsetX = 0;
      let offsetY = 0;
      if (separation && separation.distance < separationThreshold && (entry === earth || entry === moon)) {
        const len = separation.distance;
        const ux = len >= 0.5 ? separation.dx / len : 1;
        const uy = len >= 0.5 ? separation.dy / len : 0;
        const direction = entry === earth ? 1 : -1;
        // Never push a button so far that its own body's projected point leaves the box.
        const maxShift = size * 0.5 - 1;
        const shift = Math.min((separationThreshold - separation.distance) * 0.5, maxShift);
        offsetX = direction * ux * shift;
        offsetY = direction * uy * shift;
      }

      entry.el.style.left = `${left + offsetX}px`;
      entry.el.style.top = `${top + offsetY}px`;
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
    this.homeCameraPosition = this._fitHomeCamera(width, height);
    if (this.cameraAtHome) {
      this.camera.position.copy(this.homeCameraPosition);
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

    window.removeEventListener('resize', this._onResize);

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
