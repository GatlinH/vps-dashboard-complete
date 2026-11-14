// Native JPL DE440 coefficients, copied without a refit. Manifest + body/time
// blocks are local static assets. All samples carry their origin/frame/units.
// No continuation, calendar wrap, or two-body fallback. See scientific provenance.
import { createPrecisionAssetStore } from './PrecisionAssetStore.js';

export const PRECISION_ASSET_BASE = '/assets/solar/de440-1900-2100';
export const PRECISION_JD_RANGE = Object.freeze([2415020.5, 2488434.5]);
const AU_KM = 149597870.7;
const OBLIQUITY = ((84381.448 / 3600) * Math.PI) / 180;
const DE440_SHA = 'c1c7feeab882263fc493a9d5a5b2ddd71b54826cdf65d8d17a76126b260a49f2';
const SEGMENTS = {
  mercury: [0, 1],
  venus: [0, 2],
  emb: [0, 3],
  mars: [0, 4],
  jupiter: [0, 5],
  saturn: [0, 6],
  uranus: [0, 7],
  neptune: [0, 8],
  sun: [0, 10],
  moon_emb: [3, 301],
  earth_emb: [3, 399],
};
const PARTS = {
  mercury: [
    ['mercury', 1],
    ['sun', -1],
  ],
  venus: [
    ['venus', 1],
    ['sun', -1],
  ],
  earth: [
    ['emb', 1],
    ['earth_emb', 1],
    ['sun', -1],
  ],
  mars: [
    ['mars', 1],
    ['sun', -1],
  ],
  jupiter: [
    ['jupiter', 1],
    ['sun', -1],
  ],
  saturn: [
    ['saturn', 1],
    ['sun', -1],
  ],
  uranus: [
    ['uranus', 1],
    ['sun', -1],
  ],
  neptune: [
    ['neptune', 1],
    ['sun', -1],
  ],
  moon: [
    ['moon_emb', 1],
    ['earth_emb', -1],
  ],
};
const inRange = (jd, range) => Number.isFinite(jd) && jd >= range[0] && jd <= range[1];
const validHashes = (hashes, count) =>
  Array.isArray(hashes) &&
  hashes.length === count &&
  hashes.every((hash) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));

function validateManifest(manifest) {
  const invalid = (message) => {
    throw new Error(`precision manifest contract: ${message}`);
  };
  if (manifest?.schema_version !== 2 || manifest.format !== 'de440-native-chebyshev-f64le-v1')
    invalid('unsupported format');
  const expected = {
    source_frame: 'J2000',
    source_position_unit: 'km',
    frame: 'ECLIPJ2000',
    reference_system: 'ICRF',
    time_scale: 'TDB',
    position_unit: 'AU',
    velocity_unit: 'AU/day',
    au_km: AU_KM,
    obliquity_arcsec: 84381.448,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (manifest.coordinate_contract?.[key] !== value) invalid(key);
  }
  if (manifest.source?.sha256 !== DE440_SHA) invalid('source kernel');
  if (JSON.stringify(manifest.jd_tdb_range) !== JSON.stringify(PRECISION_JD_RANGE))
    invalid('coverage');
  if (
    manifest.block_days !== 1024 ||
    !Number.isFinite(manifest.origin_jd) ||
    manifest.origin_jd > PRECISION_JD_RANGE[0] ||
    manifest.origin_jd < PRECISION_JD_RANGE[0] - 32
  )
    invalid('block grid');
  for (const [name, [center, target]] of Object.entries(SEGMENTS)) {
    const s = manifest.segments?.[name];
    if (
      !s ||
      s.center !== center ||
      s.target !== target ||
      !Number.isInteger(s.degree) ||
      s.degree < 1 ||
      s.degree > 32 ||
      ![4, 8, 16, 32].includes(s.record_days) ||
      s.block_records !== manifest.block_days / s.record_days ||
      s.record_count !== Math.ceil((PRECISION_JD_RANGE[1] - manifest.origin_jd) / s.record_days) ||
      !validHashes(s.sha256, Math.ceil(s.record_count / s.block_records))
    )
      invalid(`segment ${name}`);
  }
  for (const [name, parts] of Object.entries(PARTS)) {
    const target = manifest.targets?.[name];
    const id = { mercury: 199, venus: 299, earth: 399, moon: 301 }[name] ?? SEGMENTS[name]?.[1];
    if (
      !target ||
      target.target !== id ||
      target.center !== (name === 'moon' ? 399 : 10) ||
      JSON.stringify(target.parts) !== JSON.stringify(parts) ||
      target.kind !== (id > 100 ? 'body_center' : 'system_barycenter')
    )
      invalid(`target ${name}`);
  }
  const h = manifest.halley;
  if (
    !h ||
    h.kind !== 'orbital_position_only' ||
    h.format !== 'chebyshev-json-v1' ||
    h.frame !== 'ECLIPJ2000' ||
    h.time_scale !== 'TDB' ||
    h.center !== 10 ||
    h.position_unit !== 'AU' ||
    h.velocity_unit !== 'AU/day' ||
    h.source?.solution !== 'JPL#75' ||
    h.source?.planetary_ephemeris !== 'DE441' ||
    JSON.stringify(h.jd_tdb_range) !== JSON.stringify([2415020.5, 2488070.5]) ||
    !validHashes(
      h.sha256,
      Math.ceil((h.jd_tdb_range[1] - manifest.origin_jd) / manifest.block_days),
    ) ||
    !Array.isArray(h.bytes) ||
    h.bytes.length !== h.sha256.length ||
    !h.bytes.every((n) => Number.isInteger(n) && n > 0 && n <= 128 * 1024)
  )
    invalid('Halley');
}

