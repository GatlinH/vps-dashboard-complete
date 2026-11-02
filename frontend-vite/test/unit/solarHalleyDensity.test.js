import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { DustTailRenderer } from '../../src/components/solar/DustTailRenderer.js';
import { physicalToDisplay } from '../../src/components/solar/CoordinateMapper.js';

const owned = [];
const tolerance = 0.55 * 2 ** -23;

function fixture(screenOffsets, { depth = 100, dpr = 1, height = 1000, pointSize = 1.8 } = {}) {
  const tail = new DustTailRenderer({ scene: new THREE.Scene(), physicalToDisplay });
  owned.push(tail);
  const physical = new Float32Array(5 * 201 * 3);
  const physicalBytes = new Uint8Array(physical.buffer).slice();
  tail.update(physical, 201);
  expect(new Uint8Array(physical.buffer), 'PHYSICAL_MUTATED').toEqual(physicalBytes);
  const attribute = tail.geometry.attributes.position;
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 0, depth);
  camera.lookAt(0, 0, 0);
  const worldPerPixel = (2 * depth * Math.tan(Math.PI / 6)) / height;
  screenOffsets.forEach(([horizontal, vertical, z = 0], index) =>
    attribute.setXYZ(index, horizontal * worldPerPixel, vertical * worldPerPixel, z),
  );
  tail.visibleCount = screenOffsets.length;
  tail.geometry.setDrawRange(0, screenOffsets.length);
  tail.material.size = pointSize;
  const renderer = {
    getDrawingBufferSize: (target) => target.set(height, height),
    getPixelRatio: () => dpr,
    getContext: () => ({
      ALIASED_POINT_SIZE_RANGE: 0x846d,
      getParameter: () => new Float32Array([1, 64]),
    }),
  };
  return { tail, camera, renderer, physical };
}

function prepare({ tail, camera, renderer, physical }) {
  const physicalBytes = new Uint8Array(physical.buffer).slice();
  const attribute = tail.geometry.attributes.position;
  const original = new Uint8Array(attribute.array.buffer).slice();
  const version = attribute.version;
  if (tail.prepareFrame) tail.prepareFrame(camera, renderer);
  expect(new Uint8Array(attribute.array.buffer), 'POSITION_MUTATED').toEqual(original);
  expect(attribute.version, 'POSITION_MUTATED').toBe(version);
  expect(new Uint8Array(physical.buffer), 'PHYSICAL_MUTATED').toEqual(physicalBytes);
}

function effectiveAlphas(tail) {
  const color = tail.geometry.attributes.color;
  return Array.from(
    { length: tail.visibleCount },
    (_, index) =>
      tail.material.opacity *
      (tail.material.vertexColors && color?.itemSize === 4 ? color.getW(index) : 1),
  );
}

function assertBound(alphas) {
  if (alphas.reduce((sum, alpha) => sum + alpha, 0) > 0.55 + tolerance)
    throw new Error('DENSE_UNBOUNDED');
}

function assertSparse(alphas) {
  if (alphas.some((alpha) => alpha !== 0.55)) throw new Error('SPARSE_ATTENUATED');
}

afterEach(() => owned.splice(0).forEach((tail) => tail.dispose()));

