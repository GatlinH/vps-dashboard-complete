import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { DustTailRenderer } from '../../src/components/solar/DustTailRenderer.js';
import { physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';

const owned = [];
const makeTail = () => {
  const tail = new DustTailRenderer({ scene: new THREE.Scene(), physicalToDisplay });
  owned.push(tail);
  return tail;
};

function assertMask(material) {
  if (!material.map) throw new Error('MASK_MISSING');
  const { data, width, height } = material.map.image;
  if (!data || width !== 32 || height !== 32) throw new Error('SQUARE_SUPPORT');
  for (const pixel of [0, width - 1, width * (height - 1), width * height - 1]) {
    if (data[pixel * 4 + 3] !== 0) throw new Error('SQUARE_SUPPORT');
  }
  expect(data[(16 * width + 16) * 4 + 3], 'MASK_EMPTY').toBeGreaterThan(0);
}

function buildNucleus() {
  vi.stubGlobal('document', {
    createElement: () => ({
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
      }),
    }),
  });
  const system = Object.assign(Object.create(SolarSystem.prototype), {
    scene: new THREE.Scene(),
    disposables: [],
  });
  system._buildHalleyComet();
  owned.push({ dispose: () => system.disposables.forEach((resource) => resource.dispose()) });
  return system.halley;
}

afterEach(() => {
  owned.splice(0).forEach((resource) => resource.dispose());
  vi.unstubAllGlobals();
});

describe('Halley production radial mask', () => {
  it('rejects the existing missing map and opaque square controls', () => {
    const tail = makeTail();
    assertMask(tail.material);
    const originalMap = tail.material.map;
    tail.material.map = null;
    expect(() => assertMask(tail.material)).toThrow('MASK_MISSING');
    tail.material.map = originalMap;
    const originalData = originalMap.image.data.slice();
    try {
      originalMap.image.data.fill(255);
      expect(() => assertMask(tail.material)).toThrow('SQUARE_SUPPORT');
    } finally {
      originalMap.image.data.set(originalData);
    }
  });

  it('samples white RGBA cos-squared finite support with linear filtering', () => {
    const { material } = makeTail();
    assertMask(material);
    expect(material.opacity).toBe(0.55);
    expect(material.map.isDataTexture).toBe(true);
    expect(material.map.minFilter).toBe(THREE.LinearFilter);
    expect(material.map.magFilter).toBe(THREE.LinearFilter);
    expect(material.map.generateMipmaps).toBe(false);
    const data = material.map.image.data;
    for (let row = 0; row < 32; row += 1) {
      for (let column = 0; column < 32; column += 1) {
        const offset = (row * 32 + column) * 4;
        const radius = Math.hypot((2 * column) / 31 - 1, (2 * row) / 31 - 1);
        expect(Array.from(data.subarray(offset, offset + 3))).toEqual([255, 255, 255]);
        const expected = radius < 1 ? Math.round(255 * Math.cos((Math.PI * radius) / 2) ** 2) : 0;
        expect(data[offset + 3], 'SQUARE_SUPPORT').toBe(expected);
      }
    }
  });

  it('owns one shared texture and releases each resource exactly once', () => {
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const tail = makeTail();
      assertMask(tail.material);
      const resources = [tail.geometry, tail.material, tail.material.map];
      const releases = resources.map((resource) => {
        const listener = vi.fn();
        resource.addEventListener('dispose', listener);
        return listener;
      });
      expect(tail.points.material.map).toBe(tail.material.map);
      tail.dispose();
      tail.dispose();
      expect(tail.scene.children, 'RESOURCE_LEAK').toHaveLength(0);
      releases.forEach((listener) => expect(listener, 'RESOURCE_LEAK').toHaveBeenCalledTimes(1));
    }
  });
});

describe('Halley production nucleus', () => {
  it('uses an actual deterministic irregular elongated dark mesh within the accepted extent', () => {
    const { nucleus, flame, group } = buildNucleus();
    nucleus.geometry.computeBoundingBox();
    const extent = nucleus.geometry.boundingBox
      .getSize(new THREE.Vector3())
      .toArray()
      .sort((left, right) => right - left);
    expect(extent[0] / 2, 'NUCLEUS_OVERSIZED').toBeLessThanOrEqual(0.35);
    expect(extent[0] / extent[1], 'NUCLEUS_SPHERE').toBeGreaterThanOrEqual(1.75);
    expect(extent[0] / extent[2], 'NUCLEUS_SPHERE').toBeLessThanOrEqual(2.05);
    expect(extent[1] / 2).toBeCloseTo(0.35 / 1.9, 2);
    expect(nucleus.material.color.getHex(), 'NUCLEUS_NOT_DARK').toBeLessThan(0x707070);
    const array = nucleus.geometry.attributes.position.array;
    const radii = [];
    for (let offset = 0; offset < array.length; offset += 3) {
      radii.push(
        Math.hypot(
          array[offset] / 0.35,
          array[offset + 1] / (0.35 / 1.9),
          array[offset + 2] / (0.35 / 1.9),
        ),
      );
    }
    expect(Math.max(...radii) - Math.min(...radii), 'NUCLEUS_REGULAR').toBeGreaterThan(0.01);
    expect(buildNucleus().nucleus.geometry.attributes.position.array).toEqual(array);
    expect(flame.position.toArray()).toEqual([0, 0, 0]);
    expect(flame.scale.x).toBe(flame.scale.y);
    expect(group.scale.toArray()).toEqual([1, 1, 1]);
  });
});
