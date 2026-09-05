import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = pkg.dependencies ?? {};
const required = ['@deck.gl/layers', 'chart.js', 'three', 'cesium'];
const removed = ['@deck.gl/core', '@luma.gl/core', 'topojson-client', 'pixi.js'];
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
if (!vendor.length) throw new Error('No vendor chunk found');
const vendorCode = vendor.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
const pixiCount = (vendorCode.match(/pixi/gi) ?? []).length;
if (pixiCount !== 0) throw new Error(`pixi appears ${pixiCount} times in vendor chunk`);
const vendorBytes = vendor.reduce((n, f) => n + fs.statSync(path.join(assetsDir, f)).size, 0);
// Ratchet: current size plus roughly 5%; lower this ceiling when the chunk shrinks.
if (vendorBytes >= 1420 * 1024) throw new Error(`vendor chunk is ${vendorBytes} bytes (must be < 1454080)`);
const staleStarEffects = files.filter((f) => /^stareffects-/.test(f));
if (staleStarEffects.length) throw new Error(`stareffects artifacts found: ${staleStarEffects.join(', ')}`);
const allPixi = files.reduce((n, f) => n + (fs.readFileSync(path.join(assetsDir, f), 'utf8').match(/pixi/gi) ?? []).length, 0);
if (allPixi !== 0) throw new Error(`pixi appears ${allPixi} times across JS assets`);
console.log(`vendor bytes: ${vendorBytes}`);
console.log(`vendor pixi matches: ${pixiCount}`);
console.log(`all JS pixi matches: ${allPixi}`);
