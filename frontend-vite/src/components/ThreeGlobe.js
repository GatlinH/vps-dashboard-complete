import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { feature } from 'topojson-client';
import { getCountries } from '../api/public.js';

const EARTH_RADIUS = 1;
const STAR_COUNT = 1800;
const LOCATION_COORDS = [
  { match: ['singapore', '新加坡', 'sg-'], lat: 1.3521, lng: 103.8198 },
  { match: ['tokyo', '东京', 'jp-', 'sakura'], lat: 35.6762, lng: 139.6503 },
  { match: ['hong kong', '香港', 'hk-', 'hongkong'], lat: 22.3193, lng: 114.1694 },
  { match: ['frankfurt', '法兰克福', 'de-', 'hetzner'], lat: 50.1109, lng: 8.6821 },
  { match: ['los angeles', '洛杉矶', 'la-'], lat: 34.0522, lng: -118.2437 },
  { match: ['sydney', '悉尼'], lat: -33.8688, lng: 151.2093 },
  { match: ['melbourne', '墨尔本'], lat: -37.8136, lng: 144.9631 },
  { match: ['australia', 'australasia', '澳大利亚'], lat: -25.2744, lng: 133.7751 },
  { match: ['seoul', '首尔', 'korea', '韩国'], lat: 37.5665, lng: 126.978 },
  { match: ['beijing', '北京'], lat: 39.9042, lng: 116.4074 },
  { match: ['shanghai', '上海'], lat: 31.2304, lng: 121.4737 },
  { match: ['guangzhou', '广州'], lat: 23.1291, lng: 113.2644 },
  { match: ['shenzhen', '深圳'], lat: 22.5431, lng: 114.0579 },
  { match: ['dubai', '迪拜', 'uae', '阿联酋'], lat: 25.2048, lng: 55.2708 },
  { match: ['london', '伦敦', 'uk', 'united kingdom', '英国'], lat: 51.5072, lng: -0.1276 },
  { match: ['paris', '巴黎', 'france', '法国'], lat: 48.8566, lng: 2.3522 },
  { match: ['amsterdam', '阿姆斯特丹', 'netherlands', '荷兰'], lat: 52.3676, lng: 4.9041 },
  { match: ['san jose', 'fremont', 'silicon valley'], lat: 37.3382, lng: -121.8863 },
  { match: ['new york', '纽约'], lat: 40.7128, lng: -74.006 },
  { match: ['toronto', '多伦多', 'canada', '加拿大'], lat: 43.6532, lng: -79.3832 },
  { match: ['japan', '日本'], lat: 35.6762, lng: 139.6503 },
  { match: ['germany', '德国'], lat: 50.1109, lng: 8.6821 },
  { match: ['usa', 'united states', '美国'], lat: 34.0522, lng: -118.2437 },
];

const GEO_LABELS = [
  { name: '北美洲', lat: 47, lng: -108, kind: 'region' },
  { name: '南美洲', lat: -18, lng: -60, kind: 'region' },
  { name: '欧洲', lat: 54, lng: 18, kind: 'region' },
  { name: '非洲', lat: 9, lng: 18, kind: 'region' },
  { name: '亚洲', lat: 33, lng: 92, kind: 'region' },
  { name: '大洋洲', lat: -25, lng: 134, kind: 'region' },
  { name: '中国', lat: 35, lng: 104, kind: 'country' },
  { name: '印度', lat: 22, lng: 79, kind: 'country' },
  { name: '俄罗斯', lat: 61, lng: 96, kind: 'country' },
  { name: '美国', lat: 39, lng: -98, kind: 'country' },
  { name: '巴西', lat: -10, lng: -52, kind: 'country' },
  { name: '澳大利亚', lat: -25, lng: 134, kind: 'country' },
  { name: '埃及', lat: 27, lng: 30, kind: 'country' },
  { name: '沙特阿拉伯', lat: 24, lng: 45, kind: 'country' },
];

const GEOCODE_CACHE_KEY = 'threeglobe-geocode-cache-v1';
const GEOCODE_ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const GEOCODE_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const geocodeMemoryCache = new Map();

