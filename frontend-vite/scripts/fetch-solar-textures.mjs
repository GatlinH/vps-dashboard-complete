#!/usr/bin/env node
/**
 * fetch-solar-textures.mjs
 *
 * Downloads the 2K CC-BY planetary textures from Solar System Scope, derives a
 * mobile (1K) tier via ImageMagick `convert`, and emits an integrity manifest.
 *
 * Design constraints honored here:
 *   - Uses only node builtins (global fetch); no npm dependencies.
 *   - Idempotent: a file whose on-disk SHA256 already matches the recorded
 *     manifest hash is left untouched and not re-downloaded.
 *   - Desktop tier = untouched 2K original. Mobile tier = downscaled via the
 *     exact `convert` invocations mandated by the task.
 *
 * Usage: node scripts/fetch-solar-textures.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEXTURE_DIR = resolve(__dirname, '../public/assets/solar/textures-v1');
const MANIFEST_PATH = join(TEXTURE_DIR, 'manifest.json');
const CONVERT_BIN = '/usr/bin/convert';
const BASE_URL = 'https://www.solarsystemscope.com/textures/download/';

const ATTRIBUTION_STATEMENT =
  'Textures by Solar System Scope (CC BY 4.0), color-adjusted, based on NASA data';

// Per-asset source definitions. `file` is the desktop filename (== URL tail).
// `space` maps to the manifest color_space enum. Color/albedo maps are authored
// in sRGB; the ring alpha map carries no color information and is treated linear.
const ASSETS = [
  { name: 'mercury', file: '2k_mercury.jpg', space: 'srgb' },
  { name: 'venus', file: '2k_venus_atmosphere.jpg', space: 'srgb' },
  { name: 'earth', file: '2k_earth_daymap.jpg', space: 'srgb' },
  { name: 'earth_clouds', file: '2k_earth_clouds.jpg', space: 'srgb' },
  { name: 'moon', file: '2k_moon.jpg', space: 'srgb' },
  { name: 'mars', file: '2k_mars.jpg', space: 'srgb' },
  { name: 'jupiter', file: '2k_jupiter.jpg', space: 'srgb' },
  { name: 'saturn', file: '2k_saturn.jpg', space: 'srgb' },
  { name: 'saturn_ring', file: '2k_saturn_ring_alpha.png', space: 'linear' },
  { name: 'uranus', file: '2k_uranus.jpg', space: 'srgb' },
  { name: 'neptune', file: '2k_neptune.jpg', space: 'srgb' },
];

const MAX_RETRIES = 3;

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function mobileName(desktopFile) {
  // "2k_mercury.jpg" -> "2k_mercury-1k.jpg"; ".png" preserved for the ring.
  const dot = desktopFile.lastIndexOf('.');
  return `${desktopFile.slice(0, dot)}-1k${desktopFile.slice(dot)}`;
}

// --- image dimension decoders (shared logic with the verifier) -------------

function readJpegDimensions(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG');
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error(`invalid JPEG marker at ${offset}`);
    let marker = buf[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buf[offset + 1];
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segLen = buf.readUInt16BE(offset);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      return [buf.readUInt16BE(offset + 5), buf.readUInt16BE(offset + 3)];
    }
    offset += segLen;
  }
  throw new Error('no SOF marker in JPEG');
}

function readPngDimensions(buf) {
  if (buf.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG missing IHDR');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

function readDimensions(buf, file) {
  return file.toLowerCase().endsWith('.png')
    ? readPngDimensions(buf)
    : readJpegDimensions(buf);
}

function tierMeta(file, processing) {
  const diskPath = join(TEXTURE_DIR, file);
  const buf = readFileSync(diskPath);
  return {
    file,
    sha256: sha256(buf),
    bytes: statSync(diskPath).size,
    dimensions: readDimensions(buf, file),
    processing,
  };
}

async function download(url) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt}/${MAX_RETRIES} failed for ${url}: ${err.message}`);
    }
  }
  throw new Error(`BLOCKED: failed to download ${url} after ${MAX_RETRIES} attempts: ${lastErr.message}`);
}

function convertMobile(asset) {
  const desktopPath = join(TEXTURE_DIR, asset.file);
  const mobileFile = mobileName(asset.file);
  const mobilePath = join(TEXTURE_DIR, mobileFile);
  if (asset.file.toLowerCase().endsWith('.png')) {
    // Ring alpha: 1024x64 (thin strip), no quality flag for PNG.
    execFileSync(CONVERT_BIN, [desktopPath, '-resize', '1024x64', mobilePath]);
  } else {
    execFileSync(CONVERT_BIN, [desktopPath, '-resize', '1024x512', '-quality', '82', mobilePath]);
  }
  return mobileFile;
}

function mobileProcessing(asset) {
  return asset.file.toLowerCase().endsWith('.png')
    ? 'convert -resize 1024x64 (ImageMagick)'
    : 'convert -resize 1024x512 -quality 82 (ImageMagick)';
}

async function main() {
  mkdirSync(TEXTURE_DIR, { recursive: true });

  // Load prior manifest (if any) to support idempotent skips.
  let priorManifest = null;
  if (existsSync(MANIFEST_PATH)) {
    try {
      priorManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    } catch {
      priorManifest = null;
    }
  }

  const retrievedAt = new Date().toISOString();
  const textures = {};

  for (const asset of ASSETS) {
    const url = `${BASE_URL}${asset.file}`;
    const desktopPath = join(TEXTURE_DIR, asset.file);
    const mobileFile = mobileName(asset.file);
    const mobilePath = join(TEXTURE_DIR, mobileFile);

    const prior = priorManifest?.textures?.[asset.name];
    const priorDesktopSha = prior?.tiers?.desktop?.sha256;

    // Idempotency: reuse an on-disk desktop asset whose hash matches the record.
    let desktopReused = false;
    if (existsSync(desktopPath) && priorDesktopSha) {
      const diskSha = sha256(readFileSync(desktopPath));
      if (diskSha === priorDesktopSha) {
        desktopReused = true;
      }
    }

    if (desktopReused) {
      console.log(`= ${asset.name}: desktop up-to-date, skipping download`);
    } else {
      console.log(`↓ ${asset.name}: downloading ${url}`);
      const buf = await download(url);
      writeFileSync(desktopPath, buf);
    }

    // Rebuild mobile tier if missing or if the desktop source changed.
    const priorMobileSha = prior?.tiers?.mobile?.sha256;
    const mobileFresh =
      desktopReused && existsSync(mobilePath) && priorMobileSha
        ? sha256(readFileSync(mobilePath)) === priorMobileSha
        : false;

    if (mobileFresh) {
      console.log(`= ${asset.name}: mobile up-to-date, skipping convert`);
    } else {
      console.log(`⟳ ${asset.name}: generating mobile tier ${mobileFile}`);
      convertMobile(asset);
    }

    textures[asset.name] = {
      source_url: url,
      license: 'CC-BY-4.0',
      attribution: ATTRIBUTION_STATEMENT,
      retrieved_at_utc: prior?.retrieved_at_utc && desktopReused ? prior.retrieved_at_utc : retrievedAt,
      color_space: asset.space,
      tiers: {
        desktop: tierMeta(asset.file, 'original 2K source, unmodified'),
        mobile: tierMeta(mobileFile, mobileProcessing(asset)),
      },
    };
  }

  const manifest = {
    schema_version: 1,
    package_version: 'v1',
    license: 'CC-BY-4.0',
    attribution_statement: ATTRIBUTION_STATEMENT,
    textures,
  };

  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`✓ wrote manifest for ${Object.keys(textures).length} textures -> ${MANIFEST_PATH}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
