// Two-body continuation outside the authoritative ephemeris window. Units are
// AU, day and AU^3/day^2 throughout. These constants are converted from the
// JPL Solar System Dynamics planetary satellite ephemeris GM values documented
// in docs/solar-real-period.md; the in-window JPL/Horizons states remain primary.
export const MU_SUN_AU3_DAY2 = 0.0002959122082855911;
export const MU_EARTH_MOON_AU3_DAY2 = 8.997011394006198e-10;

const finiteVector = (value) =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
const scale = (a, k) => a.map((value) => value * k);
const add = (a, b) => a.map((value, i) => value + b[i]);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const norm = (a) => Math.hypot(...a);

function stumpff(z) {
  if (Math.abs(z) < 1e-8) {
    return { c: 1 / 2 - z / 24 + (z * z) / 720, s: 1 / 6 - z / 120 + (z * z) / 5040 };
  }
  if (z > 0) {
    const root = Math.sqrt(z);
    return { c: (1 - Math.cos(root)) / z, s: (root - Math.sin(root)) / (root * root * root) };
  }
  const root = Math.sqrt(-z);
  return { c: (Math.cosh(root) - 1) / -z, s: (Math.sinh(root) - root) / (root * root * root) };
}

export function orbitalPeriodDays(position, velocity, mu) {
  if (!finiteVector(position) || !finiteVector(velocity) || !Number.isFinite(mu) || mu <= 0)
    return NaN;
  const radius = norm(position);
  const alpha = 2 / radius - dot(velocity, velocity) / mu;
  return radius > 0 && alpha > 0 ? (2 * Math.PI) / (Math.sqrt(mu) * alpha ** 1.5) : Infinity;
}

export function propagateTwoBody(position, velocity, durationDays, mu) {
  if (
    !finiteVector(position) ||
    !finiteVector(velocity) ||
    !Number.isFinite(durationDays) ||
    !Number.isFinite(mu) ||
    mu <= 0 ||
    !(norm(position) > 0)
  ) {
    return { ok: false, error: 'invalid_input' };
  }
  if (durationDays === 0) return { ok: true, position: [...position], velocity: [...velocity] };
  const r0 = norm(position),
    v02 = dot(velocity, velocity),
    rv0 = dot(position, velocity);
  const sqrtMu = Math.sqrt(mu),
    alpha = 2 / r0 - v02 / mu;
  let dt = durationDays;
  if (alpha > 0) {
    const period = (2 * Math.PI) / (sqrtMu * alpha ** 1.5);
    dt -= Math.round(dt / period) * period;
    if (Math.abs(dt) < 1e-13) return { ok: true, position: [...position], velocity: [...velocity] };
  }
  let chi = alpha !== 0 ? sqrtMu * Math.abs(alpha) * dt : (sqrtMu * dt) / r0;
  let converged = false;
  for (let i = 0; i < 64; i += 1) {
    const z = alpha * chi * chi,
      { c, s } = stumpff(z);
    const f =
      (rv0 / sqrtMu) * chi * chi * c + (1 - alpha * r0) * chi ** 3 * s + r0 * chi - sqrtMu * dt;
    const derivative = (rv0 / sqrtMu) * chi * (1 - z * s) + (1 - alpha * r0) * chi * chi * c + r0;
    if (!Number.isFinite(f) || !Number.isFinite(derivative) || derivative === 0) break;
    const delta = f / derivative;
    chi -= delta;
    if (Math.abs(delta) < 1e-12) {
      converged = true;
      break;
    }
  }
  if (!converged || !Number.isFinite(chi)) return { ok: false, error: 'propagation_failed' };
  const z = alpha * chi * chi,
    { c, s } = stumpff(z);
  const f = 1 - (chi * chi * c) / r0,
    g = dt - (chi ** 3 * s) / sqrtMu;
  const nextPosition = add(scale(position, f), scale(velocity, g));
  const radius = norm(nextPosition);
  const fdot = (sqrtMu / (radius * r0)) * (alpha * chi ** 3 * s - chi);
  const gdot = 1 - (chi * chi * c) / radius;
  const nextVelocity = add(scale(position, fdot), scale(velocity, gdot));
  if (!finiteVector(nextPosition) || !finiteVector(nextVelocity) || !(radius > 0))
    return { ok: false, error: 'propagation_failed' };
  return { ok: true, position: nextPosition, velocity: nextVelocity };
}

function continuedSample(provider, jd, mu = MU_SUN_AU3_DAY2) {
  if (
    !Number.isFinite(jd) ||
    !provider?.ok ||
    !Array.isArray(provider.range) ||
    !provider.endpointStates
  )
    return { ok: false, error: 'invalid_input' };
  const [start, end] = provider.range;
  if (jd >= start && jd <= end) return provider.sample(jd);
  const boundary = jd < start ? provider.endpointStates.start : provider.endpointStates.end;
  return propagateTwoBody(boundary.position, boundary.velocity, jd - boundary.jd, mu);
}

export function createContinuousEphemerisProviders(providers) {
  if (!providers || typeof providers !== 'object') return {};
  const result = {};
  for (const [name, provider] of Object.entries(providers)) {
    if (name === 'moon') continue;
    result[name] = { ok: Boolean(provider?.ok), sample: (jd) => continuedSample(provider, jd) };
  }
  const moon = providers.moon,
    earth = providers.earth;
  result.moon = {
    ok: Boolean(moon?.ok && earth?.ok),
    sample(jd) {
      if (
        !Number.isFinite(jd) ||
        !moon?.ok ||
        !earth?.ok ||
        !moon.endpointStates ||
        !earth.endpointStates
      )
        return { ok: false, error: 'invalid_input' };
      const [start, end] = moon.range;
      if (jd >= start && jd <= end) return moon.sample(jd);
      const side = jd < start ? 'start' : 'end';
      const moonBoundary = moon.endpointStates[side],
        earthBoundary = earth.endpointStates[side];
      const relative = propagateTwoBody(
        subtract(moonBoundary.position, earthBoundary.position),
        subtract(moonBoundary.velocity, earthBoundary.velocity),
        jd - moonBoundary.jd,
        MU_EARTH_MOON_AU3_DAY2,
      );
      const earthState = continuedSample(earth, jd);
      if (!relative.ok || !earthState.ok)
        return { ok: false, error: relative.error || earthState.error };
      return {
        ok: true,
        position: add(earthState.position, relative.position),
        velocity: add(earthState.velocity, relative.velocity),
      };
    },
  };
  return result;
}