class GlobeControls {
  constructor(camera, domElement, options = {}) {
    this.camera = camera;
    this.domElement = domElement;
    this.target = new THREE.Vector3();
    this.minDistance = options.minDistance ?? 1.6;
    this.maxDistance = options.maxDistance ?? 7.2;
    this.rotateSpeed = options.rotateSpeed ?? 0.0052;
    this.zoomSpeed = options.zoomSpeed ?? 0.0018;
    this.noPan = true;
    this.noZoom = false;
    this.noRotate = false;
    this.distance = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.target), this.minDistance, this.maxDistance);
    this.pointerState = null;
    this.listeners = { start: new Set(), end: new Set(), rotate: new Set() };
    this.saved = null;

    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);

    this.domElement.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    this.domElement.addEventListener('wheel', this.onWheel, { passive: false });
    this.updateDistanceFromCamera();
  }

  addEventListener(type, handler) {
    this.listeners[type]?.add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners[type]?.delete(handler);
  }

  emit(type, payload) {
    this.listeners[type]?.forEach((handler) => handler(payload));
  }

  updateDistanceFromCamera() {
    this.distance = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.target) || this.distance || 1, this.minDistance, this.maxDistance);
  }

  onPointerDown(event) {
    if (event.button !== 0 || this.noRotate) return;
    this.pointerState = { x: event.clientX, y: event.clientY };
    this.domElement.setPointerCapture?.(event.pointerId);
    this.emit('start');
  }

  onPointerMove(event) {
    if (!this.pointerState) return;
    const dx = event.clientX - this.pointerState.x;
    const dy = event.clientY - this.pointerState.y;
    this.pointerState = { x: event.clientX, y: event.clientY };
    this.emit('rotate', { dx, dy });
  }

  onPointerUp() {
    if (!this.pointerState) return;
    this.pointerState = null;
    this.emit('end');
  }

  onWheel(event) {
    if (this.noZoom) return;
    event.preventDefault();
    const factor = 1 + (event.deltaY * this.zoomSpeed);
    this.distance = THREE.MathUtils.clamp(this.distance * factor, this.minDistance, this.maxDistance);
    const offset = this.camera.position.clone().sub(this.target).setLength(this.distance);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);
  }

  update() {
    const offset = this.camera.position.clone().sub(this.target);
    const length = offset.length() || this.distance || this.minDistance;
    this.distance = THREE.MathUtils.clamp(length, this.minDistance, this.maxDistance);
    this.camera.position.copy(this.target).add(offset.setLength(this.distance));
    this.camera.lookAt(this.target);
  }

  saveState() {
    this.saved = {
      target: this.target.clone(),
      position: this.camera.position.clone(),
      up: this.camera.up.clone(),
      distance: this.distance,
    };
  }

  reset() {
    if (!this.saved) return;
    this.target.copy(this.saved.target);
    this.camera.position.copy(this.saved.position);
    this.camera.up.copy(this.saved.up);
    this.distance = this.saved.distance;
    this.camera.lookAt(this.target);
  }

  dispose() {
    this.domElement.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    this.domElement.removeEventListener('wheel', this.onWheel);
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep01(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

function latLngToVec3(lat, lng, radius = EARTH_RADIUS) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lng + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function finiteCoord(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildLocationQuery(server) {
  const parts = [
    server.address,
    server.city,
    server.region,
    server.state,
    server.province,
    server.country,
    server.country_name,
    server.location,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const seen = new Set();
  return parts.filter((part) => {
    const key = part.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(', ');
}

function readGeocodeCache() {
  try {
    const raw = window.localStorage.getItem(GEOCODE_CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeGeocodeCache(cache) {
  try {
    window.localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function getCachedGeocode(query) {
  if (!query) return null;
  const mem = geocodeMemoryCache.get(query);
  if (mem && Date.now() - mem.cachedAt < GEOCODE_TTL_MS) return mem;
  const persisted = readGeocodeCache()[query];
  if (persisted && Date.now() - persisted.cachedAt < GEOCODE_TTL_MS) {
    geocodeMemoryCache.set(query, persisted);
    return persisted;
  }
  return null;
}

function setCachedGeocode(query, value) {
  if (!query || !value) return;
  const entry = { ...value, cachedAt: Date.now() };
  geocodeMemoryCache.set(query, entry);
  const cache = readGeocodeCache();
  cache[query] = entry;
  writeGeocodeCache(cache);
}

function pickLatLng(server) {
  const lat = finiteCoord(server.latitude ?? server.lat);
  const lng = finiteCoord(server.longitude ?? server.lng);
  if (lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    return { lat, lng, source: 'direct' };
  }

  const haystack = [
    server.location,
    server.address,
    server.city,
    server.region,
    server.state,
    server.province,
    server.country,
    server.country_name,
    server.group,
    server.name,
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' | ');

  for (const item of LOCATION_COORDS) {
    if (item.match.some((token) => haystack.includes(token))) {
      return { lat: item.lat, lng: item.lng, source: `fallback:${item.match[0]}` };
    }
  }
  return null;
}

async function geocodeServer(server) {
  const query = buildLocationQuery(server);
  if (!query) return null;

  const cached = getCachedGeocode(query);
  if (cached) {
    return { lat: cached.lat, lng: cached.lng, source: cached.source || 'geocode:cache', query };
  }

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  });

  try {
    const response = await fetch(`${GEOCODE_ENDPOINT}?${params.toString()}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const results = await response.json();
    const first = Array.isArray(results) ? results[0] : null;
    if (!first) return null;

    const lat = finiteCoord(first.lat);
    const lng = finiteCoord(first.lon);
    if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;

    const resolved = {
      lat,
      lng,
      source: 'geocode:nominatim',
      query,
      label: first.display_name || query,
    };
    setCachedGeocode(query, resolved);
    return resolved;
  } catch {
    return null;
  }
}

async function resolveServerLatLng(server) {
  const directOrFallback = pickLatLng(server);
  if (directOrFallback?.source === 'direct') return directOrFallback;

  const geocoded = await geocodeServer(server);
  if (geocoded) return geocoded;

  return directOrFallback;
}

function loadTexture(path, anisotropy = 8, colorSpace = THREE.SRGBColorSpace) {
  const texture = new THREE.TextureLoader().load(path);
  texture.colorSpace = colorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

function buildStarfield(scene) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i += 1) {
    const radius = 16 + Math.random() * 28;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos((Math.random() * 2) - 1);
    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.cos(phi);
    positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    const tint = 0.78 + Math.random() * 0.18;
    colors[i * 3] = tint * 0.92;
    colors[i * 3 + 1] = tint * 0.95;
    colors[i * 3 + 2] = tint;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const material = new THREE.PointsMaterial({ size: 0.03, transparent: true, opacity: 0.58, vertexColors: true });
  scene.add(new THREE.Points(geometry, material));
}

function createAtmosphereMesh() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.006, 192, 192),
    new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color('#9dc6ff') },
        sunColor: { value: new THREE.Color('#ffdca3') },
        lightDir: { value: new THREE.Vector3(-0.78, 0.42, 0.46).normalize() },
        intensity: { value: 0.18 },
        power: { value: 4.9 },
      },
      vertexShader: `
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - worldPos.xyz);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        uniform vec3 sunColor;
        uniform vec3 lightDir;
        uniform float intensity;
        uniform float power;
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        void main() {
          vec3 n = normalize(vNormalW);
          vec3 v = normalize(vViewDir);
          float fresnel = pow(1.0 - max(dot(n, v), 0.0), power);
          float sunSide = smoothstep(-0.08, 0.6, dot(n, normalize(lightDir)));
          float alpha = smoothstep(0.8, 1.0, fresnel) * mix(intensity * 0.82, intensity * 1.15, sunSide);
          vec3 color = mix(glowColor, sunColor, sunSide * 0.42);
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    }),
  );
}

function createNightBlendLayer(nightMap) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.0007, 192, 192),
    new THREE.ShaderMaterial({
      uniforms: {
        nightMap: { value: nightMap },
        lightDir: { value: new THREE.Vector3(-0.78, 0.42, 0.46).normalize() },
        tint: { value: new THREE.Color('#ffc887') },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D nightMap;
        uniform vec3 lightDir;
        uniform vec3 tint;
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          float d = dot(normalize(vNormalW), normalize(lightDir));
          float night = 1.0 - smoothstep(-0.64, 0.18, d);
          float duskLift = 1.0 - smoothstep(-0.08, 0.72, d);
          vec4 tex = texture2D(nightMap, vUv);
          float lum = dot(tex.rgb, vec3(0.299, 0.587, 0.114));
          float alpha = smoothstep(0.08, 0.58, lum) * night * 0.014;
          vec3 color = mix(tex.rgb, tint, 0.025 + duskLift * 0.012);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
}

function createTwilightLayer() {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.0012, 192, 192),
    new THREE.ShaderMaterial({
      uniforms: {
        lightDir: { value: new THREE.Vector3(-0.78, 0.42, 0.46).normalize() },
      },
      vertexShader: `
        varying vec3 vNormalW;
        void main() {
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform vec3 lightDir;
        varying vec3 vNormalW;
        void main() {
          float d = dot(normalize(vNormalW), normalize(lightDir));
          float a = smoothstep(-0.18, 0.1, d) * (1.0 - smoothstep(0.14, 0.42, d));
          gl_FragColor = vec4(0.28, 0.40, 0.68, a * 0.14);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    }),
  );
}

function createMapOverlay(dayMap) {
  return new THREE.Mesh(
    new THREE.SphereGeometry(1.001, 192, 192),
    new THREE.ShaderMaterial({
      uniforms: {
        dayMap: { value: dayMap },
        lightDir: { value: new THREE.Vector3(-0.78, 0.42, 0.46).normalize() },
        lineColor: { value: new THREE.Color('#7ea7d6') },
        coastColor: { value: new THREE.Color('#c6def6') },
      },
      vertexShader: `
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          vUv = uv;
          vec4 worldPos = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * worldPos;
        }
      `,
      fragmentShader: `
        uniform sampler2D dayMap;
        uniform vec3 lightDir;
        uniform vec3 lineColor;
        uniform vec3 coastColor;
        varying vec2 vUv;
        varying vec3 vNormalW;
        void main() {
          vec2 texel = vec2(1.0 / 2048.0, 1.0 / 1024.0);
          vec3 tex = texture2D(dayMap, vUv).rgb;
          float lum = dot(tex, vec3(0.299, 0.587, 0.114));
          float lumL = dot(texture2D(dayMap, vUv - vec2(texel.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
          float lumR = dot(texture2D(dayMap, vUv + vec2(texel.x, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
          float lumD = dot(texture2D(dayMap, vUv - vec2(0.0, texel.y)).rgb, vec3(0.299, 0.587, 0.114));
          float lumU = dot(texture2D(dayMap, vUv + vec2(0.0, texel.y)).rgb, vec3(0.299, 0.587, 0.114));

          float landMask = smoothstep(0.31, 0.69, lum);
          float edge = clamp(abs(lumR - lumL) + abs(lumU - lumD), 0.0, 1.0);
          float coast = smoothstep(0.042, 0.11, edge) * smoothstep(0.2, 0.8, landMask);

          float lon = abs(fract(vUv.x * 14.0) - 0.5);
          float lat = abs(fract(vUv.y * 7.0) - 0.5);
          float gridLon = 1.0 - smoothstep(0.485, 0.5, lon);
          float gridLat = 1.0 - smoothstep(0.485, 0.5, lat);
          float grid = max(gridLon * 0.42, gridLat * 0.32);

          float detailBands = 0.5 + 0.5 * sin(vUv.y * 96.0) * sin(vUv.x * 52.0);
          float terrainTrace = smoothstep(0.56, 0.76, lum) * (0.08 + 0.12 * detailBands);

          float lightMix = smoothstep(-0.22, 0.86, dot(normalize(vNormalW), normalize(lightDir)));
          float coastAlpha = coast * mix(0.062, 0.14, lightMix);
          float gridAlpha = landMask * grid * mix(0.014, 0.042, lightMix);
          float terrainAlpha = landMask * terrainTrace * mix(0.02, 0.044, lightMix);

          vec3 color = mix(lineColor, coastColor, clamp(coast * 1.28, 0.0, 1.0));
          float alpha = clamp(coastAlpha + gridAlpha + terrainAlpha, 0.0, 0.17);
          gl_FragColor = vec4(color, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    }),
  );
}

function createLayer(container, className) {
  const layer = document.createElement('div');
  layer.className = className;
  container.appendChild(layer);
  return layer;
}

function buildBorderLines(topology) {
  const world = feature(topology, topology.objects.countries);
  const group = new THREE.Group();
  for (const feat of world.features) {
    const polys = feat.geometry.type === 'Polygon' ? [feat.geometry.coordinates] : feat.geometry.coordinates;
    for (const poly of polys) {
      for (const ring of poly) {
        const points = ring.map(([lng, lat]) => latLngToVec3(lat, lng, 1.0015));
        const geom = new THREE.BufferGeometry().setFromPoints(points);
        const mat = new THREE.LineBasicMaterial({ color: 0xeaf2ff, transparent: true, opacity: 0.055 });
        group.add(new THREE.LineLoop(geom, mat));
      }
    }
  }
  return group;
}

function makeNodeSpriteTexture(color) {
  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(48, 48, 4, 48, 48, 40);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.18, 'rgba(255,255,255,0.92)');
  gradient.addColorStop(0.24, color);
  gradient.addColorStop(0.42, color.replace('rgb', 'rgba').replace(')', ',0.46)'));
  gradient.addColorStop(0.72, color.replace('rgb', 'rgba').replace(')', ',0.16)'));
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(48, 48, 40, 0, Math.PI * 2);
  ctx.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function colorForStatus(status) {
  if (status === 'online') return 'rgb(74, 222, 128)';
  if (status === 'warn') return 'rgb(251, 191, 36)';
  return 'rgb(248, 113, 113)';
}

function statusTextForServer(status) {
  if (status === 'online') return '在线';
  if (status === 'warn') return '波动';
  return '离线';
}

export class ThreeGlobe {
  constructor(selector, servers = [], options = {}) {
    this.container = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!this.container) throw new Error('ThreeGlobe container not found');

    this.options = {
      autoRotateSpeed: options.autoRotateSpeed ?? 0.0002,
      minDistance: options.minDistance ?? 1.6,
      maxDistance: options.maxDistance ?? 7.2,
      defaultDistance: options.defaultDistance ?? 2.35,
      earthOffsetX: options.earthOffsetX ?? 0,
      earthOffsetY: options.earthOffsetY ?? -0.04,
      enableStarship: options.enableStarship ?? false,
      starshipModelUrl: options.starshipModelUrl ?? '/globe/star_trek_dsc_enterprise_user.glb',
    };

    this.servers = [];
    this.onSelect = null;
    this.onHover = null;
    this.onFocusChange = null;
    this.pointer = new THREE.Vector2();
    this.raycaster = new THREE.Raycaster();
    this.nodeEntries = [];
    this.geoLabelEntries = [];
    this.hovered = null;
    this.focused = null;
    this.active = false;
    this.frame = null;
    this.rebuildToken = 0;
    this.clock = new THREE.Clock();
    this.starshipRoot = null;
    this.starshipModel = null;
    this.starshipMixer = null;
    this.starshipAnimationInfo = null;
    this.starshipLoadedAt = null;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(31, 1, 0.1, 1000);
    this.camera.position.set(0, 0.08, this.options.defaultDistance);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.domElement.className = 'three-globe-canvas';

    this.container.replaceChildren();
    this.container.appendChild(this.renderer.domElement);
    this.labelLayer = createLayer(this.container, 'three-globe-label-layer');
    this.geoLayer = createLayer(this.container, 'three-globe-geo-layer');
    this.sunBadge = createLayer(this.container, 'three-globe-sun-badge');
    this.sunBadge.replaceChildren(...['three-globe-sun-core', 'three-globe-sun-halo', 'three-globe-sun-glow'].map((className) => { const span = document.createElement('span'); span.className = className; return span; }));

    this.controls = new GlobeControls(this.camera, this.renderer.domElement, {
      minDistance: this.options.minDistance,
      maxDistance: this.options.maxDistance,
      rotateSpeed: 0.0048,
      zoomSpeed: 0.0014,
    });
    this.controls.addEventListener('rotate', ({ dx, dy }) => {
      const distanceSpan = Math.max(0.001, this.options.maxDistance - this.options.minDistance);
      const zoomT = THREE.MathUtils.clamp((this.controls.distance - this.options.minDistance) / distanceSpan, 0, 1);
      // Google Earth style, alternate strategy: close zoom is deliberate/slow for
      // precise local inspection; far zoom is faster so dragging can turn the whole globe.
      const midT = smoothstep01((zoomT - 0.18) / 0.62);
      const farT = smoothstep01((zoomT - 0.72) / 0.28);
      const dragDamping = THREE.MathUtils.lerp(0.45, 1.0, Math.max(midT, farT));
      this.lastDragDamping = dragDamping;
      window.__DBG__.THREE_GLOBE_DRAG_DEBUG = { zoomT, distance: this.controls.distance, dragDamping };
      const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * this.controls.rotateSpeed * dragDamping);
      const pitchAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(this.root.quaternion).normalize();
      const pitch = new THREE.Quaternion().setFromAxisAngle(pitchAxis, dy * this.controls.rotateSpeed * dragDamping);
      this.root.quaternion.premultiply(yaw).premultiply(pitch).normalize();
    });
    this.controls.addEventListener('start', () => {
      this.userInteracting = true;
    });
    this.controls.addEventListener('end', () => {
      this.lastInteractionAt = performance.now();
      this.userInteracting = false;
    });

    this.root = new THREE.Group();
    this.root.position.x = this.options.earthOffsetX;
    this.root.position.y = this.options.earthOffsetY;
    this.scene.add(this.root);

    buildStarfield(this.scene);
    this.scene.add(new THREE.AmbientLight(0xd9e8ff, 2.15));
    const sun = new THREE.DirectionalLight(0xfff4d7, 3.1);
    sun.position.set(-5.8, 3.1, 4.5);
    this.scene.add(sun);
    this.sunLight = sun;
    const fill = new THREE.DirectionalLight(0xbfdcff, 1.45);
    fill.position.set(2.6, -1.0, 1.8);
    this.scene.add(fill);
    this.fillLight = fill;
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb8c7dc, 2.05);
    this.scene.add(hemi);

    const dayMap = loadTexture('/globe/earth_atmos_2048.jpg', 12);
    const specMap = loadTexture('/globe/earth_specular_2048.jpg', 12);
    const nightMap = loadTexture('/globe/earth_lights_2048.png', 12);
    const cloudMap = loadTexture('/globe/earth_clouds_1024.png', 8);
    const normalMap = loadTexture('/globe/earth_normal_2048.jpg', 12, THREE.NoColorSpace);

    this.earth = new THREE.Mesh(
      new THREE.SphereGeometry(EARTH_RADIUS, 224, 224),
      new THREE.MeshStandardMaterial({
        map: dayMap,
        normalMap,
        normalScale: new THREE.Vector2(0.5, 0.5),
        roughnessMap: specMap,
        roughness: 0.62,
        metalness: 0.004,
        metalnessMap: specMap,
        emissiveMap: nightMap,
        emissive: new THREE.Color('#d8e7ff'),
        emissiveIntensity: 0.34,
      }),
    );
    this.root.add(this.earth);

    this.twilight = createTwilightLayer();
    this.root.add(this.twilight);

    this.nightLights = createNightBlendLayer(nightMap);
    this.root.add(this.nightLights);

    this.mapOverlay = createMapOverlay(dayMap);
    this.root.add(this.mapOverlay);

    this.clouds = new THREE.Mesh(
      new THREE.SphereGeometry(1.0032, 192, 192),
      new THREE.MeshStandardMaterial({
        map: cloudMap,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
      }),
    );
    this.root.add(this.clouds);

    this.atmosphere = createAtmosphereMesh();
    this.root.add(this.atmosphere);

    this.nodeGroup = new THREE.Group();
    this.root.add(this.nodeGroup);

    this.root.rotation.x = 0;
    this.root.rotation.y = 0;

    this.createGeoLabels();
    this.setServers(servers);
    if (this.options.enableStarship) this.loadStarshipIntoScene();

    this.handleResize = this.handleResize.bind(this);
    this.handlePointerMove = this.handlePointerMove.bind(this);
    this.handleClick = this.handleClick.bind(this);
    this.animate = this.animate.bind(this);

    window.addEventListener('resize', this.handleResize);
    this.renderer.domElement.addEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.addEventListener('mouseleave', () => this.setHovered(null));
    this.renderer.domElement.addEventListener('click', this.handleClick);
  }

  loadStarshipIntoScene() {
    if (this.starshipRoot) return;
    this.starshipRoot = new THREE.Group();
    this.starshipRoot.name = 'SingleRendererStarshipRoot';
    this.starshipRoot.position.set(-0.28, 0.04, 0.94);
    this.starshipRoot.rotation.set(0.24, -0.22, 0.04);
    this.starshipRoot.scale.setScalar(0.095);
    this.scene.add(this.starshipRoot);

    const startedAt = performance.now();
    const loader = new GLTFLoader();
    loader.load(this.options.starshipModelUrl, (gltf) => {
      const model = gltf.scene;
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const maxDim = Math.max(size.x, size.y, size.z, 0.001);
      const normalizeScale = 3.05 / maxDim;
      model.scale.setScalar(normalizeScale);
      model.position.set(-center.x * normalizeScale, -center.y * normalizeScale, -center.z * normalizeScale);
      model.rotation.set(0.58, Math.PI / 2 + 0.58, -0.32);
      model.traverse((object) => {
        if (!object.isMesh) return;
        object.frustumCulled = true;
        object.castShadow = false;
        object.receiveShadow = false;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        materials.forEach((material) => {
          if (!material) return;
          if ('envMapIntensity' in material) material.envMapIntensity = 0.68;
          if ('emissiveIntensity' in material) material.emissiveIntensity = Math.max(material.emissiveIntensity || 0, 0.03);
          if ('roughness' in material) material.roughness = Math.min(0.66, Math.max(0.38, material.roughness ?? 0.5));
        });
      });
      this.starshipRoot.add(model);
      this.starshipModel = model;
      if (gltf.animations?.length) {
        this.starshipMixer = new THREE.AnimationMixer(model);
        gltf.animations.forEach((clip) => this.starshipMixer.clipAction(clip).play());
        this.starshipAnimationInfo = gltf.animations.map((clip) => ({
          name: clip.name,
          duration: clip.duration,
          tracks: clip.tracks.map((track) => track.name),
        }));
      }
      this.starshipLoadedAt = performance.now();
      window.__DBG__.SINGLE_RENDERER_STARSHIP = {
        root: this.starshipRoot,
        model: this.starshipModel,
        mixer: this.starshipMixer,
        info: this.starshipAnimationInfo,
        loadMs: Math.round(this.starshipLoadedAt - startedAt),
        size: size.toArray(),
        normalizeScale,
      };
    }, undefined, (error) => {
      console.warn('[three-globe] single-renderer starship load failed', error);
      window.__DBG__.SINGLE_RENDERER_STARSHIP_ERROR = String(error?.message || error);
    });
  }

  createGeoLabels() {
    this.geoLayer.replaceChildren();
    this.geoLabelEntries = GEO_LABELS.map((item) => {
      const element = document.createElement('div');
      element.className = `three-globe-geo-label is-${item.kind}`;
      element.textContent = item.name;
      this.geoLayer.appendChild(element);
      return {
        ...item,
        element,
        vector: latLngToVec3(item.lat, item.lng, 1.0036),
      };
    });
  }

  async loadBorders() {
    if (this.borderGroup) return;
    try {
      const topo = await getCountries();
      this.borderGroup = buildBorderLines(topo);
      this.root.add(this.borderGroup);
    } catch (err) {
      console.warn('[three-globe] border load failed', err);
    }
  }

  setServers(servers = []) {
    this.servers = Array.isArray(servers) ? servers : [];
    this.rebuildNodes();
  }

  async rebuildNodes() {
    const token = ++this.rebuildToken;
    while (this.nodeGroup.children.length) this.nodeGroup.remove(this.nodeGroup.children[0]);
    this.labelLayer.replaceChildren();
    this.nodeEntries = [];

    const resolvedServers = await Promise.all(this.servers.map(async (server) => ({
      server,
      coords: await resolveServerLatLng(server),
    })));

    if (token !== this.rebuildToken) return;

    for (const { server, coords } of resolvedServers) {
      if (!coords) continue;
      const color = colorForStatus(server.status);
      const pos = latLngToVec3(coords.lat, coords.lng, 1.019);

      const group = new THREE.Group();
      group.position.copy(pos);
      group.lookAt(pos.clone().multiplyScalar(2));
      group.userData.server = server;
      group.userData.coordSource = coords.source;
      group.userData.coordQuery = coords.query || '';

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.022, 32, 32),
        new THREE.MeshBasicMaterial({ color, toneMapped: false, depthTest: false, depthWrite: false }),
      );
      group.add(core);

      const ring = new THREE.Mesh(
        new THREE.RingGeometry(0.031, 0.039, 64),
        new THREE.MeshBasicMaterial({ color: '#eef7ff', transparent: true, opacity: 0.62, side: THREE.DoubleSide, toneMapped: false, depthTest: false, depthWrite: false }),
      );
      ring.rotation.x = Math.PI / 2;
      group.add(ring);

      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeNodeSpriteTexture(color),
        transparent: true,
        opacity: 0.94,
        depthWrite: false,
        depthTest: false,
        toneMapped: false,
      }));
      glow.scale.setScalar(0.142);
      group.add(glow);

      this.nodeGroup.add(group);

      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'three-globe-label';
      const coordTag = coords.source === 'direct' ? '后台坐标' : coords.source.startsWith('fallback:') ? '名称定位' : 'IP定位';
      const beaconNote = String(server.location || '').trim();
      label.textContent = `${server.flag || '🌐'} ${server.name}${beaconNote ? ' · ' + beaconNote : ''}`;
      label.title = `${server.name}${beaconNote ? ' (' + beaconNote + ')' : ''} · ${statusTextForServer(server.status)} · ${coordTag}`;
      label.addEventListener('click', () => this.onSelect?.(server));
      this.labelLayer.appendChild(label);

      this.nodeEntries.push({
        server,
        vector: pos.clone(),
        group,
        core,
        ring,
        glow,
        label,
        coordSource: coords.source,
        coordQuery: coords.query || '',
      });
    }
  }

  setHovered(server, point = null) {
    this.hovered = server;
    const activeEntry = server ? this.nodeEntries.find((entry) => entry.server.id === server.id) : null;
    for (const entry of this.nodeEntries) {
      const active = server?.id === entry.server.id || this.focused?.id === entry.server.id;
      entry.label.classList.toggle('is-active', active);
    }
    this.onHover?.(server ? {
      server,
      point,
      coordSource: activeEntry?.coordSource || '',
      coordQuery: activeEntry?.coordQuery || '',
      public_note: activeEntry?.server?.public_note || activeEntry?.server?.publicRemark || activeEntry?.server?.public_remark || activeEntry?.server?.remark || (activeEntry?.server?.location && !String(activeEntry?.server?.region || '').trim() ? activeEntry.server.location : ''),
    } : null);
  }

  resetToHome() {
    this.focused = null;
    this.setHovered(null);
    // No intermediate focus badge/page: node selection jumps directly to details.
    this.controls.reset();
    this.controls.target.set(0, 0, 0);
    this.camera.position.set(0, 0.08, this.options.defaultDistance);
    this.root.rotation.x = 0;
    this.root.rotation.y = 0;
    this.controls.update();
  }

  updateCloudOpacity() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    const t = smoothstep01((distance - this.options.minDistance) / (5.4 - this.options.minDistance));
    this.clouds.material.opacity = THREE.MathUtils.lerp(0.02, 0.38, t);
  }

  updateSunLighting() {
    const light = this.sunLight;
    if (!light) return;
    this.root.updateMatrixWorld(true);

    const cameraDir = this.camera.position.clone().sub(this.controls.target).normalize();
    const viewRight = new THREE.Vector3().crossVectors(cameraDir, this.camera.up).normalize();
    const viewUp = new THREE.Vector3(0, 1, 0);

    const displayLightDir = cameraDir.clone()
      .addScaledVector(viewUp, 0.34)
      .addScaledVector(viewRight, -0.22)
      .normalize();

    light.position.copy(displayLightDir.clone().multiplyScalar(8.2));

    const sunDirLocal = displayLightDir.clone().applyQuaternion(this.root.quaternion.clone().invert()).normalize();
    const cameraDirLocal = cameraDir.clone().applyQuaternion(this.root.quaternion.clone().invert()).normalize();
    const alignment = THREE.MathUtils.clamp(displayLightDir.dot(cameraDir), -1, 1);
    const sunFacing = smoothstep01((alignment + 1.02) / 2.02);
    const frontLit = smoothstep01((sunDirLocal.z + 1.08) / 1.74);
    const viewerFacing = smoothstep01((cameraDirLocal.z + 0.92) / 1.34);
    const coreFront = smoothstep01((cameraDirLocal.z + 0.56) / 0.68);
    const frontalBloom = smoothstep01((cameraDirLocal.z + 0.22) / 0.46);
    const sideGlow = smoothstep01((sunDirLocal.x + 0.34) / 1.42);
    const broadLight = smoothstep01((cameraDirLocal.z + 0.78) / 1.28);
    const litBoost = THREE.MathUtils.clamp(
      0.2 + 0.1 * sunFacing + 0.22 * frontLit + 0.18 * viewerFacing + 0.16 * coreFront + 0.1 * frontalBloom + 0.08 * sideGlow,
      0.18,
      1,
    );

    this.earth.material.color.setRGB(
      THREE.MathUtils.lerp(1.0, 1.22, litBoost),
      THREE.MathUtils.lerp(1.0, 1.18, litBoost),
      THREE.MathUtils.lerp(1.0, 1.12, litBoost),
    );
    this.earth.material.emissive.setRGB(0.5, 0.56, 0.66);
    this.earth.material.emissiveIntensity = THREE.MathUtils.lerp(0.4, 0.58, Math.max(broadLight, 0.35));
    this.earth.material.roughness = THREE.MathUtils.lerp(0.68, 0.5, litBoost);
    this.earth.material.metalness = 0.004;
    this.earth.material.envMapIntensity = THREE.MathUtils.lerp(1.34, 1.58, litBoost);

    if (this.nightLights?.material?.uniforms?.lightDir) this.nightLights.material.uniforms.lightDir.value.copy(displayLightDir);
    if (this.mapOverlay?.material?.uniforms?.lightDir) this.mapOverlay.material.uniforms.lightDir.value.copy(displayLightDir);
    if (this.twilight?.material?.uniforms?.lightDir) this.twilight.material.uniforms.lightDir.value.copy(displayLightDir);
    if (this.atmosphere?.material?.uniforms?.lightDir) this.atmosphere.material.uniforms.lightDir.value.copy(displayLightDir);
  }

  getTierState() {
    const distance = this.camera.position.distanceTo(this.controls.target);
    return {
      distance,
      farOnlyEarth: distance > 4.8,
      midRegionOnly: distance > 2.9 && distance <= 4.8,
      nearFullDetail: distance <= 2.9,
    };
  }

  updateGeoLabels(tier) {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    const projected = new THREE.Vector3();
    const cameraDir = this.camera.position.clone().sub(this.controls.target).normalize();

    for (const entry of this.geoLabelEntries) {
      const worldVec = entry.vector.clone().applyQuaternion(this.root.quaternion).normalize();
      const facingRaw = worldVec.dot(cameraDir);
      const facing = smoothstep01((facingRaw - 0.08) / 0.28);
      const tierVisible = !tier.farOnlyEarth && (!tier.midRegionOnly || entry.kind === 'region');

      projected.copy(entry.vector).applyMatrix4(this.root.matrixWorld).project(this.camera);
      const onscreen = projected.z < 1 && projected.z > -1;
      const visible = onscreen && tierVisible && facing > 0.02;
      entry.element.style.display = visible ? 'block' : 'none';
      if (!visible) continue;

      const screenX = ((projected.x + 1) / 2) * width;
      const screenY = ((-projected.y + 1) / 2) * height;
      const scaleBase = entry.kind === 'region' ? 1 : 0.84;
      const zoomBoost = tier.nearFullDetail ? 1 : tier.midRegionOnly ? 0.92 : 0.8;
      const scale = clamp(scaleBase * zoomBoost * (0.82 + facing * 0.22), 0.6, 1.2);
      entry.element.style.opacity = `${clamp(0.18 + facing * 0.72, 0.18, 0.9)}`;
      entry.element.style.transform = `translate(${screenX}px, ${screenY}px) scale(${scale})`;
    }
  }

  updateNodes(tier) {
    const width = this.renderer.domElement.clientWidth;
    const height = this.renderer.domElement.clientHeight;
    const projected = new THREE.Vector3();
    const cameraDir = this.camera.position.clone().sub(this.controls.target).normalize();
    const distanceBias = tier.nearFullDetail ? 1.12 : tier.midRegionOnly ? 1.0 : 0.85;

    const nodeVisDebug = [];
    for (const entry of this.nodeEntries) {
      const worldVec = entry.vector.clone().applyQuaternion(this.root.quaternion).normalize();
      const facingRaw = worldVec.dot(cameraDir);
      const visible = !tier.farOnlyEarth && facingRaw > -0.34;
      const edgeFade = smoothstep01((facingRaw + 0.34) / 0.56);
      const distanceToCamera = this.camera.position.distanceTo(entry.group.getWorldPosition(new THREE.Vector3()));
      const perspective = clamp(2.35 / Math.max(distanceToCamera, 0.1), 0.62, 1.55);
      const isActive = this.hovered?.id === entry.server.id || this.focused?.id === entry.server.id;
      const emphasis = this.focused?.id === entry.server.id ? 1.22 : this.hovered?.id === entry.server.id ? 1.1 : 1;
      const scale = perspective * edgeFade * emphasis * distanceBias;

      entry.group.visible = visible;
      if (visible) {
        entry.group.scale.setScalar(clamp(scale, 1.12, 2.05));
        entry.glow.material.opacity = clamp(0.68 + edgeFade * 0.28, 0.68, 0.96);
        entry.ring.material.opacity = clamp(0.42 + edgeFade * 0.34, 0.42, 0.76);
      }

      projected.copy(entry.vector).applyMatrix4(this.root.matrixWorld).project(this.camera);
      const onscreen = projected.z < 1 && projected.z > -1;
      const showLabel = visible && onscreen && (tier.nearFullDetail || tier.midRegionOnly || isActive) && facingRaw > -0.28;
      entry.label.style.display = showLabel ? 'block' : 'none';
      if (!showLabel) continue;

      const rawScreenX = ((projected.x + 1) / 2) * width;
      const rawScreenY = ((-projected.y + 1) / 2) * height;
      const safeX = clamp(rawScreenX + 14, 22, Math.max(22, width - 230));
      const safeY = clamp(rawScreenY - 12 - scale * 18, 112, Math.max(112, height - 58));
      const labelScale = clamp(0.98 + scale * 0.22, 0.96, 1.24);
      const clampedToEdge = Math.abs(safeX - (rawScreenX + 14)) > 1 || Math.abs(safeY - (rawScreenY - 12 - scale * 18)) > 1;
      entry.label.style.opacity = `${clamp(0.7 + edgeFade * 0.3, 0.7, 1)}`;
      entry.label.style.transform = `translate(${safeX}px, ${safeY}px) scale(${labelScale})`;
      entry.label.classList.toggle('is-edge-pinned', clampedToEdge);
      entry.label.classList.toggle('is-active', isActive);
      nodeVisDebug.push({
        id: entry.server.id,
        name: entry.server.name,
        facingRaw: Number(facingRaw.toFixed(3)),
        visible,
        showLabel,
        x: Number(safeX.toFixed(1)),
        y: Number(safeY.toFixed(1)),
        edgePinned: clampedToEdge,
      });
    }
    window.__DBG__.THREE_GLOBE_NODE_VIS = nodeVisDebug;
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.nodeGroup.children, true);
    const hit = hits.find((item) => item.object.parent?.userData?.server || item.object.userData?.server) || null;
    return { rect, hit };
  }

  handlePointerMove(event) {
    const { rect, hit } = this.pick(event.clientX, event.clientY);
    if (!hit) {
      this.renderer.domElement.style.cursor = 'grab';
      this.setHovered(null);
      return;
    }
    const server = hit.object.userData.server || hit.object.parent?.userData?.server;
    this.renderer.domElement.style.cursor = 'pointer';
    this.setHovered(server, { px: event.clientX - rect.left, py: event.clientY - rect.top });
  }

  handleClick(event) {
    const { hit } = this.pick(event.clientX, event.clientY);
    if (!hit) return;
    const server = hit.object.userData.server || hit.object.parent?.userData?.server;
    if (!server) return;
    this.focused = server;
    this.onSelect?.(server);
  }

  handleResize() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.handleResize();
    if (typeof this.controls.saveState === 'function') this.controls.saveState();
    this.loadBorders();
    this.animate();
    window.__DBG__.THREE_GLOBE = this;
  }

  animate() {
    if (!this.active) return;
    this.frame = requestAnimationFrame(this.animate);
    const delta = Math.min(0.05, this.clock.getDelta());
    const now = performance.now();
    if (!this.userInteracting && (!this.lastInteractionAt || now - this.lastInteractionAt > 2200)) {
      this.root.rotation.y += this.options.autoRotateSpeed * 1.35;
    }
    this.clouds.rotation.y += this.options.autoRotateSpeed * 0.68;
    this.controls.update();
    this.updateCloudOpacity();
    this.updateSunLighting();
    const tier = this.getTierState();
    this.updateGeoLabels(tier);
    this.updateNodes(tier);
    if (this.starshipMixer) this.starshipMixer.update(delta);
    if (this.starshipRoot) {
      this.starshipRoot.position.y = 0.04 + Math.sin(now * 0.0007) * 0.006;
      this.starshipRoot.rotation.y = -0.22 + Math.sin(now * 0.00036) * 0.014;
      window.__DBG__.SINGLE_RENDERER_STARSHIP_STATS = {
        loaded: !!this.starshipModel,
        mixerTime: this.starshipMixer?.time || 0,
        animations: this.starshipAnimationInfo,
        canvasCount: document.querySelectorAll('canvas').length,
        rendererInfo: {
          calls: this.renderer.info.render.calls,
          triangles: this.renderer.info.render.triangles,
          geometries: this.renderer.info.memory.geometries,
          textures: this.renderer.info.memory.textures,
        },
      };
    }
    this.renderer.render(this.scene, this.camera);
  }

  stop() {
    this.active = false;
    if (this.frame) cancelAnimationFrame(this.frame);
  }

  destroy() {
    this.stop();
    window.removeEventListener('resize', this.handleResize);
    this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
    this.renderer.domElement.removeEventListener('click', this.handleClick);
    this.controls.dispose();
    this.starshipMixer?.stopAllAction?.();
    if (this.starshipRoot) this.scene.remove(this.starshipRoot);
    this.labelLayer?.remove();
    this.geoLayer?.remove();
    this.renderer.dispose();
    delete window.__DBG__.THREE_GLOBE;
  }
}