describe('Halley actual renderer screen density', () => {
  it('aggregates 804 coincident source vertices into an RGBA8-visible representative', () => {
    const value = fixture(Array.from({ length: 804 }, () => [0, 0]));
    const diagnostics = value.tail.getDiagnostics();
    const positions = value.tail.geometry.attributes.position.array;
    const colors = value.tail.geometry.attributes.color.array;
    prepare(value);
    const alphas = effectiveAlphas(value.tail);
    assertBound(alphas);
    expect(
      alphas.reduce((sum, alpha) => sum + Math.round(alpha * 255), 0),
      'LAYER_SIGNAL_MISSING',
    ).toBeGreaterThan(0);
    expect(
      alphas.filter((alpha) => alpha > 0),
      'DISPLAY_GROUP_MISSING',
    ).toEqual([0.55]);
    expect(value.tail.getDiagnostics()).toEqual(diagnostics);
    expect(value.tail.geometry.attributes.position.array).toBe(positions);
    expect(value.tail.geometry.attributes.color.array).toBe(colors);
    const scratch = [
      value.tail.screenX,
      value.tail.screenY,
      value.tail.binCounts,
      value.tail.microCounts,
      value.tail.microKeysX,
      value.tail.microKeysY,
      value.tail.microRepresentatives,
    ];
    const colorVersion = value.tail.geometry.attributes.color.version;
    prepare(value);
    expect(value.tail.geometry.attributes.color.version).toBeGreaterThan(colorVersion);
    expect(effectiveAlphas(value.tail)).toEqual(alphas);
    [
      value.tail.screenX,
      value.tail.screenY,
      value.tail.binCounts,
      value.tail.microCounts,
      value.tail.microKeysX,
      value.tail.microKeysY,
      value.tail.microRepresentatives,
    ].forEach((array, index) => expect(array).toBe(scratch[index]));
  });

  it('keeps 803 plus one microboundary groups bounded without a per-representative alpha floor', () => {
    const value = fixture([...Array.from({ length: 803 }, () => [0.24, 0]), [0.26, 0]]);
    prepare(value);
    const alphas = effectiveAlphas(value.tail);
    const representatives = alphas.filter((alpha) => alpha > 0);
    assertBound(alphas);
    expect(representatives, 'DISPLAY_GROUP_MISSING').toHaveLength(2);
    expect(representatives[0]).toBeCloseTo((0.55 * 803) / 804, 7);
    expect(representatives[1]).toBeCloseTo(0.55 / 804, 9);
    expect(representatives[1]).toBeLessThan(1 / 255);
    expect(
      representatives.reduce((sum, alpha) => sum + Math.round(alpha * 255), 0),
      'LAYER_SIGNAL_MISSING',
    ).toBeGreaterThan(0);
  });

  it('conserves equal dense microgroups without double normalization', () => {
    const value = fixture([
      ...Array.from({ length: 402 }, () => [0.24, 0]),
      ...Array.from({ length: 402 }, () => [0.26, 0]),
    ]);
    prepare(value);
    const alphas = effectiveAlphas(value.tail);
    assertBound(alphas);
    expect(
      alphas.filter((alpha) => alpha > 0),
      'DISPLAY_GROUP_MISSING',
    ).toEqual([0.275, 0.275]);
  });

  it('allows five isolated groups to exceed a whole-screen cap while preserving sparse opacity', () => {
    const value = fixture([
      [-400, 0],
      [-200, 0],
      [0, 0],
      [200, 0],
      [400, 0],
    ]);
    prepare(value);
    const alphas = effectiveAlphas(value.tail);
    assertSparse(alphas);
    expect(alphas.reduce((sum, alpha) => sum + alpha, 0)).toBeCloseTo(2.75, 12);
  });

  it('counts group members across footprint bins and internal microcell offsets', () => {
    for (const pointSize of [0.001, 1.8, 6]) {
      const offsets = [
        ...Array.from({ length: 301 }, () => [4.01, 0.01]),
        ...Array.from({ length: 200 }, () => [4.24, 0.24]),
        ...Array.from({ length: 303 }, () => [3.99, -0.01]),
      ];
      const value = fixture(offsets, { pointSize });
      prepare(value);
      const alphas = effectiveAlphas(value.tail);
      assertBound(alphas);
      expect(
        alphas.filter((alpha) => alpha > 0),
        'DISPLAY_GROUP_MISSING',
      ).toHaveLength(2);
      expect(
        alphas.filter((alpha) => alpha > 0).reduce((sum, alpha) => sum + alpha, 0),
      ).toBeCloseTo(0.55, 7);
    }
  });

  it('bounds all 804 coincident particles, including distant array indices', () => {
    const value = fixture(Array.from({ length: 804 }, () => [0, 0]));
    prepare(value);
    const alphas = effectiveAlphas(value.tail);
    assertBound(alphas);
    expect(
      alphas.some((alpha) => alpha > 0),
      'LAYER_SIGNAL_MISSING',
    ).toBe(true);
    expect(value.tail.geometry.attributes.color.itemSize).toBe(4);
    expect(value.tail.material.vertexColors).toBe(true);
    value.tail.material.vertexColors = false;
    expect(() => assertBound(effectiveAlphas(value.tail))).toThrow('DENSE_UNBOUNDED');
  });

  it('preserves isolated and separated base opacity, rejecting a global divisor', () => {
    for (const offsets of [
      [[0, 0]],
      [
        [-250, 0],
        [0, 0],
        [250, 0],
      ],
    ]) {
      const value = fixture(offsets);
      prepare(value);
      assertSparse(effectiveAlphas(value.tail));
    }
    const value = fixture([[0, 0]]);
    prepare(value);
    value.tail.geometry.attributes.color.setW(0, 1 / 804);
    expect(() => assertSparse(effectiveAlphas(value.tail))).toThrow('SPARSE_ATTENUATED');
  });

  it('conservatively bounds subpixel, cross-bin and rounded minimum-size overlap', () => {
    for (const pointSize of [1.8, 0.001]) {
      const boundaryOffset = pointSize === 1.8 ? 4 : 1;
      const value = fixture(
        [
          [boundaryOffset - 0.24, boundaryOffset - 0.24],
          [boundaryOffset + 0.24, boundaryOffset - 0.24],
          [boundaryOffset - 0.24, boundaryOffset + 0.24],
          [boundaryOffset + 0.24, boundaryOffset + 0.24],
        ],
        { pointSize, dpr: 3 },
      );
      prepare(value);
      assertBound(effectiveAlphas(value.tail));
      expect(new Set(value.tail.binX.subarray(0, 4)).size).toBe(2);
      expect(new Set(value.tail.binY.subarray(0, 4)).size).toBe(2);
    }
  });

  it('projects the current camera and drawing buffer rather than stale world distances', () => {
    const value = fixture(
      [
        [0, 0],
        [60, 0],
      ],
      { height: 1000 },
    );
    prepare(value);
    assertSparse(effectiveAlphas(value.tail));
    value.camera.position.z = 500;
    value.camera.updateProjectionMatrix();
    value.renderer.getDrawingBufferSize = (target) => target.set(100, 100);
    prepare(value);
    assertBound(effectiveAlphas(value.tail));
  });

  it('uses current world transforms, depth-valid particles, and active draw range only', () => {
    const value = fixture([
      [0, 0],
      [0, 0, 101],
      [0, 0, -1001],
      [0, 0, Number.NaN],
    ]);
    prepare(value);
    expect(effectiveAlphas(value.tail)).toEqual([0.55, 0, 0, 0]);
    value.tail.points.position.z = -100;
    value.tail.geometry.setDrawRange(0, 2);
    prepare(value);
    assertBound(effectiveAlphas(value.tail).slice(0, 2));
  });

  it('increments the real color BufferAttribute version and reuses buffers between frames', () => {
    const value = fixture([[0, 0]]);
    prepare(value);
    const color = value.tail.geometry.attributes.color;
    expect(color, 'DENSE_UNBOUNDED').toBeDefined();
    const array = color.array;
    const previousVersion = color.version;
    prepare(value);
    expect(color.array).toBe(array);
    expect(color.version, 'COLOR_NOT_UPLOADED').toBeGreaterThan(previousVersion);
    value.tail.clear();
    prepare(value);
    expect(value.tail.geometry.drawRange.count).toBe(0);
  });
});