// Clenshaw value and analytic d/du; coefficients c0..cn in source units.
function evaluate(coefficients, offset, count, u) {
  let b1 = 0,
    b2 = 0,
    d1 = 0,
    d2 = 0;
  for (let k = count - 1; k >= 1; k -= 1) {
    const b = 2 * u * b1 - b2 + coefficients[offset + k];
    const d = 2 * b1 + 2 * u * d1 - d2;
    b2 = b1;
    b1 = b;
    d2 = d1;
    d1 = d;
  }
  return [u * b1 - b2 + coefficients[offset], b1 + u * d1 - d2];
}

function decodeNative(buffer) {
  const view = new DataView(buffer);
  const data = new Float64Array(buffer.byteLength / 8);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = view.getFloat64(i * 8, true);
    if (!Number.isFinite(data[i])) throw new Error('precision non-finite coefficient');
  }
  return data;
}

function decodeHalley(buffer, start, end) {
  const rows = JSON.parse(new TextDecoder().decode(buffer));
  if (!Array.isArray(rows) || !rows.length) throw new Error('invalid Halley block');
  let previous = start;
  for (const row of rows) {
    const [a, b, coeff] = row;
    if (
      row.length !== 3 ||
      a !== previous ||
      !Number.isFinite(b) ||
      b <= a ||
      b > end ||
      !Array.isArray(coeff) ||
      coeff.length !== 3 ||
      !coeff.every(
        (axis) =>
          Array.isArray(axis) &&
          axis.length >= 2 &&
          axis.length <= 15 &&
          axis.length === coeff[0].length &&
          axis.every(Number.isFinite),
      )
    ) {
      throw new Error('invalid Halley coefficient/time block');
    }
    previous = b;
  }
  if (previous !== end) throw new Error('incomplete Halley block');
  return rows;
}

const eclipticAu = (v) => [
  v[0] / AU_KM,
  (Math.cos(OBLIQUITY) * v[1] + Math.sin(OBLIQUITY) * v[2]) / AU_KM,
  (-Math.sin(OBLIQUITY) * v[1] + Math.cos(OBLIQUITY) * v[2]) / AU_KM,
];

