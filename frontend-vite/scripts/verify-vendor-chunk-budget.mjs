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
const files = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'));
const vendor = files.filter((f) => /^vendor-[^/]+\.js$/.test(f));
const cesium = files.filter((f) => /^cesium-[^/]+\.js$/.test(f));
if (!vendor.length) throw new Error('No vendor chunk found');
const vendorCode = vendor.map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8')).join('\n');
const pixiCount = (vendorCode.match(/pixi/gi) ?? []).length;
if (pixiCount !== 0) throw new Error(`pixi appears ${pixiCount} times in vendor chunk`);
const vendorBytes = vendor.reduce((n, f) => n + fs.statSync(path.join(assetsDir, f)).size, 0);
if (vendorBytes >= 1500 * 1024) throw new Error(`vendor chunk is ${vendorBytes} bytes (must be < 1536000)`);
const moved = files.filter((f) => !vendor.includes(f) && !cesium.includes(f));
const movedPixi = moved.filter((f) => /pixi/i.test(fs.readFileSync(path.join(assetsDir, f), 'utf8')));
if (!movedPixi.length) throw new Error('No non-vendor, non-cesium chunk contains pixi');
console.log(`vendor bytes: ${vendorBytes}`);
console.log(`vendor pixi matches: ${pixiCount}`);
console.log(`pixi chunks: ${movedPixi.join(', ')}`);
