const R = [0, 0.39, 1, 5.2, 30.1];
const D = [0, 9, 19, 35, 62];
export function mapRadial(r) {
  if (r >= R[4]) return D[4] + 1.5 * (r - R[4]);
  for (let i = 0; i < R.length - 1; i += 1) if (r <= R[i + 1]) {
    const t = (r - R[i]) / (R[i + 1] - R[i]);
    return D[i] + t * (D[i + 1] - D[i]);
  }
  return 0;
}
export function physicalToDisplay(v) {
  const r = Math.hypot(v.x, v.y, v.z);
  if (!r) return { x: 0, y: 0, z: 0 };
  const s = mapRadial(r) / r;
  return { x: v.x * s, y: 0, z: -v.y * s };
}
