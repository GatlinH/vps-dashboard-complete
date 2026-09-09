import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const deps = pkg.dependencies ?? {};
const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies);
const required = ['@deck.gl/layers', 'chart.js', 'three', 'cesium'];
const removed = ['@deck.gl/core', '@luma.gl/core', 'topojson-client', 'pixi.js'];
for (const name of removed) if (name in allDeps) throw new Error(`Removed dependency still declared: ${name}`);
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
const collectFiles = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const relative = path.join(prefix, entry.name);
  return entry.isDirectory() ? collectFiles(path.join(dir, entry.name), relative) : [relative];
});
const allFiles = collectFiles(assetsDir);
const files = allFiles.filter((f) => f.endsWith('.js'));
const vendor = files.filter((f) => /^vendor-[^/]+\.js$/.test(f));
const cesium = files.filter((f) => /^cesium-[^/]+\.js$/.test(f));
if (!vendor.length) throw new Error('No vendor chunk found');
if (!cesium.length) throw new Error('No cesium chunk found');
const distDir = path.resolve(root, '../frontend-dist');
const cesiumFileNames = cesium.map((f) => f.split('/').pop());
const collectHtmlFiles = (dir, prefix = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const relative = path.join(prefix, entry.name);
  return entry.isDirectory() ? collectHtmlFiles(path.join(dir, entry.name), relative) : (entry.name.endsWith('.html') ? [relative] : []);
});
const htmlFiles = collectHtmlFiles(distDir);
for (const html of htmlFiles) {
  const body = fs.readFileSync(path.join(distDir, html), 'utf8');
  for (const name of cesiumFileNames) {
    if (body.includes(name)) {
      throw new Error(`cesium chunk ${name} must not appear in ${html} (keeps it lazy-loaded)`);
    }
  }
}
const vendorCode = vendor.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
const pixiCount = (vendorCode.match(/pixi/gi) ?? []).length;
if (pixiCount !== 0) throw new Error(`pixi appears ${pixiCount} times in vendor chunk`);
const vendorBytes = vendor.reduce((n, f) => n + fs.statSync(path.join(assetsDir, f)).size, 0);
// Ratchet: current size plus roughly 5%; lower this ceiling when the chunk shrinks.
const VENDOR_RATCHET_KB = 1372;
const vendorRatchetBytes = VENDOR_RATCHET_KB * 1024;
if (vendorBytes >= vendorRatchetBytes) {
  throw new Error(`vendor chunk is ${vendorBytes} bytes (must be < ${vendorRatchetBytes}; ratchet is ${VENDOR_RATCHET_KB} KiB)`);
}
const staleStarEffects = allFiles.filter((f) => /^stareffects-/.test(path.basename(f)));
if (staleStarEffects.length) throw new Error(`stareffects artifacts found: ${staleStarEffects.join(', ')}`);
const pixiFiles = allFiles.filter((f) => /\.(?:js|mjs|css)$/.test(f));
const appHtmlFiles = htmlFiles.map((f) => path.join(distDir, f));
const allPixi = [...pixiFiles.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')), ...appHtmlFiles.map((f) => fs.readFileSync(f, 'utf8'))]
  .reduce((n, content) => n + (content.match(/pixi/gi) ?? []).length, 0);
// Compressed .br/.gz files are same-source copies and need no separate scan.
if (allPixi !== 0) throw new Error(`pixi appears ${allPixi} times across JS/CSS/HTML assets`);
console.log(`vendor bytes: ${vendorBytes}`);
console.log(`vendor pixi matches: ${pixiCount}`);
console.log(`all JS/CSS/HTML pixi matches: ${allPixi}`);
