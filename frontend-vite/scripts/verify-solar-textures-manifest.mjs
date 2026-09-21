#!/usr/bin/env node
/**
 * verify-solar-textures-manifest.mjs
 *
 * Standalone integrity verifier for the tiered CC-BY solar texture package.
 * No third-party dependencies: schema validation, tier coverage, and on-disk
 * SHA256/bytes/dimension alignment are all implemented against node builtins.
 *
 * Dimensions are decoded by hand-parsing the JPEG SOF marker and PNG IHDR
 * chunk, so no image library is required.
 *
 * Exits non-zero on the first contract violation to hard-block the build.
 */
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXTURE_DIR = resolve(__dirname, '../public/assets/solar/textures-v1');
const MANIFEST_PATH = join(TEXTURE_DIR, 'manifest.json');

// The full set of celestial bodies + derived layers that must be present.
const REQUIRED_TEXTURES = [
  'mercury',
  'venus',
  'earth',
  'earth_clouds',
  'moon',
  'mars',
  'jupiter',
  'saturn',
  'saturn_ring',
  'uranus',
  'neptune',
];
const REQUIRED_TIERS = ['desktop', 'mobile'];
const COLOR_SPACES = ['srgb', 'linear'];
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const URI_RE = /^https?:\/\/\S+$/;

const failures = [];
function fail(msg) {
  failures.push(msg);
}
function assert(cond, msg) {
  if (!cond) fail(msg);
}

/**
 * Decode the intrinsic pixel dimensions of a JPEG by walking its markers
 * until a Start-Of-Frame (SOF0..SOF15, excluding DHT/JPG/DAC) is found.
 * @returns {[number, number]} [width, height]
 */
function readJpegDimensions(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error('not a JPEG (missing SOI marker)');
  }
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      throw new Error(`invalid JPEG marker at offset ${offset}`);
    }
    let marker = buf[offset + 1];
    // Skip fill bytes (0xff padding).
    while (marker === 0xff) {
      offset += 1;
      marker = buf[offset + 1];
    }
    offset += 2;
    // Standalone markers without a length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const segLen = buf.readUInt16BE(offset);
    // SOF markers carrying frame geometry (exclude DHT 0xc4, JPG 0xc8, DAC 0xcc).
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = buf.readUInt16BE(offset + 3);
      const width = buf.readUInt16BE(offset + 5);
      return [width, height];
    }
    offset += segLen;
  }
  throw new Error('no SOF marker found in JPEG');
}

/**
 * Decode PNG dimensions from the IHDR chunk (always first, at a fixed offset).
 * @returns {[number, number]} [width, height]
 */
function readPngDimensions(buf) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (buf[i] !== signature[i]) {
      throw new Error('not a PNG (bad signature)');
    }
  }
  // 8-byte sig, then 4-byte length, then "IHDR" tag, then width/height.
  const tag = buf.toString('ascii', 12, 16);
  if (tag !== 'IHDR') {
    throw new Error('PNG missing IHDR as first chunk');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return [width, height];
}

function readDimensions(buf, file) {
  if (file.toLowerCase().endsWith('.png')) {
    return readPngDimensions(buf);
  }
  return readJpegDimensions(buf);
}

function validateTierAsset(textureName, tier, meta) {
  const label = `textures.${textureName}.tiers.${tier}`;
  if (typeof meta !== 'object' || meta === null) {
    fail(`${label}: tier asset must be an object`);
    return;
  }
  for (const key of ['file', 'sha256', 'bytes', 'dimensions', 'processing']) {
    assert(key in meta, `${label}: missing required key "${key}"`);
  }
  assert(typeof meta.file === 'string' && meta.file.length > 0, `${label}.file must be a non-empty string`);
  assert(typeof meta.sha256 === 'string' && SHA256_RE.test(meta.sha256), `${label}.sha256 must match ^[a-f0-9]{64}$`);
  assert(Number.isInteger(meta.bytes) && meta.bytes >= 1, `${label}.bytes must be an integer >= 1`);
  assert(
    Array.isArray(meta.dimensions) && meta.dimensions.length === 2 && meta.dimensions.every(Number.isInteger),
    `${label}.dimensions must be an array of two integers`,
  );
  assert(typeof meta.processing === 'string' && meta.processing.length > 0, `${label}.processing must be a non-empty string`);

  if (typeof meta.file !== 'string') return;

  // On-disk entity alignment: recompute SHA256, byte size, and dimensions.
  const diskPath = join(TEXTURE_DIR, meta.file);
  if (!existsSync(diskPath)) {
    fail(`${label}: file "${meta.file}" not found on disk at ${diskPath}`);
    return;
  }
  const buf = readFileSync(diskPath);
  const actualBytes = statSync(diskPath).size;
  const actualSha = createHash('sha256').update(buf).digest('hex');

  if (Number.isInteger(meta.bytes)) {
    assert(actualBytes === meta.bytes, `${label}.bytes mismatch: manifest=${meta.bytes} disk=${actualBytes}`);
  }
  if (SHA256_RE.test(meta.sha256 || '')) {
    assert(actualSha === meta.sha256, `${label}.sha256 mismatch: manifest=${meta.sha256} disk=${actualSha}`);
  }
  if (Array.isArray(meta.dimensions) && meta.dimensions.length === 2) {
    try {
      const [w, h] = readDimensions(buf, meta.file);
      assert(
        w === meta.dimensions[0] && h === meta.dimensions[1],
        `${label}.dimensions mismatch: manifest=[${meta.dimensions.join(',')}] disk=[${w},${h}]`,
      );
    } catch (err) {
      fail(`${label}: failed to decode dimensions from "${meta.file}": ${err.message}`);
    }
  }
}

