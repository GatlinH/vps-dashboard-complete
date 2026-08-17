const SHIP_LABEL_PATTERN = /registry|decal|letter|ncc|label_\d+/;

export function isShipLabelMaterial(materialName = '') {
  return SHIP_LABEL_PATTERN.test(materialName);
}
