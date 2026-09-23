// P3-B slice 2: runtime planetary texture hot-swap, colour-space contract,
// graceful degradation and Saturn ring polar UV remapping.
//
// These tests drive the real production code paths: `SolarSystem`'s own
// `_loadPlanetaryTextures` / `_resolveTextureTarget` run against the real
// on-disk manifest, with only the two browser boundaries stubbed (global
// `fetch` and the injected `THREE.TextureLoader` factory, mirroring the
// existing `workerFactory` seam). No production logic is re-implemented here.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { PLANET_TABLE, SolarSystem } from '../../src/components/SolarSystem.js';
import {
  TEXTURE_MANIFEST_URL,
  TEXTURE_PACKAGE_BASE,
  fetchTextureManifest,
  remapRingToPolarUv,
  resolveTierAsset,
} from '../../src/components/solar/PlanetTextureLoader.js';

const solarSource = readFileSync(
  new URL('../../src/components/SolarSystem.js', import.meta.url),
  'utf8',
);
const manifestUrl = new URL('../../public/assets/solar/textures-v1/manifest.json', import.meta.url);
const readManifest = () => JSON.parse(readFileSync(manifestUrl, 'utf8'));
const MANIFEST = readManifest();

// Bodies whose albedo map must end up in sRGB. `saturn_ring` is declared
// `linear` by the manifest and is asserted separately.
const ALBEDO_BODIES = [
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'moon',
];

function trackedTexture(label) {
  const texture = new THREE.CanvasTexture({ width: 8, height: 4, label });
  texture.__label = label;
  texture.__disposed = false;
  texture.addEventListener('dispose', () => {
    texture.__disposed = true;
  });
  return texture;
}

function makeLoader({
  failUrl = () => false,
  deferred = false,
  defaultColorSpace = THREE.LinearSRGBColorSpace,
} = {}) {
  const requested = [];
  const produced = [];
  const queue = [];
  const loader = {
    load(url, onLoad, onProgress, onError) {
      requested.push(url);
      const run = () => {
        if (failUrl(url)) {
          onError(new Error(`HTTP 404 ${url}`));
          return;
        }
        const texture = new THREE.Texture({ width: 2048, height: 1024, src: url });
        texture.__url = url;
        texture.__disposed = false;
        // Hostile default: production must set the colour space explicitly,
        // a texture that merely kept the three.js default would be a false green.
        texture.colorSpace = defaultColorSpace;
        texture.addEventListener('dispose', () => {
          texture.__disposed = true;
        });
        produced.push(texture);
        onLoad(texture);
      };
      if (deferred) queue.push(run);
      else queueMicrotask(run);
      return new THREE.Texture();
    },
  };
  return { loader, requested, produced, flush: () => queue.splice(0).forEach((run) => run()) };
}

async function waitUntil(predicate, turns = 50) {
  for (let i = 0; i < turns && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!predicate()) throw new Error('waitUntil timed out');
}

