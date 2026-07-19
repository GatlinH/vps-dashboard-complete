import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const viteConfig = readFileSync(new URL('../vite.config.js', import.meta.url), 'utf8');
const taskProcessor = readFileSync(
  new URL('../node_modules/@cesium/engine/Source/Core/TaskProcessor.js', import.meta.url),
  'utf8',
);
const heightmapWorker = readFileSync(
  new URL('../node_modules/cesium/Build/Cesium/Workers/createVerticesFromHeightmap.js', import.meta.url),
  'utf8',
);

assert.match(
  viteConfig,
  /cesium\(\{\s*rebuildCesium:\s*true,\s*cesiumBaseUrl:\s*'\/cesium',\s*}\)/,
  'Cesium must be rebuilt by Vite instead of using the legacy global bundle with copied workers',
);
assert.match(
  taskProcessor,
  /options\.type\s*=\s*"module";[\s\S]*?return new Worker\(workerPath, options\);/,
  'Cesium TaskProcessor must create standard workers as module workers',
);
assert.match(
  heightmapWorker,
  /^import\{/m,
  'Cesium heightmap terrain worker is an ES module and must not be loaded as a classic worker',
);

console.log('CESIUM_MODULE_WORKERS_VERIFIED vite-rebuild=true task-processor=module');