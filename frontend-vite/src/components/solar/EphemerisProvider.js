const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
const sameFrame = (a, b) => a && b && Object.keys(b).every((key) => a[key] === b[key]);

export function validateEphemeris(data, expected = {}) {
  if (!data || data.schema_version !== 1) return 'invalid_schema';
  if (expected.target && data.target !== expected.target) return 'invalid_target';
  if (!sameFrame(data.frame, expected.frame || data.frame)) return 'invalid_frame';
  if (data.time_scale !== 'TDB' || data.frame?.time_scale !== 'TDB') return 'invalid_time_scale';
  if (data.units?.position !== 'AU' || data.units?.velocity !== 'AU/day') return 'invalid_units';
  if (!Array.isArray(data.states) || data.states.length !== 1050) return 'invalid_states';
  if (!sameArray(data.jd_tdb_range, expected.jd_tdb_range || data.jd_tdb_range)) return 'invalid_range';
  if (expected.source_sha256 && !sameArray(data.source_sha256, expected.source_sha256)) return 'source_sha_mismatch';
  for (let i = 0; i < data.states.length; i += 1) {
    const state = data.states[i];
    if (!Array.isArray(state) || state.length !== 7 || !state.every(Number.isFinite)) return 'invalid_state';
    if (i > 0 && state[0] <= data.states[i - 1][0]) return 'non_monotonic';
  }
  if (data.states[0][0] !== data.jd_tdb_range[0] || data.states.at(-1)[0] !== data.jd_tdb_range[1]) return 'range_mismatch';
  return null;
}

export function hermiteState(a, b, t, h) {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  const dh00 = (6 * t2 - 6 * t) / h, dh10 = 3 * t2 - 4 * t + 1, dh01 = (-6 * t2 + 6 * t) / h, dh11 = 3 * t2 - 2 * t;
  return {
    position: [0, 1, 2].map((i) => h00 * a[i + 1] + h10 * h * a[i + 4] + h01 * b[i + 1] + h11 * h * b[i + 4]),
    velocity: [0, 1, 2].map((i) => dh00 * a[i + 1] + dh10 * a[i + 4] + dh01 * b[i + 1] + dh11 * b[i + 4])
  };
}

export function createEphemerisProvider(data, expected = {}) {
  const error = validateEphemeris(data, expected);
  if (error) return { ok: false, error };
  const states = data.states;
  return { ok: true, sample(jd) {
    if (!Number.isFinite(jd) || jd < states[0][0] || jd > states.at(-1)[0]) return { ok: false, error: 'out_of_range' };
    let lo = 0, hi = states.length - 1;
    while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (states[mid][0] < jd) lo = mid; else hi = mid; }
    const a = states[lo], b = states[hi], h = b[0] - a[0];
    return { ok: true, ...hermiteState(a, b, (jd - a[0]) / h, h) };
  }};
}

export async function loadP1Ephemerides(fetchImpl = fetch) {
  const base = '/assets/solar/p1';
  const manifestResponse = await fetchImpl(`${base}/manifest.json`);
  if (!manifestResponse.ok) throw new Error(`ephemeris manifest HTTP ${manifestResponse.status}`);
  const manifest = await manifestResponse.json();
  if (!manifest.coordinate_contract || typeof manifest.coordinate_contract !== 'object' || !Object.keys(manifest.coordinate_contract).length) {
    throw new Error('manifest coordinate_contract missing');
  }
  const result = {};
  const ranges = [];
  for (const target of ['mars', 'halley']) {
    const expected = manifest.targets?.[target];
    if (!expected || typeof expected !== 'object') throw new Error(`manifest target ${target} missing`);
    if (!Array.isArray(expected.jd_tdb_range) || expected.jd_tdb_range.length !== 2 || !expected.jd_tdb_range.every(Number.isFinite) || expected.jd_tdb_range[0] > expected.jd_tdb_range[1]) {
      throw new Error(`manifest target ${target} range invalid`);
    }
    if (!Array.isArray(expected.files) || expected.files.length === 0 || expected.files.some((file) => !file || typeof file.sha256 !== 'string' || !file.sha256)) {
      throw new Error(`manifest target ${target} files invalid`);
    }
    const response = await fetchImpl(`${base}/${target}.json`);
    if (!response.ok) throw new Error(`${target} ephemeris HTTP ${response.status}`);
    const provider = createEphemerisProvider(await response.json(), { target, frame: manifest.coordinate_contract, jd_tdb_range: expected?.jd_tdb_range, source_sha256: expected?.files?.map((file) => file.sha256) });
    if (!provider.ok) throw new Error(`${target} ephemeris ${provider.error}`);
    result[target] = provider;
    ranges.push(expected.jd_tdb_range);
  }
  const range = [Math.max(...ranges.map((item) => item[0])), Math.min(...ranges.map((item) => item[1]))];
  if (!range.every(Number.isFinite) || range[0] > range[1]) throw new Error('ephemeris common range invalid');
  return { providers: result, range };
}