function stubManifestFetch(manifest) {
  const fetchSpy = vi.fn(async (url) => {
    if (url !== TEXTURE_MANIFEST_URL) throw new Error(`unexpected fetch ${url}`);
    return { ok: true, status: 200, json: async () => manifest };
  });
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

function makeSystem({ isMobile = false, loader = null } = {}) {
  const disposables = [];
  const nav = { sun: 0, moon: 0, earth: 0 };
  const ephemerisTargets = {};

  const sphere = (radius) => new THREE.SphereGeometry(radius, 4, 3);
  for (const spec of PLANET_TABLE) {
    const map = trackedTexture(spec.name);
    const material = new THREE.MeshStandardMaterial({
      color: spec.color,
      map,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    const mesh = new THREE.Mesh(sphere(spec.radius), material);
    mesh.name = spec.name;
    ephemerisTargets[spec.name.toLowerCase()] = mesh;
    disposables.push(map);
  }
  ephemerisTargets.halley = new THREE.Group();

  const moonMap = trackedTexture('Moon');
  const moon = new THREE.Mesh(
    sphere(0.36),
    new THREE.MeshStandardMaterial({
      color: 0xcfcfcf,
      map: moonMap,
      roughness: 0.95,
      metalness: 0,
    }),
  );
  moon.name = 'Moon';
  ephemerisTargets.moon = moon;
  disposables.push(moonMap);

  const cloudAlpha = trackedTexture('EarthClouds');
  const earthCloudMesh = new THREE.Mesh(
    sphere(1.272),
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      alphaMap: cloudAlpha,
      transparent: true,
      opacity: 0.85,
      roughness: 0.95,
      metalness: 0,
      depthWrite: false,
    }),
  );
  disposables.push(cloudAlpha);

  const ringMap = trackedTexture('SaturnRing');
  const ringGeometry = new THREE.RingGeometry(2.6, 4.4, 8);
  remapRingToPolarUv(ringGeometry, 2.6, 4.4);
  const saturnRing = new THREE.Mesh(
    ringGeometry,
    new THREE.MeshStandardMaterial({
      map: ringMap,
      side: THREE.DoubleSide,
      roughness: 0.9,
      metalness: 0,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
    }),
  );
  disposables.push(ringMap);

  const hitButtons = [
    { el: { dataset: {}, style: {} }, mesh: ephemerisTargets.earth, onActivate: () => {} },
    { el: { dataset: {}, style: {} }, mesh: moon, onActivate: () => {} },
  ];

  const camera = new THREE.PerspectiveCamera(52, 16 / 9, 0.1, 500);
  camera.position.set(0, 26, 48);

  const system = Object.assign(Object.create(SolarSystem.prototype), {
    isMobile,
    disposed: false,
    disposables,
    options: {
      textureLoaderFactory: loader ? () => loader : undefined,
      onSunClick: () => {
        nav.sun += 1;
      },
      onMoonClick: () => {
        nav.moon += 1;
      },
      onEarthClick: () => {
        nav.earth += 1;
      },
    },
    ephemerisTargets,
    moon,
    earth: ephemerisTargets.earth,
    earthCloudMesh,
    saturnRing,
    hitButtons,
    camera,
    cameraTarget: new THREE.Vector3(0, 0, 0),
    cameraTween: null,
    cameraAtHome: true,
    homeCameraPosition: camera.position.clone(),
    homeCameraTarget: new THREE.Vector3(0, 0, 0),
    orbitState: { spherical: new THREE.Spherical() },
  });

  const proceduralMaps = new Map(disposables.map((texture) => [texture.__label, texture]));
  return { system, nav, proceduralMaps, hitButtons };
}

// P5 slice 1: the design's legibility matrix (design §2.1). Venus/Earth stay at
// 0.00 because they are already sunlit and Earth carries the hover emissive.
const LEGIBILITY_EMISSIVE = {
  Mercury: 0.22,
  Venus: 0.0,
  Earth: 0.0,
  Mars: 0.16,
  Jupiter: 0.25,
  Saturn: 0.2,
  Uranus: 0.22,
  Neptune: 0.32,
};

// Minimal 2D canvas boundary so the real `_buildPlanets()` can run head-less.
// Only the browser seam is faked; every material decision stays production's.
function stubCanvasBoundary() {
  const gradient = { addColorStop: () => {} };
  const context = {
    fillStyle: '',
    strokeStyle: '',
    clearRect: () => {},
    fillRect: () => {},
    beginPath: () => {},
    closePath: () => {},
    ellipse: () => {},
    arc: () => {},
    fill: () => {},
    stroke: () => {},
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
  };
  vi.stubGlobal('document', {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  });
}

// Runs the genuine `_buildPlanets()` / `_buildMoon()` builders, so the materials
// under assertion are the ones the browser would get.
function makeBuiltSystem({ isMobile = false, loader = null } = {}) {
  stubCanvasBoundary();
  const system = Object.assign(Object.create(SolarSystem.prototype), {
    isMobile,
    disposed: false,
    disposables: [],
    bodies: [],
    ephemerisTargets: {},
    scene: new THREE.Scene(),
    options: { textureLoaderFactory: loader ? () => loader : undefined },
  });
  system._buildPlanets();
  system._buildMoon();
  return system;
}

const planetMaterial = (system, name) => system.ephemerisTargets[name.toLowerCase()].material;

// Data-driven half of the contract: whatever the table says must be what the
// material got. This stays green under the zeroed-Jupiter mutant on purpose -
// it proves the compensation is read from `PLANET_TABLE`, not hard-coded.
function assertMaterialMatchesTable(system) {
  for (const spec of PLANET_TABLE) {
    const material = planetMaterial(system, spec.name);
    const scalar = spec.legibilityEmissive;
    expect(material.emissive.r, `${spec.name} emissive.r`).toBeCloseTo(scalar, 9);
    expect(material.emissive.g, `${spec.name} emissive.g`).toBeCloseTo(scalar, 9);
    expect(material.emissive.b, `${spec.name} emissive.b`).toBeCloseTo(scalar, 9);
    if (scalar > 0) {
      expect(material.map, `${spec.name} map`).toBeTruthy();
      // Same handle, not a clone: zero extra VRAM (design §1.1).
      expect(material.emissiveMap, `${spec.name} emissiveMap`).toBe(material.map);
    } else {
      expect(material.emissiveMap, `${spec.name} emissiveMap`).toBeNull();
    }
  }
}

// Value half of the contract: the design matrix itself, plus the bodies that
// must stay excluded. Turns red the moment a compensation is removed.
function assertDesignedLegibility(system) {
  for (const spec of PLANET_TABLE) {
    const material = planetMaterial(system, spec.name);
    const scalar = LEGIBILITY_EMISSIVE[spec.name];
    expect(scalar, `${spec.name} has a design value`).toBeTypeOf('number');
    expect(material.emissive.r, `${spec.name} designed emissive`).toBeCloseTo(scalar, 9);
    if (scalar > 0) expect(material.emissiveMap, `${spec.name} emissiveMap`).toBe(material.map);
    else expect(material.emissiveMap, `${spec.name} emissiveMap`).toBeNull();
  }
  // Design §6: the Moon projects to 1.85px, it is excluded from compensation.
  expect(system.moon.material.emissiveMap).toBeNull();
  expect(system.moon.material.emissive.getHex()).toBe(0x000000);
  // Ring and cloud shells must not pick up any emissive channel.
  expect(system.saturnRing.material.emissiveMap).toBeNull();
  expect(system.saturnRing.material.emissive.getHex()).toBe(0x000000);
  expect(system.earthCloudMesh.material.emissiveMap).toBeNull();
  expect(system.earthCloudMesh.material.emissive.getHex()).toBe(0x000000);
}

// Contract assertion under test. Kept falsifiable: the counterexample blocks
// below feed it tampered state and require it to throw.
function assertColourSpaceContract(system) {
  for (const name of ALBEDO_BODIES) {
    const target = system._resolveTextureTarget(name);
    expect(target, name).toBeTruthy();
    expect(target.material.map, name).toBeTruthy();
    expect(target.material.map.colorSpace, name).toBe(THREE.SRGBColorSpace);
  }
  // The cloud file is a grey-scale JPG (manifest: srgb) but it is bound to a
  // data slot, so the alpha ramp must stay linear regardless of that label.
  expect(MANIFEST.textures.earth_clouds.color_space).toBe('srgb');
  expect(system.earthCloudMesh.material.alphaMap.colorSpace).toBe(THREE.NoColorSpace);
}

function assertPolarRingUv(geometry, rIn, rOut) {
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  expect(position.count).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < position.count; i += 1) {
    const r = Math.hypot(position.getX(i), position.getY(i));
    expect(uv.getX(i), `u@${i}`).toBeCloseTo((r - rIn) / (rOut - rIn), 6);
    expect(uv.getY(i), `v@${i}`).toBe(0.5);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('P3-B planetary texture manifest plumbing', () => {
  it('exposes the versioned package paths used by the runtime', () => {
    expect(TEXTURE_PACKAGE_BASE).toBe('/assets/solar/textures-v1/');
    expect(TEXTURE_MANIFEST_URL).toBe('/assets/solar/textures-v1/manifest.json');
  });

  it('resolves desktop and mobile tier assets straight from the shipped manifest', () => {
    const earth = MANIFEST.textures.earth;
    expect(resolveTierAsset(earth, 'desktop')).toEqual({
      url: '/assets/solar/textures-v1/2k_earth_daymap.jpg',
      file: '2k_earth_daymap.jpg',
      colorSpace: 'srgb',
    });
    expect(resolveTierAsset(earth, 'mobile').url).toBe(
      '/assets/solar/textures-v1/2k_earth_daymap-1k.jpg',
    );
    expect(resolveTierAsset({ tiers: {} }, 'desktop')).toBeNull();
    expect(resolveTierAsset(null, 'desktop')).toBeNull();
  });

  it('rejects a non-ok manifest response instead of parsing garbage', async () => {
    await expect(
      fetchTextureManifest(TEXTURE_MANIFEST_URL, async () => ({ ok: false, status: 404 })),
    ).rejects.toThrow(/404/);
    await expect(
      fetchTextureManifest(TEXTURE_MANIFEST_URL, async () => ({
        ok: true,
        status: 200,
        json: async () => ({}),
      })),
    ).rejects.toThrow(/textures/);
  });
});

describe('P3-B texture hot swap and colour space', () => {
  it('replaces every procedural canvas map with the loader product and disposes the old one', async () => {
    const { system, proceduralMaps } = makeSystem({});
    const { loader, requested, produced } = makeLoader({});
    system.options.textureLoaderFactory = () => loader;
    stubManifestFetch(readManifest());

    for (const name of ALBEDO_BODIES) {
      expect(system._resolveTextureTarget(name).material.map.isCanvasTexture, name).toBe(true);
    }

    await system._loadPlanetaryTextures();

    const expectedUrls = Object.values(MANIFEST.textures).map(
      (meta) => `${TEXTURE_PACKAGE_BASE}${meta.tiers.desktop.file}`,
    );
    expect([...requested].sort()).toEqual([...expectedUrls].sort());
    expect(produced).toHaveLength(expectedUrls.length);

    for (const name of ALBEDO_BODIES) {
      const map = system._resolveTextureTarget(name).material.map;
      expect(map.isCanvasTexture, name).not.toBe(true);
      expect(produced, name).toContain(map);
      expect(map.__url, name).toBe(
        `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures[name].tiers.desktop.file}`,
      );
      expect(system.disposables, name).toContain(map);
    }

    for (const [label, texture] of proceduralMaps) {
      expect(texture.__disposed, label).toBe(true);
      expect(system.disposables, label).not.toContain(texture);
    }

    const clouds = system.earthCloudMesh.material;
    expect(clouds.alphaMap.__url).toBe(
      `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures.earth_clouds.tiers.desktop.file}`,
    );
    expect(clouds.map).toBeNull();
    expect(system.saturnRing.material.map.__url).toBe(
      `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures.saturn_ring.tiers.desktop.file}`,
    );
  });

  it('honours the manifest colour space: sRGB albedo, NoColorSpace cloud alpha', async () => {
    const { system } = makeSystem({});
    const { loader } = makeLoader({});
    system.options.textureLoaderFactory = () => loader;
    stubManifestFetch(readManifest());

    await system._loadPlanetaryTextures();

    assertColourSpaceContract(system);
    // saturn_ring is declared "linear" by the manifest -> NoColorSpace.
    expect(MANIFEST.textures.saturn_ring.color_space).toBe('linear');
    expect(system.saturnRing.material.map.colorSpace).toBe(THREE.NoColorSpace);
    for (const name of ALBEDO_BODIES) {
      expect(system._resolveTextureTarget(name).material.map.minFilter).toBe(
        THREE.LinearMipmapLinearFilter,
      );
      expect(system._resolveTextureTarget(name).material.map.generateMipmaps).toBe(true);
    }
  });

  it('counterexample: injecting LinearSRGB maps or an sRGB cloud alpha turns the contract red', async () => {
    const { system } = makeSystem({});
    const { loader } = makeLoader({});
    system.options.textureLoaderFactory = () => loader;
    stubManifestFetch(readManifest());
    await system._loadPlanetaryTextures();
    assertColourSpaceContract(system);

    const earthMap = system._resolveTextureTarget('earth').material.map;
    earthMap.colorSpace = THREE.LinearSRGBColorSpace;
    expect(() => assertColourSpaceContract(system)).toThrow();
    earthMap.colorSpace = THREE.SRGBColorSpace;
    assertColourSpaceContract(system);

    system.earthCloudMesh.material.alphaMap.colorSpace = THREE.SRGBColorSpace;
    expect(() => assertColourSpaceContract(system)).toThrow();
  });

  it('counterexample: a manifest declaring earth as linear makes production emit NoColorSpace', async () => {
    const tampered = readManifest();
    tampered.textures.earth.color_space = 'linear';
    const { system } = makeSystem({});
    const { loader } = makeLoader({});
    system.options.textureLoaderFactory = () => loader;
    stubManifestFetch(tampered);

    await system._loadPlanetaryTextures();

    // Proves the colour space is read from the manifest, not hard-coded.
    expect(system._resolveTextureTarget('earth').material.map.colorSpace).toBe(THREE.NoColorSpace);
    expect(system._resolveTextureTarget('mars').material.map.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(() => assertColourSpaceContract(system)).toThrow();
  });

  it('requests the 1K mobile tier when the mobile media query matched', async () => {
    const { system } = makeSystem({ isMobile: true });
    const { loader, requested } = makeLoader({});
    system.options.textureLoaderFactory = () => loader;
    stubManifestFetch(readManifest());

    await system._loadPlanetaryTextures();

    const expectedUrls = Object.values(MANIFEST.textures).map(
      (meta) => `${TEXTURE_PACKAGE_BASE}${meta.tiers.mobile.file}`,
    );
    expect([...requested].sort()).toEqual([...expectedUrls].sort());
    expect(requested.every((url) => url.includes('-1k.'))).toBe(true);
    assertColourSpaceContract(system);
  });

  it('drops textures that arrive after destroy() instead of resurrecting a disposed scene', async () => {
    const { system, proceduralMaps } = makeSystem({});
    const { loader, requested, produced, flush } = makeLoader({ deferred: true });
    system.options.textureLoaderFactory = () => loader;
    stubManifestFetch(readManifest());

    const pending = system._loadPlanetaryTextures();
    // Let the manifest resolve so every load is genuinely in flight, then
    // dispose before the decoded textures come back.
    await waitUntil(() => requested.length === Object.keys(MANIFEST.textures).length);
    system.disposed = true;
    flush();
    await pending;

    expect(produced).toHaveLength(Object.keys(MANIFEST.textures).length);
    expect(produced.every((texture) => texture.__disposed)).toBe(true);
    for (const name of ALBEDO_BODIES) {
      expect(system._resolveTextureTarget(name).material.map.isCanvasTexture, name).toBe(true);
      expect(produced, name).not.toContain(system._resolveTextureTarget(name).material.map);
    }
    for (const [label, texture] of proceduralMaps) {
      expect(texture.__disposed, label).toBe(false);
      expect(system.disposables, label).toContain(texture);
    }
    expect(system.disposables.filter((item) => produced.includes(item))).toEqual([]);
  });
});

describe('P3-B texture load degradation keeps the procedural scene', () => {
  const assertProceduralIntact = ({ system, proceduralMaps }) => {
    for (const name of ALBEDO_BODIES) {
      const map = system._resolveTextureTarget(name).material.map;
      expect(map.isCanvasTexture, name).toBe(true);
      expect(map.__disposed, name).toBe(false);
    }
    expect(system.earthCloudMesh.material.alphaMap.isCanvasTexture).toBe(true);
    expect(system.saturnRing.material.map.isCanvasTexture).toBe(true);
    for (const [label, texture] of proceduralMaps) {
      expect(system.disposables, label).toContain(texture);
    }
  };

  const assertNavigationIntact = ({ system, nav, hitButtons }) => {
    expect(system.hitButtons).toBe(hitButtons);
    expect(system.hitButtons).toHaveLength(2);
    system._activate('Sun');
    system._activate('Moon');
    expect(nav).toEqual({ sun: 1, moon: 1, earth: 0 });
    system._activate('Earth');
    expect(system.cameraTween).toBeTruthy();
    system.resetCamera();
    expect(system.cameraTween).toBeNull();
    expect(system.cameraAtHome).toBe(true);
    expect(system.camera.position.toArray()).toEqual(system.homeCameraPosition.toArray());
  };

  it('keeps procedural textures and navigation when the manifest 404s', async () => {
    const harness = makeSystem({});
    const { loader, requested } = makeLoader({});
    harness.system.options.textureLoaderFactory = () => loader;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    await harness.system._loadPlanetaryTextures();

    expect(requested).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/SolarTexture/);
    assertProceduralIntact(harness);
    assertNavigationIntact(harness);
  });

  it('keeps procedural textures when the manifest fetch rejects outright', async () => {
    const harness = makeSystem({});
    const { loader, requested } = makeLoader({});
    harness.system.options.textureLoaderFactory = () => loader;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await harness.system._loadPlanetaryTextures();

    expect(requested).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    assertProceduralIntact(harness);
    assertNavigationIntact(harness);
  });

  it('isolates a single failed texture: only that body keeps its canvas map', async () => {
    const harness = makeSystem({});
    const earthUrl = `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures.earth.tiers.desktop.file}`;
    const { loader, produced } = makeLoader({ failUrl: (url) => url === earthUrl });
    harness.system.options.textureLoaderFactory = () => loader;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubManifestFetch(readManifest());

    await harness.system._loadPlanetaryTextures();

    const earthMaterial = harness.system._resolveTextureTarget('earth').material;
    expect(earthMaterial.map.isCanvasTexture).toBe(true);
    expect(earthMaterial.map.__disposed).toBe(false);
    expect(harness.system.disposables).toContain(harness.proceduralMaps.get('Earth'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0].join(' ')).toMatch(/earth/);

    for (const name of ALBEDO_BODIES.filter((body) => body !== 'earth')) {
      const map = harness.system._resolveTextureTarget(name).material.map;
      expect(map.isCanvasTexture, name).not.toBe(true);
      expect(produced, name).toContain(map);
      expect(map.colorSpace, name).toBe(THREE.SRGBColorSpace);
    }
    assertNavigationIntact(harness);
  });
});

describe('P3-B Saturn ring polar UV remap', () => {
  it('maps u to the normalised radius and samples the v=0.5 centre row', () => {
    const geometry = new THREE.RingGeometry(2.6, 4.4, 8);
    expect(() => assertPolarRingUv(geometry, 2.6, 4.4)).toThrow();
    const versionBefore = geometry.attributes.uv.version;

    const returned = remapRingToPolarUv(geometry, 2.6, 4.4);

    expect(returned).toBe(geometry);
    assertPolarRingUv(geometry, 2.6, 4.4);
    // needsUpdate is write-only in three.js; the GPU upload flag is `version`.
    expect(geometry.attributes.uv.version).toBe(versionBefore + 1);
    const us = [...Array(geometry.attributes.uv.count).keys()].map((i) =>
      geometry.attributes.uv.getX(i),
    );
    expect(Math.min(...us)).toBeCloseTo(0, 6);
    expect(Math.max(...us)).toBeCloseTo(1, 6);
  });

  it('is wired into the production ring branch with the spec radii', () => {
    expect(solarSource).toMatch(
      /remapRingToPolarUv\(ringGeometry, spec\.ring\[0\], spec\.ring\[1\]\)/,
    );
    expect(solarSource).toContain('side: THREE.DoubleSide');
    expect(solarSource).toMatch(/ringMaterial[\s\S]{0,200}depthWrite: false/);
  });
});

describe('P3-B material parameters and untouched regressions', () => {
  it('uses the P3-B roughness/metalness table for rocky, Venus, Earth and gas giants', () => {
    const params = Object.fromEntries(
      PLANET_TABLE.map((spec) => [spec.name, [spec.roughness, spec.metalness]]),
    );
    expect(params.Mercury).toEqual([0.95, 0]);
    expect(params.Mars).toEqual([0.95, 0]);
    expect(params.Venus).toEqual([0.9, 0]);
    expect(params.Earth).toEqual([0.65, 0.05]);
    for (const name of ['Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
      expect(params[name], name).toEqual([0.75, 0]);
    }
    expect(solarSource).toMatch(/roughness: spec\.roughness/);
    expect(solarSource).toMatch(/metalness: spec\.metalness/);
    // Moon keeps the rocky pair.
    expect(solarSource).toMatch(/color: 0xcfcfcf,\s*roughness: 0\.95,\s*metalness: 0/);
  });

  it('rebuilds the cloud shell as an alphaMap-only material and keeps its slow spin', () => {
    const cloudMaterial = solarSource.match(
      /const cm = new THREE\.MeshStandardMaterial\(\{[^}]*\}\)/,
    )?.[0];
    expect(cloudMaterial).toBeTruthy();
    expect(cloudMaterial).toContain('color: 0xffffff');
    expect(cloudMaterial).toContain('alphaMap: ct');
    expect(cloudMaterial).toContain('transparent: true');
    expect(cloudMaterial).toContain('opacity: 0.85');
    expect(cloudMaterial).toContain('roughness: 0.95');
    expect(cloudMaterial).toContain('metalness: 0');
    expect(cloudMaterial).toContain('depthWrite: false');
    expect(cloudMaterial).not.toMatch(/(^|[^a-zA-Z])map:/);
    expect(solarSource).toContain('advanceOrbitalBodies(this.bodies, dt, this.earthCloudMesh)');
  });

  it('keeps the constructor async trigger and the untouched P1/P2/P3-A wiring', () => {
    expect(typeof SolarSystem.prototype._loadPlanetaryTextures).toBe('function');
    expect(typeof SolarSystem.prototype._resolveTextureTarget).toBe('function');
    const constructorBlock = solarSource.slice(
      solarSource.indexOf('constructor('),
      solarSource.indexOf('async _loadEphemerides()'),
    );
    expect(constructorBlock).toContain('this._loadPlanetaryTextures()');
    expect(constructorBlock).toContain('this._loadEphemerides();');
    // Untouched neighbours: hit buttons, belt sizing, ion tail, ephemeris drive.
    expect(solarSource).toContain('this.isMobile?500:1200');
    expect(solarSource).toContain('_buildHitButtons');
    expect(solarSource).toContain('updateEphemerisTargets({');
    expect((solarSource.match(/requestAnimationFrame/g) || []).length).toBe(1);
    expect((solarSource.match(/new THREE\.WebGLRenderer/g) || []).length).toBe(1);
  });
});

describe('P5 slice 1 texture-modulated emissive legibility compensation', () => {
  it('carries the design legibility matrix in PLANET_TABLE without disturbing the physics fields', () => {
    expect(
      Object.fromEntries(PLANET_TABLE.map((spec) => [spec.name, spec.legibilityEmissive])),
    ).toEqual(LEGIBILITY_EMISSIVE);
    // Physical invariants (design §3.3): axial tilts and radii must not move.
    expect(PLANET_TABLE.map((spec) => spec.tilt)).toEqual([
      0.001, 3.096, 0.409, 0.44, 0.055, 0.466, 1.706, 0.494,
    ]);
    expect(PLANET_TABLE.map((spec) => spec.radius)).toEqual([
      0.7, 1.1, 1.25, 0.95, 2.4, 2.0, 1.55, 1.48,
    ]);
    for (const spec of PLANET_TABLE) {
      expect(typeof spec.color, spec.name).toBe('number');
      expect(typeof spec.roughness, spec.name).toBe('number');
      expect(typeof spec.metalness, spec.name).toBe('number');
    }
  });

  it('binds emissiveMap to the very same texture handle as map for compensated bodies', () => {
    const system = makeBuiltSystem({});

    assertDesignedLegibility(system);
    assertMaterialMatchesTable(system);

    // Explicit, per-body spelling of the reuse claim: one handle, two slots.
    for (const name of ['Mercury', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
      const material = planetMaterial(system, name);
      expect(material.emissiveMap, name).toBe(material.map);
      expect(material.emissive.r, name).toBeCloseTo(LEGIBILITY_EMISSIVE[name], 9);
      // One handle tracked once: binding it twice must not double-register it.
      expect(
        system.disposables.filter((item) => item === material.map),
        name,
      ).toHaveLength(1);
    }
  });

  it('leaves Venus, Earth and the Moon on a null emissiveMap with zero emissive', () => {
    const system = makeBuiltSystem({});

    for (const name of ['Venus', 'Earth']) {
      const material = planetMaterial(system, name);
      expect(material.emissiveMap, name).toBeNull();
      expect(material.emissive.getHex(), name).toBe(0x000000);
      expect(material.map, name).toBeTruthy();
    }
    expect(system.moon.material.emissiveMap).toBeNull();
    expect(system.moon.material.emissive.getHex()).toBe(0x000000);
    // Hover highlight still starts from black, so `setScalar(0)` restores it.
    expect(solarSource).toMatch(
      /emissive\.setScalar\(\s*active\s*\?\s*0\.35\s*:\s*0\s*\)|emissive\.setScalar\(active \? 0\.35 : 0\)/,
    );
  });

  it('re-points emissiveMap at the hot-swapped CC-BY texture and keeps the excluded slots null', async () => {
    const { loader, produced } = makeLoader({});
    const system = makeBuiltSystem({ loader });
    stubManifestFetch(readManifest());
    const procedural = Object.fromEntries(
      PLANET_TABLE.map((spec) => [spec.name, planetMaterial(system, spec.name).map]),
    );
    const disposed = new Set();
    for (const [name, texture] of Object.entries(procedural)) {
      texture.addEventListener('dispose', () => disposed.add(name));
    }

    await system._loadPlanetaryTextures();

    assertDesignedLegibility(system);
    assertMaterialMatchesTable(system);

    for (const spec of PLANET_TABLE) {
      const material = planetMaterial(system, spec.name);
      const name = spec.name;
      // The map really was replaced by a loader product...
      expect(material.map, name).not.toBe(procedural[name]);
      expect(produced, name).toContain(material.map);
      expect(material.map.__url, name).toBe(
        `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures[name.toLowerCase()].tiers.desktop.file}`,
      );
      expect(system.disposables, name).not.toContain(procedural[name]);
      // ...and the emissive slot followed it to the *new* instance.
      if (LEGIBILITY_EMISSIVE[name] > 0) expect(material.emissiveMap, name).toBe(material.map);
      else expect(material.emissiveMap, name).toBeNull();
      // Base colour neutralised once, texture tracked exactly once.
      expect(material.color.getHex(), name).toBe(0xffffff);
      expect(
        system.disposables.filter((item) => item === material.map),
        name,
      ).toHaveLength(1);
    }

    // Ring / cloud / Moon untouched by the emissive channel after the swap.
    expect(disposed).toEqual(new Set(PLANET_TABLE.map((spec) => spec.name)));
    expect(system.saturnRing.material.map.__url).toBe(
      `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures.saturn_ring.tiers.desktop.file}`,
    );
    expect(system.saturnRing.material.emissiveMap).toBeNull();
    expect(system.earthCloudMesh.material.alphaMap.colorSpace).toBe(THREE.NoColorSpace);
    expect(system.earthCloudMesh.material.emissiveMap).toBeNull();
    expect(system.moon.material.map.__url).toBe(
      `${TEXTURE_PACKAGE_BASE}${MANIFEST.textures.moon.tiers.desktop.file}`,
    );
    expect(system.moon.material.emissiveMap).toBeNull();
    assertColourSpaceContract(system);
  });

  it('counterexample: zeroing Jupiter in the table strips its emissiveMap and turns the contract red', () => {
    const jupiter = PLANET_TABLE.find((spec) => spec.name === 'Jupiter');
    const original = jupiter.legibilityEmissive;
    try {
      jupiter.legibilityEmissive = 0;
      const mutant = makeBuiltSystem({});
      const material = planetMaterial(mutant, 'Jupiter');
      // Mutant 1 of design §4.2: compensation removed -> no emissive channel.
      expect(material.emissiveMap).toBeNull();
      expect(material.emissive.getHex()).toBe(0x000000);
      // Neptune, untouched, still carries it: the mutation is body-scoped.
      expect(planetMaterial(mutant, 'Neptune').emissiveMap).toBe(
        planetMaterial(mutant, 'Neptune').map,
      );
      // The design assertion must flip; the data-driven one must not.
      expect(() => assertDesignedLegibility(mutant)).toThrow();
      assertMaterialMatchesTable(mutant);
    } finally {
      jupiter.legibilityEmissive = original;
    }

    // Restored table -> both halves green again, so the flip was the mutation.
    const restored = makeBuiltSystem({});
    assertDesignedLegibility(restored);
    assertMaterialMatchesTable(restored);
  });

  it('counterexample: a hot swap that forgets emissiveMap leaves a stale handle behind', async () => {
    const { loader } = makeLoader({});
    const system = makeBuiltSystem({ loader });
    stubManifestFetch(readManifest());
    await system._loadPlanetaryTextures();
    assertDesignedLegibility(system);

    const material = planetMaterial(system, 'Neptune');
    const stale = new THREE.Texture({ width: 4, height: 2 });
    material.emissiveMap = stale;
    expect(() => assertDesignedLegibility(system)).toThrow();
    material.emissiveMap = material.map;
    assertDesignedLegibility(system);
  });
});
