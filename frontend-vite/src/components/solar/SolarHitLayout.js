// Scheme D, including the 2026-09-30 target-clearance ruling. Units: CSS px.
export const SEP_X = 24.4;
export const MAX_OFF = 11.4;
export const R_EM = 12;
export const R_S = 12;
export const BOX = 24;
// Units: CSS px. Retain the existing 13.5 (= 12 + 1.5) clearance target;
// the 1.5 is a legacy allowance, not a device-pixel conversion.
// Unclipped Chromium measurements supplied on 2026-10-04 show up to
// 1.42 CSS px of directional hit-test overshoot. The 2026-10-02 Sun
// ablations used an interior probe and did not rule out hit geometry.
// All three targets require an explicit circular hit clip.
// This change does not recalibrate R_YIELD or resolve its envelope failures.
export const R_YIELD = 13.5;
export const MAX_OFF_S = 11;
export const D0 = 1.6;
export const EPS = 1e-6;

const point = (p) => ({
  x: Number.isFinite(p?.x) ? p.x : 0,
  y: Number.isFinite(p?.y) ? p.y : 0,
});
const clampSun = (value) => Math.min(Math.max(value, 0), MAX_OFF_S);
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const gap = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function solarHitBounds(canvas) {
  const width = Math.max(0, Number.isFinite(canvas.width) ? canvas.width : 0);
  const height = Math.max(0, Number.isFinite(canvas.height) ? canvas.height : 0);
  const halfX = Math.min(BOX / 2, width / 2);
  const halfY = Math.min(BOX / 2, height / 2);
  return { left: halfX, right: width - halfX, top: halfY, bottom: height - halfY, width, height };
}

const boundPoint = (p, bounds) => ({
  x: clamp(p.x, bounds.left, bounds.right),
  y: clamp(p.y, bounds.top, bounds.bottom),
});

// For a fixed half-separation h, feasible pair midpoints form an eroded
// rectangle. A shared shift q gives offsets q-t*e and q+t*e. Their largest
// squared length is |q|²+t²+2*|t|*|q.e|, a strictly convex function of q.
// Its minimizer is clamp(-lambda*e, rectangle), with lambda in [-|t|, |t|].
// Scalar bisection of q.e finds that unique, continuous projection. It never
// chooses between different separation directions.
function boundedPairAt(midpoint, ex, ey, d, t, bounds) {
  const half = Math.max(0, d / 2 + t);
  const hx = half * ex,
    hy = half * ey;
  const loX = bounds.left + Math.abs(hx) - midpoint.x;
  const hiX = Math.max(loX, bounds.right - Math.abs(hx) - midpoint.x);
  const loY = bounds.top + Math.abs(hy) - midpoint.y;
  const hiY = Math.max(loY, bounds.bottom - Math.abs(hy) - midpoint.y);
  let qx = clamp(0, loX, hiX),
    qy = clamp(0, loY, hiY);
  if (qx !== 0 || qy !== 0) {
    let lo = -Math.abs(t),
      hi = Math.abs(t);
    for (let i = 0; i < 48; i++) {
      const lambda = (lo + hi) / 2;
      qx = clamp(-lambda * ex, loX, hiX);
      qy = clamp(-lambda * ey, loY, hiY);
      if (qx * ex + qy * ey > 0) lo = lambda;
      else hi = lambda;
    }
    const lambda = (lo + hi) / 2;
    qx = clamp(-lambda * ex, loX, hiX);
    qy = clamp(-lambda * ey, loY, hiY);
  }
  return {
    earth: { x: midpoint.x + qx - hx, y: midpoint.y + qy - hy },
    moon: { x: midpoint.x + qx + hx, y: midpoint.y + qy + hy },
    offset: Math.max(Math.hypot(qx - t * ex, qy - t * ey), Math.hypot(qx + t * ex, qy + t * ey)),
    t,
  };
}

