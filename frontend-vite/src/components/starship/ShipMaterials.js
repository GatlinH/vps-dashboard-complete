import * as THREE from 'three';
import { isNavigationLightMaterial } from './NavLights.js';
import { isShipLabelMaterial } from './ShipLabel.js';

export const shipMaterialMethods = {
async _rehydrateGltfTextures(gltf) {
  const parser = gltf?.parser;
  const json = parser?.json;
  if (!parser || !json?.images?.length || !json?.materials?.length) {
    return { attempted: 0, attached: 0, reason: 'no-parser-json' };
  }

  const textureCache = new Map();
  const loadTextureByIndex = async (textureIndex, colorSpace) => {
    if (textureIndex == null || textureIndex < 0) return null;
    const cacheKey = `${textureIndex}:${colorSpace || 'default'}`;
    if (textureCache.has(cacheKey)) return textureCache.get(cacheKey);

    const texDef = json.textures?.[textureIndex];
    if (!texDef) return null;
    const sourceIndex = texDef.source;
    const imageDef = json.images?.[sourceIndex];
    if (!imageDef || imageDef.bufferView == null) return null;

    const bufferView = await parser.getDependency('bufferView', imageDef.bufferView);
    // Offline GLB already contrast-boosted; avoid double-processing that can posterize.
    let imageBitmap;
    try {
      const blob = new Blob([bufferView], { type: imageDef.mimeType || 'image/png' });
      imageBitmap = await createImageBitmap(blob);
    } catch (err) {
      console.warn('[StarshipShowcase] createImageBitmap failed', textureIndex, err);
      return null;
    }

    const texture = new THREE.Texture(imageBitmap);
    texture.flipY = false;
    texture.needsUpdate = true;
    texture.colorSpace = colorSpace || THREE.NoColorSpace;
    texture.anisotropy = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
    texture.userData = {
      rehydrated: true,
      contrastBoosted: colorSpace === THREE.SRGBColorSpace,
      textureIndex,
      sourceIndex,
      mimeType: imageDef.mimeType || 'image/png',
    };

    // Apply sampler wrap/filter when present.
    const sampler = json.samplers?.[texDef.sampler ?? 0] || {};
    if (sampler.wrapS != null) texture.wrapS = sampler.wrapS;
    if (sampler.wrapT != null) texture.wrapT = sampler.wrapT;
    if (sampler.magFilter != null) texture.magFilter = sampler.magFilter;
    if (sampler.minFilter != null) texture.minFilter = sampler.minFilter;

    textureCache.set(cacheKey, texture);
    return texture;
  };

  let attempted = 0;
  let attached = 0;
  const materialTextures = [];

  for (let i = 0; i < json.materials.length; i += 1) {
    const matDef = json.materials[i];
    const pbr = matDef.pbrMetallicRoughness || {};
    const slots = [];
    if (pbr.baseColorTexture?.index != null) {
      slots.push({ slot: 'map', index: pbr.baseColorTexture.index, colorSpace: THREE.SRGBColorSpace });
    }
    if (pbr.metallicRoughnessTexture?.index != null) {
      slots.push({ slot: 'metalnessMap', index: pbr.metallicRoughnessTexture.index, colorSpace: THREE.NoColorSpace });
      slots.push({ slot: 'roughnessMap', index: pbr.metallicRoughnessTexture.index, colorSpace: THREE.NoColorSpace });
    }
    if (matDef.normalTexture?.index != null) {
      slots.push({ slot: 'normalMap', index: matDef.normalTexture.index, colorSpace: THREE.NoColorSpace });
    }
    if (matDef.emissiveTexture?.index != null) {
      slots.push({ slot: 'emissiveMap', index: matDef.emissiveTexture.index, colorSpace: THREE.SRGBColorSpace });
    }
    if (matDef.occlusionTexture?.index != null) {
      slots.push({ slot: 'aoMap', index: matDef.occlusionTexture.index, colorSpace: THREE.NoColorSpace });
    }
    if (!slots.length) continue;

    const loaded = {};
    for (const s of slots) {
      attempted += 1;
      // metalness/roughness share one texture object; load once
      if (loaded[s.slot]) continue;
      // eslint-disable-next-line no-await-in-loop
      const tex = await loadTextureByIndex(s.index, s.colorSpace);
      if (tex) {
        loaded[s.slot] = tex;
        attached += 1;
      }
    }
    if (Object.keys(loaded).length) {
      materialTextures.push({ materialIndex: i, name: matDef.name || `mat_${i}`, maps: loaded });
    }
  }

  // Assign onto live scene materials by material index when available, else by name.
  this.ship?.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    mats.forEach((mat) => {
      // Prefer exact gltf material index if three stored it.
      const idx = mat.userData?.gltfExtensions ? null : (mat.userData?.materialIndex ?? null);
      let entry = null;
      if (idx != null) entry = materialTextures.find((m) => m.materialIndex === idx);
      if (!entry && mat.name) entry = materialTextures.find((m) => m.name === mat.name);
      if (!entry) return;
      Object.entries(entry.maps).forEach(([slot, tex]) => {
        if (!mat[slot]) {
          mat[slot] = tex;
          // roughness/metalness often share the same texture instance
          if (slot === 'metalnessMap' && !mat.roughnessMap) mat.roughnessMap = tex;
          if (slot === 'roughnessMap' && !mat.metalnessMap) mat.metalnessMap = tex;
        }
      });
      mat.needsUpdate = true;
    });
  });

  // Second pass: match by material definition order if names collided.
  // Collect unique materials currently used and map by name only (already done).

  return {
    attempted,
    attached,
    materialsWithMaps: materialTextures.length,
    textureObjects: textureCache.size,
  };
}
};

