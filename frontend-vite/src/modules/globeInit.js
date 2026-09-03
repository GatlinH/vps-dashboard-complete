export async function createGlobe(options) {
  const { CesiumGlobe } = await import('../components/CesiumGlobe.js');
  return new CesiumGlobe(options);
}