function fitPair(earth, moon, d, requestedT, bounds) {
  const midpoint = { x: (earth.x + moon.x) / 2, y: (earth.y + moon.y) / 2 };
  let ex = 0,
    ey = 0;
  if (d > 0) {
    ex = (moon.x - earth.x) / d;
    ey = (moon.y - earth.y) / d;
  }
  let halfCapacity = Infinity;
  if (ex !== 0)
    halfCapacity = Math.min(halfCapacity, (bounds.right - bounds.left) / (2 * Math.abs(ex)));
  if (ey !== 0)
    halfCapacity = Math.min(halfCapacity, (bounds.bottom - bounds.top) / (2 * Math.abs(ey)));
  const limit = MAX_OFF * Math.min(1, d / D0);
  const upper = Math.min(requestedT, halfCapacity - d / 2);
  let fitted = boundedPairAt(midpoint, ex, ey, d, upper, bounds);
  // No boundary interaction: retain the original arithmetic and positions.
  const unchanged =
    upper === requestedT &&
    fitted.earth.x >= bounds.left &&
    fitted.earth.x <= bounds.right &&
    fitted.earth.y >= bounds.top &&
    fitted.earth.y <= bounds.bottom &&
    fitted.moon.x >= bounds.left &&
    fitted.moon.x <= bounds.right &&
    fitted.moon.y >= bounds.top &&
    fitted.moon.y <= bounds.bottom &&
    Math.hypot(
      fitted.earth.x - earth.x + requestedT * ex,
      fitted.earth.y - earth.y + requestedT * ey,
    ) < 1e-12;
  if (fitted.offset > limit) {
    let minimum = boundedPairAt(midpoint, ex, ey, d, Math.min(0, upper), bounds);
    if (minimum.offset > limit) {
      // Raw projections can be outside the inset rectangle even when their
      // targets are visible. Compressing excess separation can then be needed
      // to fit within the same offset budget. The minimum required offset is
      // convex in t on [-d/2, upper]; find a feasible point before locating the
      // largest feasible separation. This is a scalar search, not a choice of
      // separation directions.
      let lo = -d / 2,
        hi = upper;
      for (let i = 0; i < 64; i++) {
        const left = lo + (hi - lo) / 3;
        const right = hi - (hi - lo) / 3;
        const a = boundedPairAt(midpoint, ex, ey, d, left, bounds);
        const b = boundedPairAt(midpoint, ex, ey, d, right, bounds);
        if (a.offset <= b.offset) hi = right;
        else lo = left;
      }
      minimum = boundedPairAt(midpoint, ex, ey, d, (lo + hi) / 2, bounds);
    }
    // If even the least required offset exceeds the budget, keep the largest
    // separation at that least violation. Do not jump to a coincident pair at
    // the first feasible frame; the actual excess remains a hard blocker.
    let available = limit;
    if (minimum.offset > limit) {
      available = minimum.offset + 32 * Number.EPSILON * Math.max(1, minimum.offset);
    }
    let lo = minimum.t,
      hi = upper;
    for (let i = 0; i < 48; i++) {
      const t = (lo + hi) / 2;
      const candidate = boundedPairAt(midpoint, ex, ey, d, t, bounds);
      if (candidate.offset <= available) lo = t;
      else hi = t;
    }
    fitted = boundedPairAt(midpoint, ex, ey, d, lo, bounds);
  }
  return { ...fitted, unchanged, limit, requestedSeparation: d + 2 * requestedT };
}

// This is a blocking diagnostic, not a new exemption band. Direction capacity
// proves infeasibility only for the retained stage-1 direction; it must never be
// reported as a proof that every possible rotated layout is infeasible.
export function inspectSolarHitBoundary(probes, layout, canvas) {
  const bounds = solarHitBounds(canvas);
  const d = gap(probes.earth, probes.moon);
  const separation = gap(layout.earth, layout.moon);
  const limit = MAX_OFF * Math.min(1, d / D0);
  const requiredSeparation = Math.min(SEP_X, d + 2 * limit);
  const offsets = {
    earth: gap(probes.earth, layout.earth),
    moon: gap(probes.moon, layout.moon),
    sun: gap(probes.sun, layout.sun),
  };
  const reasons = [];
  if (bounds.width < BOX || bounds.height < BOX) reasons.push('CANVAS_SMALLER_THAN_BUTTON');
  const inside = [layout.sun, layout.earth, layout.moon].every(
    (p) =>
      p.x >= bounds.left - EPS &&
      p.x <= bounds.right + EPS &&
      p.y >= bounds.top - EPS &&
      p.y <= bounds.bottom + EPS,
  );
  if (!inside) reasons.push('CENTER_OUTSIDE_BOUNDS');
  if (separation < requiredSeparation - EPS) reasons.push('PAIR_SEPARATION');
  if (offsets.earth > limit + EPS || offsets.moon > limit + EPS) reasons.push('PAIR_OFFSET');
  if (offsets.sun > MAX_OFF_S + EPS) reasons.push('SUN_OFFSET');
  const capacity = Math.hypot(bounds.right - bounds.left, bounds.bottom - bounds.top);
  const minimumOffsets = {
    earth: gap(probes.earth, boundPoint(probes.earth, bounds)),
    moon: gap(probes.moon, boundPoint(probes.moon, bounds)),
    sun: gap(probes.sun, boundPoint(probes.sun, bounds)),
  };
  let infeasibility = null;
  if (capacity < requiredSeparation) infeasibility = 'CANVAS_DIAGONAL';
  else if (bounds.width < BOX || bounds.height < BOX) infeasibility = 'CANVAS_SMALLER_THAN_BUTTON';
  else if (
    minimumOffsets.earth > limit + EPS ||
    minimumOffsets.moon > limit + EPS ||
    minimumOffsets.sun > MAX_OFF_S + EPS
  )
    infeasibility = 'PROJECTION_OUTSIDE_OFFSET_ENVELOPE';
  // At full offset saturation, equality in the triangle inequality requires
  // these exact two endpoints. Check that the boundary actually excludes one;
  // a short observed separation alone is never an infeasibility proof.
  if (d >= EPS && d + 2 * limit <= requiredSeparation + 1e-12) {
    const dx = (limit * (probes.moon.x - probes.earth.x)) / d;
    const dy = (limit * (probes.moon.y - probes.earth.y)) / d;
    const ends = [
      { x: probes.earth.x - dx, y: probes.earth.y - dy },
      { x: probes.moon.x + dx, y: probes.moon.y + dy },
    ];
    if (!infeasibility && ends.some((p) => gap(p, boundPoint(p, bounds)) > EPS)) {
      infeasibility = 'SATURATED_OFFSET_AT_BOUNDARY';
    }
  }
  const globalInfeasibilityProven = infeasibility !== null;
  return {
    bounds,
    inside,
    separation,
    requiredSeparation,
    offsets,
    minimumOffsets,
    pairOffsetLimit: limit,
    canvasCapacity: capacity,
    infeasibility,
    globalInfeasibilityProven,
    blocked: reasons.length > 0,
    reasons,
  };
}