function main() {
  if (!existsSync(MANIFEST_PATH)) {
    fail(`manifest.json not found at ${MANIFEST_PATH}`);
    report();
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (err) {
    fail(`manifest.json is not valid JSON: ${err.message}`);
    report();
    return;
  }

  // Top-level schema fields.
  assert(manifest.schema_version === 1, 'schema_version must be the integer 1');
  assert(manifest.package_version === 'v1', 'package_version must be "v1"');
  assert(manifest.license === 'CC-BY-4.0', 'top-level license must be "CC-BY-4.0"');
  assert(
    typeof manifest.attribution_statement === 'string' && manifest.attribution_statement.length > 0,
    'attribution_statement must be a non-empty string',
  );
  assert(typeof manifest.textures === 'object' && manifest.textures !== null, 'textures must be an object');

  if (typeof manifest.textures !== 'object' || manifest.textures === null) {
    report();
    return;
  }

  // Full-coverage assertion: all 11 required bodies/layers present, no extras.
  const present = Object.keys(manifest.textures);
  for (const name of REQUIRED_TEXTURES) {
    assert(present.includes(name), `textures missing required entry "${name}"`);
  }
  for (const name of present) {
    assert(REQUIRED_TEXTURES.includes(name), `textures has unexpected entry "${name}"`);
  }

  for (const name of REQUIRED_TEXTURES) {
    const meta = manifest.textures[name];
    if (typeof meta !== 'object' || meta === null) {
      fail(`textures.${name}: must be an object`);
      continue;
    }
    for (const key of ['source_url', 'license', 'attribution', 'retrieved_at_utc', 'color_space', 'tiers']) {
      assert(key in meta, `textures.${name}: missing required key "${key}"`);
    }
    assert(typeof meta.source_url === 'string' && URI_RE.test(meta.source_url), `textures.${name}.source_url must be a URI`);
    assert(typeof meta.license === 'string' && meta.license.length > 0, `textures.${name}.license must be a non-empty string`);
    assert(typeof meta.attribution === 'string' && meta.attribution.length > 0, `textures.${name}.attribution must be a non-empty string`);
    assert(
      typeof meta.retrieved_at_utc === 'string' && DATE_TIME_RE.test(meta.retrieved_at_utc),
      `textures.${name}.retrieved_at_utc must be an ISO-8601 date-time`,
    );
    assert(COLOR_SPACES.includes(meta.color_space), `textures.${name}.color_space must be one of ${COLOR_SPACES.join('|')}`);

    if (typeof meta.tiers !== 'object' || meta.tiers === null) {
      fail(`textures.${name}.tiers must be an object`);
      continue;
    }
    for (const tier of REQUIRED_TIERS) {
      assert(tier in meta.tiers, `textures.${name}.tiers missing "${tier}"`);
    }
    for (const tier of REQUIRED_TIERS) {
      if (tier in meta.tiers) {
        validateTierAsset(name, tier, meta.tiers[tier]);
      }
    }
  }

  report();
}

function report() {
  if (failures.length > 0) {
    console.error(`✗ solar texture manifest verification FAILED (${failures.length} issue(s)):`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }
  const count = Object.keys(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).textures).length;
  console.log(`✓ solar texture manifest verified: ${count} textures × ${REQUIRED_TIERS.length} tiers, SHA256/bytes/dimensions aligned on disk.`);
}

main();
