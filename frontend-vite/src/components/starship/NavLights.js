export function isNavigationLightMaterial(materialName = '') {
  // Native GLB navigation lights remain untouched; no synthetic lamps are added.
  return { isGreenNav: false, isRedNav: false, materialName };
}