export function solveSolarHitLayout(sunInput, earthInput, moonInput, canvas) {
  const sun = point(sunInput),
    earth = point(earthInput),
    moon = point(moonInput);
  const rx = moon.x - earth.x,
    ry = moon.y - earth.y;
  const d = Math.hypot(rx, ry);
  let t = 0;
  const centers = { sun: { ...sun }, earth: { ...earth }, moon: { ...moon } };
  if (d >= EPS) {
    t = Math.min(Math.max((SEP_X - d) / 2, 0), MAX_OFF * Math.min(1, d / D0));
    const ex = rx / d,
      ey = ry / d;
    centers.earth.x -= t * ex;
    centers.earth.y -= t * ey;
    centers.moon.x += t * ex;
    centers.moon.y += t * ey;
  }
  let pair;
  const bounds = canvas && solarHitBounds(canvas);
  if (bounds) {
    pair = fitPair(earth, moon, d, t, bounds);
    if (!pair.unchanged) {
      centers.earth = pair.earth;
      centers.moon = pair.moon;
      t = pair.t;
    }
  }
  const ax = sun.x - (earth.x + moon.x) / 2;
  const ay = sun.y - (earth.y + moon.y) / 2;
  const anchor = Math.hypot(ax, ay);
  let sCentre = 0,
    sTarget = 0,
    s = 0;
  // A zero anchor has no direction; the solar displacement has zero weight.
  if (anchor >= EPS) {
    const ux = ax / anchor,
      uy = ay / anchor;
    for (const center of [centers.earth, centers.moon]) {
      const dx = sun.x - center.x,
        dy = sun.y - center.y;
      const x = dx * ux + dy * uy;
      const w = Math.hypot(dx - x * ux, dy - x * uy);
      sCentre = Math.max(sCentre, clampSun(Math.sqrt(Math.max(R_YIELD ** 2 - w ** 2, 0)) - x));
    }
    // The center probe follows the button separation, not the celestial gap d.
    sTarget = clampSun(R_YIELD + SEP_X / 2 - anchor);
    s = Math.max(sCentre, sTarget);
    centers.sun.x += s * ux;
    centers.sun.y += s * uy;
  }
  const layout = { ...centers, d, t, anchor, s, sCentre, sTarget };
  if (bounds) {
    // The sun follows the same continuous ray projected onto the rectangle.
    // Its final displacement and ownership are audited below and by the DOM probe.
    layout.sun = boundPoint(layout.sun, bounds);
    layout.boundary = inspectSolarHitBoundary({ sun, earth, moon }, layout, canvas);
    layout.boundary.requestedSeparation = pair.requestedSeparation;
    layout.boundary.directionalSeparation = gap(layout.earth, layout.moon);
    layout.boundary.adjusted = !pair.unchanged || gap(centers.sun, layout.sun) > 0;
    if (
      layout.boundary.reasons.includes('PAIR_SEPARATION') &&
      !layout.boundary.globalInfeasibilityProven
    ) {
      layout.boundary.infeasibility = 'STAGE1_DIRECTION_AND_OFFSET';
    }
  }
  return layout;
}

// Classification is declarative: it never changes any center. DEGENERATE takes
// precedence where its predicates overlap STRICT. Uncovered inputs fail closed.
export function classifySolarHitLayout(probes, layout) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const d = distance(probes.earth, probes.moon);
  const anchor = distance(probes.sun, {
    x: (probes.earth.x + probes.moon.x) / 2,
    y: (probes.earth.y + probes.moon.y) / 2,
  });
  const c = Math.min(distance(layout.sun, layout.earth), distance(layout.sun, layout.moon));
  const targetClearance = Math.min(
    distance(layout.sun, probes.earth),
    distance(layout.sun, probes.moon),
  );
  const reasons = [];
  if (d < 1.574) reasons.push('d');
  if (anchor < 2 + d / 2) reasons.push('anchor');
  let band = 'UNCLASSIFIED';
  if (reasons.length) band = 'DEGENERATE';
  else if (c > 12) band = 'STRICT';
  else if (c >= 8 && targetClearance >= R_YIELD) band = 'DEGRADED-C';
  const boundaryBlocked = layout.boundary?.blocked === true;
  return { band, reasons, d, anchor, c, targetClearance, boundaryBlocked };
}
