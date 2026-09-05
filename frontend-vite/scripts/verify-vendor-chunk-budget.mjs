import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = pkg.dependencies ?? {};
const required = ['@deck.gl/layers', 'chart.js', 'three', 'cesium', 'pixi.js'];
const removed = ['@deck.gl/core', '@luma.gl/core', 'topojson-client'];
for (const name of removed) if (name in deps) throw new Error(`Removed dependency still declared: ${name}`);
for (const name of required) if (!(name in deps)) throw new Error(`Required dependency missing: ${name}`);

const assetsDir = path.resolve(root, '../frontend-dist/assets');
const latestMtime = (target) => {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  return fs.readdirSync(target, { withFileTypes: true }).reduce((latest, entry) => {
    return Math.max(latest, latestMtime(path.join(target, entry.name)));
  }, stat.mtimeMs);
};
const sourceMtime = Math.max(latestMtime(path.join(root, 'src')), latestMtime(path.join(root, 'vite.config.js')));
const distMtime = latestMtime(assetsDir);
if (distMtime < sourceMtime) {
  throw new Error('frontend-dist/assets is older than src/ or vite.config.js; run npm run build first');
}
const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const vendor = files.filter((f) => /^vendor-[^/]+\.js$/.test(f));
const cesium = files.filter((f) => /^cesium-[^/]+\.js$/.test(f));
const starEffects = files.filter((f) => /^stareffects-[^/]+\.js$/.test(f));
if (!vendor.length) throw new Error('No vendor chunk found');
const vendorCode = vendor.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
const pixiCount = (vendorCode.match(/pixi/gi) ?? []).length;
if (pixiCount !== 0) throw new Error(`pixi appears ${pixiCount} times in vendor chunk`);
const vendorBytes = vendor.reduce((n, f) => n + fs.statSync(path.join(assetsDir, f)).size, 0);
// Ratchet: current size plus roughly 5%; lower this ceiling when the chunk shrinks.
if (vendorBytes >= 1420 * 1024) throw new Error(`vendor chunk is ${vendorBytes} bytes (must be < 1454080)`);
if (starEffects.length !== 1) {
  throw new Error(`Expected exactly one stareffects chunk, found ${starEffects.length}: ${starEffects.join(', ')}`);
}
const starEffectsBytes = fs.statSync(path.join(assetsDir, starEffects[0])).size;
if (starEffectsBytes <= 400 * 1024) {
  throw new Error(`stareffects chunk is ${starEffectsBytes} bytes (must be > 409600)`);
}
const moved = files.filter((f) => !vendor.includes(f) && !cesium.includes(f));
const movedPixi = moved.filter((f) => /pixi/i.test(fs.readFileSync(path.join(assetsDir, f), 'utf8')));
if (movedPixi.length !== 1 || movedPixi[0] !== starEffects[0]) {
  throw new Error(`Expected pixi text in exactly ${starEffects[0]}, found: ${movedPixi.join(', ')}`);
}
console.log(`vendor bytes: ${vendorBytes}`);
console.log(`vendor pixi matches: ${pixiCount}`);
console.log(`stareffects bytes: ${starEffectsBytes}`);
console.log(`pixi chunk: ${movedPixi[0]}`);
