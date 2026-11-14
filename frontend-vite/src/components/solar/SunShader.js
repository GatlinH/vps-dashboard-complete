import * as THREE from 'three';

const noiseLicense = `/* @license
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
*/`;

const vertexShader = `
varying vec3 vLocalPosition;
varying vec3 vViewPosition;
varying vec3 vViewNormal;

void main() {
  vLocalPosition = position;
  vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
  vViewPosition = viewPosition.xyz;
  vViewNormal = normalMatrix * normal;
  gl_Position = projectionMatrix * viewPosition;
}
`;

const fragmentShader = `
${noiseLicense}
uniform vec3 uCoreColor;
uniform vec3 uEdgeColor;
uniform float uGrade;
uniform float uNoiseAmplitude;
uniform float uLimb;
uniform float uSpotStrength;
varying vec3 vLocalPosition;
varying vec3 vViewPosition;
varying vec3 vViewNormal;

vec3 mod289(vec3 value) {
  return value - floor(value * (1.0 / 289.0)) * 289.0;
}

vec4 mod289(vec4 value) {
  return value - floor(value * (1.0 / 289.0)) * 289.0;
}

vec4 permute(vec4 value) {
  return mod289(((value * 34.0) + 10.0) * value);
}

vec4 taylorInvSqrt(vec4 value) {
  return 1.79284291400159 - 0.85373472095314 * value;
}

float snoise(vec3 value) {
  const vec2 skew = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 offsets = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 lattice = floor(value + dot(value, skew.yyy));
  vec3 corner0 = value - lattice + dot(lattice, skew.xxx);
  vec3 ordering = step(corner0.yzx, corner0.xyz);
  vec3 inverseOrdering = 1.0 - ordering;
  vec3 index1 = min(ordering.xyz, inverseOrdering.zxy);
  vec3 index2 = max(ordering.xyz, inverseOrdering.zxy);
  vec3 corner1 = corner0 - index1 + skew.xxx;
  vec3 corner2 = corner0 - index2 + skew.yyy;
  vec3 corner3 = corner0 - offsets.yyy;
  lattice = mod289(lattice);
  vec4 permutation = permute(permute(permute(
    lattice.z + vec4(0.0, index1.z, index2.z, 1.0))
    + lattice.y + vec4(0.0, index1.y, index2.y, 1.0))
    + lattice.x + vec4(0.0, index1.x, index2.x, 1.0));
  float seventh = 0.142857142857;
  vec3 gradientScale = seventh * offsets.wyz - offsets.xzx;
  vec4 gradientIndex = permutation - 49.0 * floor(
    permutation * gradientScale.z * gradientScale.z);
  vec4 gridX = floor(gradientIndex * gradientScale.z);
  vec4 gridY = floor(gradientIndex - 7.0 * gridX);
  vec4 gradientX = gridX * gradientScale.x + gradientScale.yyyy;
  vec4 gradientY = gridY * gradientScale.x + gradientScale.yyyy;
  vec4 gradientHeight = 1.0 - abs(gradientX) - abs(gradientY);
  vec4 basis0 = vec4(gradientX.xy, gradientY.xy);
  vec4 basis1 = vec4(gradientX.zw, gradientY.zw);
  vec4 signs0 = floor(basis0) * 2.0 + 1.0;
  vec4 signs1 = floor(basis1) * 2.0 + 1.0;
  vec4 heightSigns = -step(gradientHeight, vec4(0.0));
  vec4 octahedron0 = basis0.xzyw + signs0.xzyw * heightSigns.xxyy;
  vec4 octahedron1 = basis1.xzyw + signs1.xzyw * heightSigns.zzww;
  vec3 gradient0 = vec3(octahedron0.xy, gradientHeight.x);
  vec3 gradient1 = vec3(octahedron0.zw, gradientHeight.y);
  vec3 gradient2 = vec3(octahedron1.xy, gradientHeight.z);
  vec3 gradient3 = vec3(octahedron1.zw, gradientHeight.w);
  vec4 normalization = taylorInvSqrt(vec4(
    dot(gradient0, gradient0), dot(gradient1, gradient1),
    dot(gradient2, gradient2), dot(gradient3, gradient3)));
  gradient0 *= normalization.x;
  gradient1 *= normalization.y;
  gradient2 *= normalization.z;
  gradient3 *= normalization.w;
  vec4 attenuation = max(0.5 - vec4(
    dot(corner0, corner0), dot(corner1, corner1),
    dot(corner2, corner2), dot(corner3, corner3)), 0.0);
  attenuation *= attenuation;
  return 105.0 * dot(attenuation * attenuation, vec4(
    dot(gradient0, corner0), dot(gradient1, corner1),
    dot(gradient2, corner2), dot(gradient3, corner3)));
}

float spotCap(vec3 surfacePoint, float latitude, float longitude) {
  vec3 center = vec3(
    cos(latitude) * cos(longitude), sin(latitude),
    cos(latitude) * sin(longitude));
  return smoothstep(cos(0.055), cos(0.025), dot(surfacePoint, center));
}

float spotMask(vec3 surfacePoint) {
  if (abs(surfacePoint.y) > sin(radians(35.0))) return 0.0;
  float northEast = spotCap(surfacePoint, radians(15.0), radians(60.0));
  float southWest = spotCap(surfacePoint, radians(-15.0), radians(-60.0));
  return clamp(max(northEast, southWest), 0.0, 1.0);
}

void main() {
  vec3 surfacePoint = normalize(vLocalPosition);
  vec3 viewDirection = isOrthographic
    ? vec3(0.0, 0.0, 1.0) : normalize(-vViewPosition);
  float mu = clamp(dot(normalize(vViewNormal), viewDirection), 0.0, 1.0);
  vec3 baseColor = mix(vec3(1.0),
    mix(uEdgeColor, uCoreColor, smoothstep(0.0, 0.8, mu)), uGrade);
  float firstOctave = clamp(snoise(22.0 * surfacePoint), -1.0, 1.0);
#ifdef SUN_MOBILE
  float octaveNoise = firstOctave;
#else
  float secondOctave = clamp(snoise(44.0 * surfacePoint), -1.0, 1.0);
  float octaveNoise = (2.0 * firstOctave + secondOctave) / 3.0;
#endif
  float noiseValue = clamp(2.0 * octaveNoise, -1.0, 1.0);
  vec3 surfaceColor = 0.8 * baseColor;
  surfaceColor *= 1.0 + uNoiseAmplitude * noiseValue;
  surfaceColor *= 1.0 - uSpotStrength * spotMask(surfacePoint);
  surfaceColor *= 1.0 - uLimb + uLimb * mu;
  gl_FragColor = vec4(surfaceColor, 1.0);
  #include <colorspace_fragment>
}
`;

export function createSunMaterial(isMobile = false) {
  return new THREE.ShaderMaterial({
    name: 'SunIllustrativeSurface',
    defines: isMobile ? { SUN_MOBILE: 1 } : {},
    uniforms: {
      uCoreColor: { value: new THREE.Color(0xffe49a) },
      uEdgeColor: { value: new THREE.Color(0xff7a18) },
      uGrade: { value: 1 },
      uNoiseAmplitude: { value: 0.24 },
      uLimb: { value: 0.6 },
      uSpotStrength: { value: 0.55 },
    },
    vertexShader,
    fragmentShader,
    toneMapped: false,
  });
}
