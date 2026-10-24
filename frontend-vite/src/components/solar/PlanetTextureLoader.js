import * as THREE from 'three';

// Loader-side helpers for the versioned CC-BY planetary texture package.
// The runtime (SolarSystem._loadPlanetaryTextures) owns the hot-swap itself;
// everything that can be decided without a live scene lives here so it can be
// exercised without a DOM or a WebGL context.

export const TEXTURE_PACKAGE_BASE = '/assets/solar/textures-v1/';
export const TEXTURE_MANIFEST_URL = `${TEXTURE_PACKAGE_BASE}manifest.json`;

// Manifest declares "srgb" for albedo maps and "linear" for data maps
// (cloud alpha, ring transmittance). Anything non-srgb must stay unconverted.
export function threeColorSpace(colorSpace) {
  return colorSpace === 'srgb' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
}

// Picks the tier entry (desktop 2K / mobile 1K) and resolves its public URL.
// Falls back to the desktop tier when a tier is missing so a partially
// published manifest still yields a usable texture instead of nothing.
export function resolveTierAsset(meta, tier) {
  const asset = meta?.tiers?.[tier] || meta?.tiers?.desktop;
  if (!asset || typeof asset.file !== 'string' || !asset.file) return null;
  return {
    url: `${TEXTURE_PACKAGE_BASE}${asset.file}`,
    file: asset.file,
    colorSpace: meta.color_space === 'srgb' ? 'srgb' : 'linear'
  };
}

// Throws on transport errors, non-2xx responses and structurally unusable
// payloads; the caller turns any throw into "keep the procedural textures".
export async function fetchTextureManifest(url = TEXTURE_MANIFEST_URL, fetchImpl) {
  const request = typeof fetchImpl === 'function' ? fetchImpl : (target) => globalThis.fetch(target);
  const response = await request(url);
  if (!response || response.ok !== true) {
    throw new Error(`manifest request failed (HTTP ${response?.status ?? 'unknown'})`);
  }
  const manifest = await response.json();
  if (!manifest || typeof manifest.textures !== 'object' || manifest.textures === null) {
    throw new Error('manifest has no textures map');
  }
  return manifest;
}

// RingGeometry ships planar cartesian UVs, which stretch a radial ring strip
// into straight bands. Remap u to the normalised radius and sample the strip's
// centre row so the 1D radial profile unwraps into true concentric rings.
export function remapRingToPolarUv(geometry, innerRadius, outerRadius) {
  const position = geometry?.attributes?.position;
  const uv = geometry?.attributes?.uv;
  const span = outerRadius - innerRadius;
  if (!position || !uv || !(span > 0)) return geometry;
  for (let i = 0; i < position.count; i += 1) {
    const radius = Math.hypot(position.getX(i), position.getY(i));
    uv.setXY(i, (radius - innerRadius) / span, 0.5);
  }
  uv.needsUpdate = true;
  return geometry;
}
