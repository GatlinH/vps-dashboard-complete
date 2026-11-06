import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { SolarSystem } from '../../src/components/SolarSystem.js';
import { RealTimeClock } from '../../src/components/solar/RealTimeClock.js';

const systems = [];

function buildSun(isMobile = false) {
  const gradient = { addColorStop: vi.fn() };
  const context = {
    createRadialGradient: vi.fn(() => gradient),
    fillRect: vi.fn(),
  };
  const canvas = { getContext: vi.fn(() => context) };
  vi.stubGlobal('document', {
    createElement: vi.fn(() => canvas),
  });
  const system = Object.assign(Object.create(SolarSystem.prototype), {
    scene: new THREE.Scene(),
    bodies: [],
    disposables: [],
    isMobile,
  });
  SolarSystem.prototype._buildSun.call(system);
  systems.push(system);
  return system;
}

function expectProductionDefaults(material) {
  expect(material.isShaderMaterial, 'SUN_PRODUCTION_SHADER_REQUIRED').toBe(true);
  expect(material.toneMapped).toBe(false);
  expect(material.uniforms.uGrade.value, 'SUN_GRADE_REQUIRED').toBe(1);
  expect(material.uniforms.uNoiseAmplitude.value, 'SUN_NOISE_AMPLITUDE_REQUIRED').toBe(0.24);
  expect(material.uniforms.uLimb.value, 'SUN_LIMB_REQUIRED').toBe(0.6);
  expect(material.uniforms.uSpotStrength.value, 'SUN_SPOT_STRENGTH_REQUIRED').toBe(0.55);
}

function expectCompactGlow(glow) {
  expect(glow.scale.x, 'SUN_GLOW_WIDTH_REQUIRED').toBe(9);
  expect(glow.scale.y).toBe(9);
  expect(glow.scale.z).toBe(1);
  expect(glow.material.opacity, 'SUN_GLOW_ALPHA_REQUIRED').toBe(0.18);
  expect(glow.material.blending).toBe(THREE.AdditiveBlending);
  expect(glow.material.transparent).toBe(true);
  expect(glow.material.depthTest).toBe(true);
  expect(glow.material.depthWrite).toBe(false);
}

