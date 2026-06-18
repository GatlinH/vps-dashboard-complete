import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

export class StarshipShowcase {
  constructor(selector = '#starship-gltf-stage', options = {}) {
    this.container = typeof selector === 'string' ? document.querySelector(selector) : selector;
    this.options = { modelUrl: '/globe/star_trek_dsc_enterprise_user.glb', ...options };
    this._frame = null;
    this._destroyed = false;
    this.ship = null;
    this.gltfMixer = null;
    this.gltfClock = new THREE.Clock();
    this.gltfLastUpdate = null;
    this.gltfAnimationActions = [];
    this.registryDecal = null;
    this.exhaustGroup = null;
    this.exhaustVersion = 'weiyan11-ue-niagara-texture-safe';
    this.composer = null;
    this.userOffset = new THREE.Vector2(0, 0);
    this.userScale = 0.52;
    this.userYaw = 0;
    this.userRoll = 0;
    this.userFlip = 1;
    this._dragging = false;
    this._rotating = false;
    this._lastPointer = null;
    if (!this.container) return;
    this._init();
  }

  _init() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(34, Math.max(1, w) / Math.max(1, h), 0.1, 100);
    // Pull back slightly so the full imported ship silhouette is not clipped.
    this.camera.position.set(0.0, 0.06, 7.35);
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    this.renderer.setSize(Math.max(1, w), Math.max(1, h));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.autoClear = true;
    this.renderer.useLegacyLights = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.98;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.composer = new EffectComposer(this.renderer);
    this.composer.setSize(Math.max(1, w), Math.max(1, h));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(Math.max(1, w), Math.max(1, h)), 0.90, 0.65, 0.55);
    this.composer.addPass(this.bloomPass);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.02).texture;
    this.scene.environmentIntensity = 0.24;
    this.renderer.domElement.className = 'starship-gltf-canvas';
    this.container.appendChild(this.renderer.domElement);
    this.hitbox = document.createElement('div');
    this.hitbox.className = 'starship-interaction-hitbox';
    this.hitbox.setAttribute('aria-label', 'Hover starship: drag to move, wheel to scale, right-drag to rotate, double-click to flip');
    this.container.appendChild(this.hitbox);

    const ambientFloor = new THREE.AmbientLight(0x0a1830, 0.22);
    this.scene.add(ambientFloor);
    const key = new THREE.DirectionalLight(0xe7f1ff, 2.9);
    key.position.set(5.8, 4.6, 6.2);
    key.castShadow = true;
    key.shadow.mapSize.width = 2048;
    key.shadow.mapSize.height = 2048;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x54719c, 0.72);
    fill.position.set(-3.8, -1.0, 3.6);
    this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xb4d0ff, 0.95);
    rim.position.set(-4.5, 2.8, -5.0);
    this.scene.add(rim);
    const warm = new THREE.PointLight(0xff6a38, 0.66, 5.6);
    warm.position.set(-2.8, 1.8, 2.6);
    this.scene.add(warm);
    const windowGlow = new THREE.PointLight(0xdff6ff, 0.58, 4.8);
    windowGlow.position.set(0.6, 0.35, 1.8);
    this.scene.add(windowGlow);

    this.anchor = new THREE.Group();
    // Initial composition: dark-metal hero pose, lifted to reduce bottom crowding.
    this.basePosition = new THREE.Vector3(2.85, -0.28, 0.0);
    this.baseRotation = new THREE.Euler(0.62, -0.72, 0.18);
    this.anchor.position.copy(this.basePosition);
    this.anchor.rotation.copy(this.baseRotation);
    this.anchor.scale.setScalar(this.userScale);
    this.scene.add(this.anchor);

    const gltfLoader = new GLTFLoader();
    gltfLoader.load(this.options.modelUrl, (gltf) => {
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
        window.__starshipGltfAnimationInfo = this.ship.userData.gltfAnimationInfo;
      }
      this._normalizeUserModel(this.ship);
      this.ship.traverse((obj) => {
        if (!obj.isMesh || !obj.material) return;
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
          const materialName = `${mat.name || ''} ${obj.name || ''}`.toLowerCase();
          const isEmissivePart = materialName.includes('material_1') || (mat.emissive && mat.emissive.getHex && mat.emissive.getHex() !== 0x000000);
          if (isEmissivePart) {
            if (mat.color) mat.color.set(0xb8c4d6);
            if ('emissive' in mat) mat.emissive.set(0x7fb8ff);
            mat.envMapIntensity = 1.45;
            if ('metalness' in mat) mat.metalness = 0.40;
            if ('roughness' in mat) mat.roughness = 0.24;
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.35;
            mat.toneMapped = false;
          } else {
            if (mat.color) mat.color.set(0x5f6b7e);
            mat.envMapIntensity = 0.28;
            if ('metalness' in mat) mat.metalness = 0.76;
            if ('roughness' in mat) mat.roughness = 0.44;
            if ('emissive' in mat) mat.emissive.set(0x000000);
            if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0;
            mat.toneMapped = true;
          }
          obj.castShadow = true;
          obj.receiveShadow = true;
          mat.needsUpdate = true;
        });
      });
      this.anchor.add(this.ship);
      // clonefix1: disabled whole-ship cold edge clone for performance.
      // this._addColdEdgeShell(this.ship);
      // clonefix1: disabled whole-ship chromatic clone passes for performance.
      // this._addChromaticEdgePass(this.ship);
      // Keep nacelle exhaust as the only large blue-white energy effect; avoid saucer/mid-body glow blobs.
      // this._addShowcaseGlowRig();
      // Disable body/window glow sprites; keep blue-white only at nacelle exhaust ports.
      // this._addWindowGlowRig();
      // xinjian1 model swap: tail-exhaust VFX has been abandoned. Keep the GLB bussard animation only.
      // this._addExhaustRig();
      this.container.classList.add('is-loaded');
    }, undefined, (error) => {
      console.warn('[StarshipShowcase] GLB load failed', error);
      this.container.classList.add('is-error');
    });

    this._installInteractionHandlers();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize, { passive: true });
    this._start = performance.now();
    this._tick();
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
    this.exhaustGroup = new THREE.Group();
    this.exhaustGroup.name = 'Blue-white nacelle fluid exhaust rig - ship child';
    this.exhaustGroup.position.set(0, 0, 0);
    this.exhaustGroup.rotation.set(0, 0, 0);
    this.exhaustGroup.scale.set(1, 1, 1);
    this.exhaustModelSpace = null;
    this.exhaustNiagaraLayers = {
      EnergyCore: new THREE.Group(),
      Thrusters: new THREE.Group(),
      HeatHaze: new THREE.Group(),
      Particulates: new THREE.Group(),
    };
    Object.entries(this.exhaustNiagaraLayers).forEach(([name, group]) => {
      group.name = `UE Niagara ${name} emitter layer`;
      this.exhaustGroup.add(group);
    });
    const material = this._makeExhaustMaterial();
    this.exhaustMaterial = material;
    const plumeLength = 10.80;
    const geometry = this._makeIrregularPlasmaPlumeGeometry(plumeLength, 0.82, 96, 32, 11);
    const coreLengthRatio = 0.56;
    const coreGeo = new THREE.CylinderGeometry(0.026, 0.155, plumeLength * coreLengthRatio, 28, 1, true);
    const coreVertexShader = `
      varying float vAxisT;
      varying float vRadialT;
      void main() {
        vAxisT = clamp((position.y + 3.024) / 6.048, 0.0, 1.0);
        vRadialT = clamp(length(position.xz) / 0.155, 0.0, 1.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;
    const coreFragmentShader = `
      varying float vAxisT;
      varying float vRadialT;
      void main() {
        float radialFade = 1.0 - smoothstep(0.0, 1.0, vRadialT);
        float axialFade  = 1.0 - smoothstep(0.0, 1.0, vAxisT);
        float hotFront = 1.0 - smoothstep(0.0, 0.56, vAxisT);
        float alpha = pow(radialFade, 1.55) * axialFade;
        vec3 color = mix(vec3(0.03, 0.26, 1.0), vec3(0.92, 0.98, 1.0), clamp(radialFade * 1.25 + hotFront * 0.25, 0.0, 1.0));
        gl_FragColor = vec4(color * (1.72 + hotFront * 0.48), alpha * 0.26);
      }
    `;
    this.exhaustCoreMaterials = [];
    this.plasmaFilamentMaterials = [];
    this.particlePlumeMaterials = [];
    const ports = [
      [-4.00,  3.20, -4.50],
      [-4.00, -3.20, -4.50],
    ];
    ports.forEach(([x, y, z], idx) => {
      const plume = new THREE.Mesh(geometry, material);
      const tailScale = idx === 0 ? 1.04 : 1.24;
      const radialScale = idx === 0 ? 0.66 : 1.36;
      plume.name = `NE_Thrusters / M_Thrusters volumetric plume ${idx + 1}`;
      // Custom plume geometry is Y-axis based. In the current imported/model-normalized ship pose,
      // model-space -X projects downward on screen, while model-space -Z projects toward the visual tail/left.
      // Rotate local +Y -> model -Z and place the irregular plume center half a length behind the nacelle cap:
      // the wide/high-pressure region stays near the red nacelle/nozzle, the disturbed wake trails left/back.
      plume.position.set(x, y, z - (plumeLength * tailScale) / 2);
      plume.rotation.x = -Math.PI / 2;
      plume.scale.set(radialScale, tailScale, radialScale);
      plume.renderOrder = 20;
      plume.frustumCulled = false;
      plume.raycast = () => {};
      this.exhaustNiagaraLayers.Thrusters.add(plume);

      const coreMat = new THREE.ShaderMaterial({
        vertexShader: coreVertexShader,
        fragmentShader: coreFragmentShader,
        uniforms: { uTime: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      });
      const coreMesh = new THREE.Mesh(coreGeo, coreMat);
      coreMesh.name = `NE_EnergyCore white-blue inner column ${idx + 1}`;
      coreMesh.position.set(x, y, z - (plumeLength * coreLengthRatio * tailScale) / 2);
      coreMesh.rotation.copy(plume.rotation);
      coreMesh.scale.set((idx === 0 ? 0.58 : 1.28), tailScale, (idx === 0 ? 0.58 : 1.28));
      coreMesh.renderOrder = 22;
      coreMesh.frustumCulled = false;
      coreMesh.raycast = () => {};
      this.exhaustCoreMaterials.push(coreMat);
      this.exhaustNiagaraLayers.EnergyCore.add(coreMesh);

      const ribbon = this._makeExhaustRibbonMesh(plumeLength * tailScale, idx === 0 ? 0.70 : 1.48);
      ribbon.name = `NE_Thrusters torn blue-violet ribbon ${idx + 1}`;
      // PlaneGeometry length is local X; rotate so X runs along model -Z, centered behind nozzle.
      ribbon.position.set(x, y, z - (plumeLength * tailScale) / 2);
      ribbon.rotation.y = Math.PI / 2;
      ribbon.rotation.z = idx === 0 ? 0.10 : -0.10;
      ribbon.renderOrder = 24;
      this.exhaustNiagaraLayers.Thrusters.add(ribbon);

      // High-speed plasma filaments: animated cross-shear sheets that read as stretched ionized flow.
      const filamentBaseWidth = idx === 0 ? 0.46 : 0.82;
      const filamentSpecs = idx === 0
        ? [[0.00, 0.18, filamentBaseWidth, 0.92, 0.08], [0.18, -0.12, filamentBaseWidth * 0.72, 0.74, -0.18], [0.34, 0.02, filamentBaseWidth * 0.46, 0.54, 0.30]]
        : [[0.00, -0.22, filamentBaseWidth, 1.18, -0.08], [0.16, 0.18, filamentBaseWidth * 0.82, 0.92, 0.20], [0.34, -0.04, filamentBaseWidth * 0.58, 0.70, -0.32], [0.50, 0.10, filamentBaseWidth * 0.40, 0.48, 0.42]];
      filamentSpecs.forEach(([phase, yOff, width, intensity, roll], fIdx) => {
        const filament = this._makePlasmaFilamentMesh(plumeLength * tailScale * (idx === 0 ? 1.02 : 1.06), width, phase, intensity);
        filament.name = `Animated high-speed plasma filament ${idx + 1}.${fIdx + 1}`;
        filament.position.set(x, y + yOff, z - (plumeLength * tailScale) / 2);
        filament.rotation.y = Math.PI / 2;
        filament.rotation.z = roll;
        filament.renderOrder = 28 + fIdx;
        this.exhaustNiagaraLayers.Thrusters.add(filament);
      });

      // Broken tail wisps: small camera-facing blue/magenta fragments near the far end.
      // They make the plume fade as torn plasma instead of a clean triangular light sheet.
      const shardSpecs = idx === 0
        ? [[0.54, 0.30, 0.70, 0.30, 80, 160, 255, 0.40], [0.66, -0.22, 0.48, 0.20, 255, 55, 205, 0.34], [0.78, 0.12, 0.36, 0.16, 120, 80, 255, 0.30], [0.90, -0.16, 0.24, 0.11, 70, 130, 255, 0.22]]
        : [[0.48, -0.48, 1.20, 0.50, 80, 160, 255, 0.58], [0.62, 0.24, 0.56, 0.23, 255, 55, 205, 0.38], [0.74, -0.10, 0.42, 0.18, 120, 80, 255, 0.32], [0.86, 0.18, 0.30, 0.13, 70, 130, 255, 0.26], [0.96, -0.18, 0.20, 0.09, 255, 55, 205, 0.18]];
      shardSpecs.forEach(([t, yOff, sx, sy, r, g, b, op], shardIdx) => {
        const shard = this._makeGlowSprite(r, g, b, 1.0, op);
        shard.name = `Broken exhaust plasma wisp ${idx + 1}.${shardIdx + 1}`;
        shard.position.set(x, y + yOff, z - plumeLength * tailScale * t);
        shard.scale.set(sx, sy, 1);
        shard.renderOrder = 26;
        shard.frustumCulled = false;
        shard.raycast = () => {};
        this.exhaustNiagaraLayers.Particulates.add(shard);
      });

      const featherSpecs = idx === 0
        ? [[0.46, 0.52, .16, .055, 65,145,255,.16], [0.55,-0.56,.16,.06,250,70,210,.14], [0.70,0.42,.13,.05,80,115,255,.13], [0.84,-0.34,.10,.04,210,80,255,.10], [0.96,0.26,.08,.035,80,130,255,.08]]
        : [[0.38,-0.74,.30,.10,65,145,255,.24], [0.52,0.62,.18,.07,250,70,210,.16], [0.66,-0.48,.15,.055,80,115,255,.15], [0.80,0.38,.12,.045,210,80,255,.12], [0.93,-0.28,.09,.035,80,130,255,.09]];
      featherSpecs.forEach(([t, yOff, sx, sy, r, g, b, op], fIdx) => {
        const feather = this._makeGlowSprite(r, g, b, 1.0, op);
        feather.name = `Feathered exhaust edge fragment ${idx + 1}.${fIdx + 1}`;
        feather.position.set(x, y + yOff, z - plumeLength * tailScale * t);
        feather.scale.set(sx, sy, 1);
        feather.renderOrder = 27;
        feather.frustumCulled = false;
        feather.raycast = () => {};
        this.exhaustNiagaraLayers.Particulates.add(feather);
      });

      const nozzle = this._makeGlowSprite(232, 246, 255, 0.92, 0.92);
      nozzle.name = `NE_EnergyCore nozzle hot spawn ${idx + 1}`;
      nozzle.position.set(x, y, z);
      nozzle.renderOrder = 25;
      nozzle.frustumCulled = false;
      nozzle.raycast = () => {};
      this.exhaustNiagaraLayers.EnergyCore.add(nozzle);


      const vaporSheet = this._makeFluidVaporSheet(plumeLength * tailScale * (idx === 0 ? 1.10 : 1.18), idx === 0 ? 0.92 : 1.80, idx * 0.37);
      vaporSheet.name = `Transparent turbulent fluid exhaust sheet ${idx + 1}`;
      vaporSheet.position.set(x, y + (idx === 0 ? 0.06 : -0.08), z - (plumeLength * tailScale) / 2);
      vaporSheet.rotation.y = Math.PI / 2;
      vaporSheet.rotation.z = idx === 0 ? -0.42 : 0.36;
      vaporSheet.renderOrder = 29;
      this.exhaustNiagaraLayers.Thrusters.add(vaporSheet);

      const flipbookA = this._makeFlipbookExhaustMesh(plumeLength * tailScale * (idx === 0 ? 1.06 : 1.16), idx === 0 ? 0.86 : 1.64, idx * 0.23, 0.34);
      flipbookA.name = `Flipbook fluid exhaust skin A ${idx + 1}`;
      flipbookA.position.set(x, y + (idx === 0 ? 0.02 : -0.03), z - (plumeLength * tailScale) / 2);
      flipbookA.rotation.y = Math.PI / 2;
      flipbookA.rotation.z = idx === 0 ? -0.24 : 0.22;
      flipbookA.renderOrder = 30;
      this.exhaustNiagaraLayers.Thrusters.add(flipbookA);

      const flipbookB = this._makeFlipbookExhaustMesh(plumeLength * tailScale * (idx === 0 ? 1.00 : 1.10), idx === 0 ? 0.58 : 1.10, idx * 0.23 + 0.47, 0.26);
      flipbookB.name = `Flipbook fluid exhaust skin B ${idx + 1}`;
      flipbookB.position.set(x, y + (idx === 0 ? -0.08 : 0.10), z - (plumeLength * tailScale) / 2);
      flipbookB.rotation.y = Math.PI / 2;
      flipbookB.rotation.z = idx === 0 ? 0.54 : -0.50;
      flipbookB.renderOrder = 31;
      this.exhaustNiagaraLayers.Thrusters.add(flipbookB);

      const heatHaze = this._makeWeiyanHeatHazeMesh(plumeLength * tailScale * (idx === 0 ? 0.72 : 0.82), idx === 0 ? 0.64 : 1.20, idx * 0.31);
      heatHaze.name = `NE_HeatHaze / M_HeatHaze distortion sheet ${idx + 1}`;
      heatHaze.position.set(x, y + (idx === 0 ? 0.00 : 0.00), z - (plumeLength * tailScale) * 0.33);
      heatHaze.rotation.y = Math.PI / 2;
      heatHaze.rotation.z = idx === 0 ? 0.18 : -0.16;
      heatHaze.renderOrder = 32;
      this.exhaustNiagaraLayers.HeatHaze.add(heatHaze);

      const plumeLayers = idx === 0
        ? [
            ['nearfield', 260, plumeLength * 0.22, 0.24, 1.28, 1.42, 12.0, 31],
            ['core',      980, plumeLength * tailScale * 1.03, 0.28, 1.34, 1.10, 13.0, 32],
            ['sheath',   1180, plumeLength * tailScale * 1.02, 0.58, 1.18, 0.68, 14.0, 33],
            ['dissipate', 620, plumeLength * tailScale * 1.18, 0.70, 0.74, 0.44, 15.0, 34],
          ]
        : [
            ['nearfield', 340, plumeLength * 0.26, 0.38, 1.45, 1.26, 31.0, 31],
            ['core',     1320, plumeLength * tailScale * 1.06, 0.44, 1.48, 0.96, 32.0, 32],
            ['sheath',   1540, plumeLength * tailScale * 1.08, 0.96, 1.30, 0.58, 33.0, 33],
            ['dissipate', 900, plumeLength * tailScale * 1.24, 1.05, 0.86, 0.38, 34.0, 34],
          ];
      plumeLayers.forEach(([layer, count, length, radialScale, brightness, speed, seed, order], layerIdx) => {
        const particlePlume = this._makeParticlePlumeMesh({ x, y, z, count, length, radialScale, brightness, speed, seed, layer });
        particlePlume.name = `NE_Particulates curl-noise ${layer} ${idx + 1}`;
        particlePlume.renderOrder = order;
        this.exhaustNiagaraLayers.Particulates.add(particlePlume);
      });
    });
    // weiyan6: the earlier UE-style center plume layers were visually floating between/under the nacelles.
    // Clear them so the only visible exhaust is the two nozzle-anchored nacelle trails.
    Object.values(this.exhaustNiagaraLayers).forEach((layer) => {
      while (layer.children.length) layer.remove(layer.children[0]);
    });
    this._addWeiyan5DualNacelleWarpTrails(this.exhaustNiagaraLayers.Thrusters);
    (this.ship || this.anchor || this.scene).add(this.exhaustGroup);
    this.exhaustGroup.userData.boundToShip = !!this.ship;
    this.exhaustGroup.userData.boundToAnchor = false;
    this.exhaustGroup.userData.weiyanVersion = this.exhaustVersion;
    this.exhaustGroup.userData.niagaraEmitters = ['NE_EnergyCore', 'NE_Thrusters', 'NE_HeatHaze', 'NE_Particulates'];
    this.exhaustGroup.userData.weiyan11Structure = 'Safe UE/Niagara extracted texture pass: preserves ship binding and visible architecture, strengthens grunge smoke/particulate material dominance';
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
      window.__starshipGltfMixerTime = this.gltfMixer.time;
      window.__starshipGltfMixerTicks = (window.__starshipGltfMixerTicks || 0) + 1;
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
      if (this.exhaustGroup.parent === this.ship) {
        this.exhaustGroup.position.set(0, 0, 0);
        this.exhaustGroup.rotation.set(0, 0, 0);
        this.exhaustGroup.scale.set(1, 1, 1);
      } else if (this.exhaustGroup.parent === this.anchor) {
        this.exhaustGroup.position.set(0, 0, 0);
        this.exhaustGroup.rotation.set(0, 0, 0);
        this.exhaustGroup.scale.set(1, 1, 1);
      } else {
        this.exhaustGroup.position.copy(this.anchor.position);
        this.exhaustGroup.rotation.copy(this.anchor.rotation);
        this.exhaustGroup.scale.copy(this.anchor.scale);
      }
      if (this.exhaustMaterial?.uniforms?.uTime) this.exhaustMaterial.uniforms.uTime.value = t;
      if (this.exhaustGroup) {
        this.exhaustGroup.userData.liveLayerCounts = Object.fromEntries(Object.entries(this.exhaustNiagaraLayers || {}).map(([k, g]) => [k, g.children.length]));
        this.exhaustGroup.userData.weiyan5NacelleCount = this.weiyan5Root?.children?.length || 0;
      }
        this.exhaustGroup.traverse((obj) => {
          const mat = obj.material;
          const map = mat?.map;
          if (map && mat.userData?.ueNiagaraExtracted) {
            const textureName = mat.userData.textureName || '';
            const speed = textureName.includes('Particulate') ? 0.075 : 0.032;
            map.offset.x = (Math.sin(t * 0.23) * 0.015) % 1;
            map.offset.y = (t * speed) % 1;
          }
        });
        this.exhaustCoreMaterials?.forEach((mat) => { if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t; });
        this.plasmaFilamentMaterials?.forEach((mat) => { if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t; });
        this.particlePlumeMaterials?.forEach((mat) => { if (mat?.uniforms?.uTime) mat.uniforms.uTime.value = t; });
    }
    // Use direct transparent rendering on the homepage. EffectComposer/UnrealBloomPass
    // outputs an opaque black rectangle in a partial overlay canvas, which darkens the Earth
    // or forces screen blending that makes the ship look transparent.
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.scene, this.camera);
    this._frame = requestAnimationFrame(() => this._tick());
  }

  resize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = Math.max(1, w) / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(Math.max(1, w), Math.max(1, h));
    this.composer?.setSize(Math.max(1, w), Math.max(1, h));
    this.bloomPass?.setSize?.(Math.max(1, w), Math.max(1, h));
  }

  destroy() {
    this._destroyed = true;
    if (this._frame) cancelAnimationFrame(this._frame);
    this.gltfMixer?.stopAllAction?.();
    this.gltfMixer = null;
    this.gltfLastUpdate = null;
    this.gltfAnimationActions = [];
    window.removeEventListener('resize', this._onResize);
    this.scene?.traverse((obj) => {
      obj.geometry?.dispose?.();
      const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
      mats.forEach((m) => { m.map?.dispose?.(); m.dispose?.(); });
    });
    window.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointermove', this._onPointerMove, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('pointercancel', this._onPointerUp, true);
    window.removeEventListener('wheel', this._onWheel, { capture: true });
    window.removeEventListener('dblclick', this._onDoubleClick, true);
    window.removeEventListener('contextmenu', this._onContextMenu, true);
    document.body.classList.remove('starship-hovering', 'starship-grabbing');
    this.composer?.dispose?.();
    this.renderer?.dispose?.();
    this.hitbox?.remove?.();
    this.renderer?.domElement?.remove?.();
  }
}
