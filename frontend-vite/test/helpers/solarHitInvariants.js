import { classifySolarHitLayout } from '../../src/components/solar/SolarHitLayout.js';

export const keys = ['sun', 'earth', 'moon'];
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const signatureAllowed = 'E_stolen_by_moon + M_stolen_by_earth';

// Largest disk inside a button and outside every higher-z disk. For a trial r,
// candidate centers lie in disk(R-r) minus disks(R_blocker+r). Feasibility can
// change only at circle intersections or radial extrema on the outer boundary.
function intersections(a, ra, b, rb) {
  const d = distance(a, b);
  if (!d || d > ra + rb || d < Math.abs(ra - rb)) return [];
  const x = (ra * ra - rb * rb + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(ra * ra - x * x, 0));
  const ux = (b.x - a.x) / d,
    uy = (b.y - a.y) / d;
  return [-1, 1].map((sign) => ({
    x: a.x + x * ux - sign * h * uy,
    y: a.y + x * uy + sign * h * ux,
  }));
}
export function ownDisk(center, radius, blockers) {
  blockers = blockers.filter((b) => distance(center, b.center) < radius + b.radius);
  if (blockers.length === 1) {
    const b = blockers[0],
      d = distance(center, b.center);
    const r = Math.max(0, Math.min(radius, (d + radius - b.radius) / 2));
    if (!d) return { radius: r, center: { ...center } };
    const p = {
      x: center.x + ((radius - r) * (center.x - b.center.x)) / d,
      y: center.y + ((radius - r) * (center.y - b.center.y)) / d,
    };
    return {
      radius: Math.max(0, Math.min(radius - distance(p, center), distance(p, b.center) - b.radius)),
      center: p,
    };
  }
  if (!blockers.length) return { radius, center: { ...center } };
  const feasible = (r) => {
    const inner = radius - r;
    const candidates = [center];
    for (const b of blockers) {
      const d = distance(center, b.center);
      if (d)
        candidates.push({
          x: center.x + (inner * (center.x - b.center.x)) / d,
          y: center.y + (inner * (center.y - b.center.y)) / d,
        });
      candidates.push(...intersections(center, inner, b.center, b.radius + r));
    }
    for (let i = 0; i < blockers.length; i++)
      for (let j = i + 1; j < blockers.length; j++) {
        candidates.push(
          ...intersections(
            blockers[i].center,
            blockers[i].radius + r,
            blockers[j].center,
            blockers[j].radius + r,
          ),
        );
      }
    return candidates.find(
      (p) =>
        distance(p, center) <= inner + 1e-12 &&
        blockers.every((b) => distance(p, b.center) >= b.radius + r - 1e-12),
    );
  };
  let lo = 0,
    hi = radius,
    witness = feasible(0);
  if (!witness) return { radius: 0, center: { ...center } };
  for (let i = 0; i < 44; i++) {
    const mid = (lo + hi) / 2,
      p = feasible(mid);
    if (p) {
      lo = mid;
      witness = p;
    } else hi = mid;
  }
  // Certify the actual returned circle directly, without the search tolerance.
  const certified = Math.max(
    0,
    Math.min(
      radius - distance(witness, center),
      ...blockers.map((b) => distance(witness, b.center) - b.radius),
    ),
  );
  return { radius: certified, center: witness };
}

export function inspectInvariants(probes, layout, options = {}) {
  const radii = options.radii || { sun: 12, earth: 12, moon: 12 };
  const order = options.order || keys;
  const owner = (p) => order.find((key) => distance(p, layout[key]) <= radii[key]) || null;
  const targetOwners = Object.fromEntries(keys.map((key) => [key, owner(probes[key])]));
  const centerOwners = Object.fromEntries(keys.map((key) => [key, owner(layout[key])]));
  const signature = [];
  for (const [key, prefix] of [
    ['earth', 'E'],
    ['moon', 'M'],
    ['sun', 'S'],
  ]) {
    if (distance(probes[key], layout[key]) > radii[key])
      signature.push(`${prefix}_probe_outside_own`);
    // The ruling records geometric mutual coverage, then resolves actual owner
    // with z-order; Earth covered by Moon alone is NOT an Earth ownership loss.
    const others =
      key === 'sun' ? order.slice(0, order.indexOf(key)) : keys.filter((other) => other !== key);
    for (const other of others)
      if (distance(probes[key], layout[other]) <= radii[other])
        signature.push(`${prefix}_stolen_by_${other}`);
  }
  const own = Object.fromEntries(
    keys.map((key) => [
      key,
      ownDisk(
        layout[key],
        radii[key],
        order
          .slice(0, order.indexOf(key))
          .map((other) => ({ center: layout[other], radius: radii[other] })),
      ),
    ]),
  );
  const minOwn = Math.min(...keys.map((key) => own[key].radius));
  const classification = classifySolarHitLayout(probes, layout);
  const i1 = keys.every((key) => targetOwners[key] === key) && centerOwners.sun === 'sun';
  const i2 = minOwn >= 4;
  const exactSignature = signature.join(' + ');
  const exempt =
    !classification.boundaryBlocked &&
    !i1 &&
    i2 &&
    classification.band === 'DEGENERATE' &&
    exactSignature === signatureAllowed &&
    targetOwners.earth === 'earth' &&
    targetOwners.sun === 'sun' &&
    centerOwners.sun === 'sun' &&
    targetOwners.moon === 'earth';
  const near =
    distance(layout.sun, layout.earth) <= distance(layout.sun, layout.moon) ? 'earth' : 'moon';
  const i3Failures = ['earth', 'moon'].filter((key) => centerOwners[key] !== key);
  const declaredI3 =
    !classification.boundaryBlocked &&
    ['DEGRADED-C', 'DEGENERATE'].includes(classification.band) &&
    classification.c <= 12 &&
    i3Failures.every((key) => key === near && centerOwners[key] === 'sun');
  return {
    ...classification,
    targetOwners,
    centerOwners,
    signature: exactSignature,
    own,
    minOwn,
    i1,
    i2,
    exempt,
    i3Failures,
    declaredI3,
    real:
      (!i1 && !exempt) ||
      !i2 ||
      classification.band === 'UNCLASSIFIED' ||
      classification.boundaryBlocked ||
      classification.reasons.includes('anchor') ||
      (i3Failures.length > 0 && !declaredI3),
  };
}