export function applyShipMaterials(showcase) {
  const host = showcase;
  // Preserve original maps. Only clone+boost a few named emitters so shared materials
  // are not cross-contaminated. Never repaint the whole hull when a map exists.
  host.ship.traverse((obj) => {
    if (!obj.isMesh || !obj.material) return;
    const srcMats = Array.isArray(obj.material) ? obj.material : [obj.material];
    const mats = srcMats.map((m) => {
      const c = m.clone();
      c.map = m.map || null;
      c.normalMap = m.normalMap || null;
      c.roughnessMap = m.roughnessMap || null;
      c.metalnessMap = m.metalnessMap || null;
      c.emissiveMap = m.emissiveMap || null;
      c.aoMap = m.aoMap || null;
      if (c.map) {
        c.map.colorSpace = THREE.SRGBColorSpace;
        c.map.needsUpdate = true;
      }
      c.userData = { ...(m.userData || {}), clonedFrom: m.name || 'mat', hadMap: !!m.map };
      return c;
    });
    obj.material = Array.isArray(obj.material) ? mats : mats[0];
    mats.forEach((mat) => {
      const materialName = `${mat.name || ''} ${obj.name || ''}`.toLowerCase();
      const hasMap = !!(mat.map || mat.normalMap || mat.roughnessMap || mat.metalnessMap || mat.emissiveMap);
      const isRegistry = isShipLabelMaterial(materialName);
      const isWarpCoil = /warp[_-]?coils?|warpcoil/.test(materialName);
      // Do not recolor or boost model nav-light materials. The user requested removal
      // of the artificial red/green saucer lamps; native GLB material values remain untouched.
      const { isGreenNav, isRedNav } = isNavigationLightMaterial(materialName);
      const isWindow = /window|pilot_light|force_field|sensor_ball/.test(materialName);
      const isEngine = /(bussard_dome|bussard|impulse_engines|thruster|plasma)/.test(materialName) && !isWarpCoil;

      if (isRegistry) {
        if (!hasMap && mat.color) mat.color.set(0x101820);
        if ('emissive' in mat) mat.emissive.set(0x000000);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0;
        if ('metalness' in mat) mat.metalness = Math.min(Number(mat.metalness ?? 0.2), 0.25);
        if ('roughness' in mat) mat.roughness = Math.max(Number(mat.roughness ?? 0.5), 0.45);
      } else if (isGreenNav || isRedNav) {
        const navColor = isGreenNav ? 0x2dff7a : 0xff2a3a;
        if (!hasMap && mat.color) mat.color.set(navColor);
        if ('emissive' in mat) mat.emissive.set(navColor);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = 2.6;
        mat.toneMapped = false;
      } else if (isWarpCoil) {
        // Preserve the strip texture but enforce the classic electric-blue energy tint.
        // Texture acts as a mask/detail layer; blue must remain visible at homepage distance.
        if (mat.color) mat.color.set(0x58c7ff);
        if ('emissive' in mat) mat.emissive.set(0x138dff);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(Number(mat.emissiveIntensity || 0), 4.4);
        if ('metalness' in mat) mat.metalness = 0.22;
        if ('roughness' in mat) mat.roughness = 0.20;
        mat.envMapIntensity = 0.65;
        mat.toneMapped = false;
      } else if (isEngine) {
        // Bussard collectors need an unmistakable warm contrast against blue warp strips.
        if (mat.color) mat.color.set(0xff7628);
        if ('emissive' in mat) mat.emissive.set(0xff4b12);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(Number(mat.emissiveIntensity || 0), 4.8);
        if ('metalness' in mat) mat.metalness = 0.18;
        if ('roughness' in mat) mat.roughness = 0.26;
        mat.envMapIntensity = 0.45;
        mat.toneMapped = false;
      } else if (isWindow) {
        if ('emissive' in mat && (!mat.emissive || mat.emissive.getHex() === 0)) mat.emissive.set(0x8ec7ff);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = Math.max(Number(mat.emissiveIntensity || 0), 0.55);
        mat.toneMapped = false;
      } else {
        // HULL: stronger metallization — brushed-steel look. Keep maps intact
        // (never repaint textured panels), only raise metalness toward full and
        // drop roughness for sharper specular/reflection. Lift envMapIntensity so
        // the metal actually catches reflections. Warp/Bussard/nav/registry/window
        // are handled in their own branches above and stay untouched.
        if (!hasMap) {
          const base = mat.color ? mat.color.getHex() : 0xffffff;
          // Neutral steel tint for untextured hull panels.
          if (mat.color && base === 0xffffff) mat.color.set(0xc2cad4);
        } else if (mat.color) {
          // Keep the panel map readable but let the metal tint show through.
          mat.color.set(0xdde3ea);
        }
        if ('metalness' in mat) mat.metalness = Math.max(Number(mat.metalness || 0), hasMap ? 0.92 : 0.88);
        if ('roughness' in mat) {
          const r = Number(mat.roughness ?? 0.5);
          // Lower ceiling => shinier, more reflective metal; keep a floor so it
          // is brushed steel, not a chrome mirror.
          mat.roughness = Math.min(Math.max(r, 0.16), 0.32);
        }
        mat.envMapIntensity = Math.max(Number(mat.envMapIntensity || 0), hasMap ? 1.5 : 1.3);
      }
      obj.castShadow = false;
      obj.receiveShadow = false;
      mat.needsUpdate = true;
    });
  });


}