function linearChannel(byte) {
  const channel = byte / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

afterEach(() => {
  systems.splice(0).forEach((system) => {
    system.disposables.forEach((resource) => resource.dispose());
  });
  vi.unstubAllGlobals();
});

describe('actual production Sun builder', () => {
  it('builds the adopted surface shader rather than the baseline flat material', () => {
    const { sun } = buildSun();
    expect(sun.material.isShaderMaterial, 'SUN_PRODUCTION_SHADER_REQUIRED').toBe(true);
    expect(sun.material.toneMapped).toBe(false);
    expect(sun.material.uniforms.uNoiseAmplitude.value).toBe(0.24);
    expect(sun.material.uniforms.uLimb.value).toBe(0.6);
    expect(sun.material.uniforms.uSpotStrength.value).toBe(0.55);
  });

  it('replaces the baseline oversized glow with intrinsic radius 4.5 support', () => {
    const { sun } = buildSun();
    const glow = sun.children.find((child) => child.isSprite);
    expect(glow.scale.x, 'SUN_GLOW_WIDTH_REQUIRED').toBe(9);
    expect(glow.scale.y).toBe(9);
    expect(glow.material.opacity).toBeLessThanOrEqual(0.18);
    expect(glow.material.depthWrite).toBe(false);
    expect(glow.material.depthTest).toBe(true);
  });

  it.each([
    { isMobile: false, widthSegments: 40, heightSegments: 28 },
    { isMobile: true, widthSegments: 20, heightSegments: 14 },
  ])(
    'preserves radius, topology and Sun identity for mobile=$isMobile',
    ({ isMobile, widthSegments, heightSegments }) => {
      const system = buildSun(isMobile);
      const { sun } = system;
      expect(sun.geometry).toBeInstanceOf(THREE.SphereGeometry);
      expect(sun.geometry.parameters).toMatchObject({ radius: 3.4, widthSegments, heightSegments });
      expect(sun.material).toBeInstanceOf(THREE.ShaderMaterial);
      expectProductionDefaults(sun.material);
      expect(sun.material.defines).toEqual(isMobile ? { SUN_MOBILE: 1 } : {});
      expect(sun.name).toBe('Sun');
      expect(sun.visible).toBe(true);
      expect(system.scene.children).toEqual([sun]);
      expect(system.scene.getObjectByName('Sun')).toBe(sun);
      expect(system.bodies).toEqual([
        {
          name: 'Sun',
          mesh: sun,
          angle: 0,
          speed: 0,
          orbit: 0,
          spin: (2 * Math.PI) / (25.4 * 86400),
          parent: null,
        },
      ]);
      expectCompactGlow(sun.children.find((child) => child.isSprite));
    },
  );

  it('registers a 25.4-day illustrative rotation at the 1x seconds rate without phase tuning', () => {
    const system = buildSun();
    const body = system.bodies[0];
    expect(body.spin).toBeCloseTo((2 * Math.PI) / (25.4 * 86400), 12);
    expect((2 * Math.PI) / body.spin / 86400).toBeCloseTo(25.4, 12);
    expect(body.spin * 86400).toBeCloseTo((2 * Math.PI) / 25.4, 12);
    expect(system.sun.rotation.y).toBe(0);
    system.realTimeClock = new RealTimeClock();
    system.sunLight = new THREE.PointLight();
    system._advanceBodies(86400);
    expect(system.timeSample.rate).toBe(1);
    expect(system.sun.rotation.y).toBeCloseTo((2 * Math.PI) / 25.4, 12);
  });

  it('links illustrative rotation to supported clock rates through the existing spin registry', () => {
    const system = buildSun();
    system.realTimeClock = new RealTimeClock();
    system.sunLight = new THREE.PointLight();
    const baseSpin = (2 * Math.PI) / (25.4 * 86400);
    for (const rate of [1, 86400, 1]) {
      system.realTimeClock.setRate(rate);
      const initialRotation = system.sun.rotation.y;
      system._advanceBodies(1);
      expect(system.timeSample.rate).toBe(rate);
      expect(system.bodies[0].spin).toBeCloseTo(baseSpin * rate, 12);
      expect(system.sun.rotation.y - initialRotation).toBeCloseTo(baseSpin * rate, 12);
    }
  });

  it.each([false, true])(
    'uses the installed THREE fragment camera interface on the production material for mobile=%s',
    (isMobile) => {
      const { sun } = buildSun(isMobile);
      const rendererSource = readFileSync(
        new URL('../../node_modules/three/src/renderers/webgl/WebGLProgram.js', import.meta.url),
        'utf8',
      );
      const fragmentPrefix = [
        ...rendererSource.matchAll(
          /prefixFragment\s*=\s*\[([\s\S]*?)\]\.filter\(\s*filterEmptyLine\s*\)\.join\(\s*'\\n'\s*\);/g,
        ),
      ]
        .map((match) => match[1])
        .find((prefix) => prefix.includes('uniform bool isOrthographic;'));
      expect(fragmentPrefix, 'THREE_STANDARD_FRAGMENT_INTERFACE_REQUIRED').toBeDefined();
      expect(fragmentPrefix).not.toContain('uniform mat4 projectionMatrix;');
      expect(sun.material.fragmentShader).toMatch(
        /vec3 viewDirection = isOrthographic\s*\? vec3\(0\.0, 0\.0, 1\.0\) : normalize\(-vViewPosition\);/,
      );
      expect(sun.material.fragmentShader).not.toMatch(/\bprojectionMatrix\b/);
      expect(sun.material.vertexShader).toContain('vViewPosition = viewPosition.xyz;');
      expect(sun.material.vertexShader).toContain('vViewNormal = normalMatrix * normal;');
      expect(sun.material.vertexShader).toContain('gl_Position = projectionMatrix * viewPosition;');
    },
  );

  it.each([false, true])(
    'carries the full noise MIT notice inside the delivered production fragment string for mobile=%s',
    (isMobile) => {
      const { sun } = buildSun(isMobile);
      expect(sun.material.fragmentShader).toContain(`/* @license
Copyright (C) 2011 by Ashima Arts (Simplex noise)
Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/`);
    },
  );

  it('supplies the fixed sRGB-derived colors as independent linear uniforms', () => {
    const desktop = buildSun();
    const mobile = buildSun(true);
    const uniforms = desktop.sun.material.uniforms;
    for (const [name, bytes] of [
      ['uCoreColor', [255, 228, 154]],
      ['uEdgeColor', [255, 122, 24]],
    ]) {
      const color = uniforms[name].value;
      expect(color).toBeInstanceOf(THREE.Color);
      expect(color.r).toBeCloseTo(linearChannel(bytes[0]), 6);
      expect(color.g).toBeCloseTo(linearChannel(bytes[1]), 6);
      expect(color.b).toBeCloseTo(linearChannel(bytes[2]), 6);
      expect(color).not.toBe(mobile.sun.material.uniforms[name].value);
    }
    uniforms.uCoreColor.value.setRGB(0, 0, 0);
    uniforms.uNoiseAmplitude.value = 0;
    expect(mobile.sun.material.uniforms.uCoreColor.value.r).toBe(1);
    expect(mobile.sun.material.uniforms.uNoiseAmplitude.value).toBe(0.24);
  });

  it.each([false, true])(
    'keeps linear-white probe controls on the same production material for mobile=%s',
    (isMobile) => {
      const { sun } = buildSun(isMobile);
      const material = sun.material;
      const geometry = sun.geometry;
      const uniforms = material.uniforms;
      const version = material.version;
      const vertexShader = material.vertexShader;
      const fragmentShader = material.fragmentShader;
      const initialValues = Object.fromEntries(
        Object.entries(uniforms).map(([name, uniform]) => [name, uniform.value]),
      );

      uniforms.uGrade.value = 0;
      uniforms.uNoiseAmplitude.value = 0;
      uniforms.uSpotStrength.value = 0;

      expect(sun.material).toBe(material);
      expect(sun.geometry).toBe(geometry);
      expect(material.uniforms).toBe(uniforms);
      expect(material.version).toBe(version);
      expect(material.vertexShader).toBe(vertexShader);
      expect(material.fragmentShader).toBe(fragmentShader);
      expect(material.toneMapped).toBe(false);
      expect(uniforms.uLimb.value).toBe(0.6);
      const changed = Object.keys(uniforms).filter(
        (name) => uniforms[name].value !== initialValues[name],
      );
      expect(changed).toEqual(['uGrade', 'uNoiseAmplitude', 'uSpotStrength']);
      expect(fragmentShader).toContain('mix(vec3(1.0),');
      expect(fragmentShader).toContain('vec3 surfaceColor = 0.8 * baseColor;');
      expect(fragmentShader).toContain('surfaceColor *= 1.0 - uLimb + uLimb * mu;');

      for (const [name, value] of Object.entries(initialValues)) uniforms[name].value = value;
      expectProductionDefaults(material);
    },
  );

  it('retains textureless object-space octaves, exactly two fixed caps and final output encoding', () => {
    const desktop = buildSun();
    const mobile = buildSun(true);
    const material = desktop.sun.material;
    const source = material.fragmentShader;
    expect(mobile.sun.material.vertexShader).toBe(material.vertexShader);
    expect(mobile.sun.material.fragmentShader).toBe(source);
    expect(material.vertexShader).toContain('vLocalPosition = position;');
    expect(source).toContain('vec3 surfacePoint = normalize(vLocalPosition);');
    expect(source).toContain('clamp(snoise(22.0 * surfacePoint), -1.0, 1.0)');
    expect(source).toContain('clamp(snoise(44.0 * surfacePoint), -1.0, 1.0)');
    expect(source).toMatch(/#ifdef SUN_MOBILE\s+float octaveNoise = firstOctave;/);
    expect(source).toContain('(2.0 * firstOctave + secondOctave) / 3.0');
    expect(source).toContain('clamp(2.0 * octaveNoise, -1.0, 1.0)');
    expect(source).toContain('return 105.0 * dot(');
    expect(source).toContain('((value * 34.0) + 10.0) * value');
    expect(source).toContain('smoothstep(cos(0.055), cos(0.025), dot(surfacePoint, center))');
    expect(source).toContain('if (abs(surfacePoint.y) > sin(radians(35.0))) return 0.0;');
    const capCoordinates = [
      ...source.matchAll(
        /spotCap\(surfacePoint,\s*radians\((-?\d+\.\d+)\),\s*radians\((-?\d+\.\d+)\)\)/g,
      ),
    ].map((match) => [Number(match[1]), Number(match[2])]);
    expect(capCoordinates).toEqual([
      [15, 60],
      [-15, -60],
    ]);
    expect(source.match(/\bspotCap\(surfacePoint,/g)).toHaveLength(2);
    expect(source).toContain('return clamp(max(northEast, southWest), 0.0, 1.0);');
    expect(source).toContain('smoothstep(0.0, 0.8, mu)');
    expect(source).toContain('vec3 viewDirection = isOrthographic');
    expect(source).toContain('normalize(-vViewPosition)');
    const stages = [
      'vec3 surfaceColor = 0.8 * baseColor;',
      'surfaceColor *= 1.0 + uNoiseAmplitude * noiseValue;',
      'surfaceColor *= 1.0 - uSpotStrength * spotMask(surfacePoint);',
      'surfaceColor *= 1.0 - uLimb + uLimb * mu;',
      'gl_FragColor = vec4(surfaceColor, 1.0);',
      '#include <colorspace_fragment>',
    ].map((stage) => source.indexOf(stage));
    expect(stages.every((position) => position >= 0)).toBe(true);
    expect(stages).toEqual([...stages].sort((first, second) => first - second));
    expect(`${material.vertexShader}\n${source}`).not.toMatch(
      /\b(?:uv|uTime|sampler2D|sampler3D|texture2D|texture3D)\b/,
    );
  });

  it('constructs radial alpha with normalized outer support and compact additive state', () => {
    const { sun } = buildSun();
    const glow = sun.children.find((child) => child.isSprite);
    expectCompactGlow(glow);
    expect(glow.material.map).toBeInstanceOf(THREE.CanvasTexture);
    const canvas = glow.material.map.image;
    expect(canvas.width).toBe(64);
    expect(canvas.height).toBe(64);
    expect(canvas.getContext).toHaveBeenCalledWith('2d');
    const context = canvas.getContext.mock.results[0].value;
    expect(context.createRadialGradient).toHaveBeenCalledExactlyOnceWith(32, 32, 0, 32, 32, 32);
    const gradient = context.createRadialGradient.mock.results[0].value;
    expect(gradient.addColorStop.mock.calls).toEqual([
      [0, 'rgba(255,255,220,1)'],
      [1, 'rgba(255,150,20,0)'],
    ]);
    expect(context.fillStyle).toBe(gradient);
    expect(context.fillRect).toHaveBeenCalledExactlyOnceWith(0, 0, 64, 64);
    expect(glow.scale.x / 2).toBe(4.5);
    expect(glow.scale.x / (2 * sun.geometry.parameters.radius)).toBeCloseTo(1.3235294118, 9);
  });

  it.each([false, true])(
    'tracks all four real GPU resources for disposal for mobile=%s',
    (isMobile) => {
      const system = buildSun(isMobile);
      const { sun } = system;
      const glow = sun.children.find((child) => child.isSprite);
      const resources = [sun.geometry, sun.material, glow.material.map, glow.material];
      expect(system.disposables).toEqual(resources);
      expect(new Set(system.disposables).size).toBe(4);
      const listeners = resources.map((resource) => {
        const listener = vi.fn();
        resource.addEventListener('dispose', listener);
        return listener;
      });
      system.disposables.splice(0).forEach((resource) => resource.dispose());
      listeners.forEach((listener) => expect(listener).toHaveBeenCalledTimes(1));
    },
  );

  it('rejects a real baseline flat-material replacement', () => {
    const system = buildSun();
    const flatMaterial = new THREE.MeshBasicMaterial({ color: 0xffcf40 });
    system._track(flatMaterial);
    system.sun.material = flatMaterial;
    expect(() => expectProductionDefaults(system.sun.material)).toThrow(
      'SUN_PRODUCTION_SHADER_REQUIRED',
    );
  });

  it.each([
    ['uGrade', 'SUN_GRADE_REQUIRED'],
    ['uNoiseAmplitude', 'SUN_NOISE_AMPLITUDE_REQUIRED'],
    ['uLimb', 'SUN_LIMB_REQUIRED'],
    ['uSpotStrength', 'SUN_SPOT_STRENGTH_REQUIRED'],
  ])('does not mistake the intentional %s-off probe for production defaults', (name, failure) => {
    const { sun } = buildSun();
    sun.material.uniforms[name].value = 0;
    expect(() => expectProductionDefaults(sun.material)).toThrow(failure);
  });

  it('rejects the real oversized glow negative without changing the Sun sphere', () => {
    const { sun } = buildSun();
    const glow = sun.children.find((child) => child.isSprite);
    glow.scale.set(28, 28, 1);
    expect(() => expectCompactGlow(glow)).toThrow('SUN_GLOW_WIDTH_REQUIRED');
    expect(sun.geometry.parameters.radius).toBe(3.4);
  });

  it('rejects a real glow opacity above the adopted peak cap', () => {
    const { sun } = buildSun();
    const glow = sun.children.find((child) => child.isSprite);
    glow.material.opacity = 0.9;
    expect(() => expectCompactGlow(glow)).toThrow('SUN_GLOW_ALPHA_REQUIRED');
  });
});