export async function loadPrecisionEphemerides(
  fetchImpl = fetch,
  base = PRECISION_ASSET_BASE,
  options = {},
) {
  const store = createPrecisionAssetStore(fetchImpl, options);
  let manifest;
  try {
    manifest = await store.loadManifest(`${base}/manifest.json`);
    validateManifest(manifest);
  } catch (error) {
    store.dispose();
    throw error;
  }
  const range = [...manifest.jd_tdb_range];
  const origin = manifest.origin_jd;
  const blockIndex = (jd, meta) =>
    Math.min(Math.floor((jd - origin) / manifest.block_days), meta.sha256.length - 1);
  const keyFor = (name, jd, meta) => `${name}/${blockIndex(jd, meta)}`;
  const urlFor = (name, index, hash, extension) =>
    `${base}/${name}/${String(index).padStart(3, '0')}-${hash.slice(0, 16)}.${extension}`;

  function nativeEnsure(name, jd) {
    const meta = manifest.segments[name];
    const index = blockIndex(jd, meta);
    const hash = meta.sha256[index];
    const records = Math.min(meta.block_records, meta.record_count - index * meta.block_records);
    return store.load(
      keyFor(name, jd, meta),
      urlFor(name, index, hash, 'f64'),
      hash,
      records * 3 * (meta.degree + 1) * 8,
      decodeNative,
    );
  }

  function nativeSample(name, jd) {
    const meta = manifest.segments[name];
    const index = blockIndex(jd, meta);
    const data = store.get(keyFor(name, jd, meta));
    if (!data) return null;
    const record = Math.min(Math.floor((jd - origin) / meta.record_days), meta.record_count - 1);
    const local = record - index * meta.block_records;
    const u = (2 * (jd - (origin + record * meta.record_days))) / meta.record_days - 1;
    const position = [],
      velocity = [];
    for (let axis = 0; axis < 3; axis += 1) {
      const [p, dp] = evaluate(data, (local * 3 + axis) * (meta.degree + 1), meta.degree + 1, u);
      position.push(p);
      velocity.push((dp * 2) / meta.record_days);
    }
    return { position, velocity }; // Native J2000 km, km/TDB day.
  }

  const providers = {};
  for (const [name, parts] of Object.entries(PARTS)) {
    const target = manifest.targets[name];
    const metadata = Object.freeze({
      source: 'JPL DE440',
      target: target.target,
      center: target.center,
      targetKind: target.kind,
      frame: 'ECLIPJ2000',
      timeScale: 'TDB',
      positionUnit: 'AU',
      velocityUnit: 'AU/day',
    });
    providers[name] = {
      ok: true,
      range: [...range],
      metadata,
      geocentric: name === 'moon',
      async ensure(jd) {
        store.assertActive();
        if (!inRange(jd, range)) throw new Error('out_of_range');
        await Promise.all(parts.map(([part]) => nativeEnsure(part, jd)));
      },
      sample(jd) {
        if (!inRange(jd, range)) return { ok: false, error: 'out_of_range', metadata };
        const p = [0, 0, 0],
          v = [0, 0, 0];
        for (const [part, sign] of parts) {
          const s = nativeSample(part, jd);
          if (!s) return { ok: false, error: 'not_loaded', metadata };
          for (let i = 0; i < 3; i += 1) {
            p[i] += sign * s.position[i];
            v[i] += sign * s.velocity[i];
          }
        }
        return { ok: true, position: eclipticAu(p), velocity: eclipticAu(v), metadata };
      },
    };
  }

  const h = manifest.halley;
  const hMetadata = Object.freeze({
    source: 'JPL Horizons JPL#75 / DE441',
    target: '1P/Halley',
    center: 10,
    targetKind: 'comet',
    frame: 'ECLIPJ2000',
    timeScale: 'TDB',
    positionUnit: 'AU',
    velocityUnit: 'AU/day',
    nucleusOrientation: 'unmodelled',
  });
  providers.halley = {
    ok: true,
    kind: 'orbital_position_only',
    range: [...h.jd_tdb_range],
    metadata: hMetadata,
    async ensure(jd) {
      store.assertActive();
      if (!inRange(jd, h.jd_tdb_range)) throw new Error('out_of_range');
      const index = blockIndex(jd, h);
      const hash = h.sha256[index];
      const start = Math.max(origin + index * manifest.block_days, h.jd_tdb_range[0]);
      const end = Math.min(origin + (index + 1) * manifest.block_days, h.jd_tdb_range[1]);
      await store.load(
        keyFor('halley', jd, h),
        urlFor('halley', index, hash, 'json'),
        hash,
        h.bytes[index],
        (buffer) => decodeHalley(buffer, start, end),
      );
    },
    sample(jd) {
      if (!inRange(jd, h.jd_tdb_range))
        return { ok: false, error: 'out_of_range', metadata: hMetadata };
      const rows = store.get(keyFor('halley', jd, h));
      if (!rows) return { ok: false, error: 'not_loaded', metadata: hMetadata };
      let lo = 0,
        hi = rows.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (rows[mid][1] <= jd) lo = mid + 1;
        else hi = mid;
      }
      const [start, end, coefficients] = rows[lo];
      const u = (2 * (jd - start)) / (end - start) - 1;
      const position = [],
        velocity = [];
      for (const axis of coefficients) {
        const [p, dp] = evaluate(axis, 0, axis.length, u);
        position.push(p);
        velocity.push((dp * 2) / (end - start));
      }
      return { ok: true, position, velocity, metadata: hMetadata };
    },
  };

  // Dust samples the preceding 100 days, rounded to 0.1 day. Prefetch only
  // those one/two Halley blocks; no release outside the source range is invented.
  const historyEpochs = (jd) =>
    inRange(jd, h.jd_tdb_range)
      ? [Math.max(h.jd_tdb_range[0], jd - 100.1), Math.min(h.jd_tdb_range[1], jd + 0.1)]
      : [];
  const result = {
    providers,
    range,
    manifest,
    getEpochKey(jd) {
      return [
        ...Object.keys(SEGMENTS).map((name) => keyFor(name, jd, manifest.segments[name])),
        ...historyEpochs(jd).map((epoch) => keyFor('halley', epoch, h)),
      ].join('|');
    },
    async ensureEpoch(jd) {
      store.assertActive();
      if (!inRange(jd, range)) throw new Error('out_of_range');
      await Promise.all([
        ...Object.keys(SEGMENTS).map((name) => nativeEnsure(name, jd)),
        ...historyEpochs(jd).map((epoch) => providers.halley.ensure(epoch)),
      ]);
    },
    isEpochReady(jd) {
      return (
        inRange(jd, range) &&
        Object.keys(SEGMENTS).every((name) =>
          store.has(keyFor(name, jd, manifest.segments[name])),
        ) &&
        historyEpochs(jd).every((epoch) => store.has(keyFor('halley', epoch, h)))
      );
    },
    getDiagnostics: store.getDiagnostics,
    dispose: store.dispose,
  };
  if (options.initialJd !== undefined) {
    try {
      await result.ensureEpoch(options.initialJd);
    } catch (error) {
      result.dispose();
      throw error;
    }
  }
  return result;
}
