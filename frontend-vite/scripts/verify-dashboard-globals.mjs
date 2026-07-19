import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..', 'src');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => entry.isDirectory() ? files(resolve(dir, entry.name)) : [resolve(dir, entry.name)]))).flat();
}

const globalsPath = resolve(root, 'globals/dashboardGlobals.js');
const globalsSource = await readFile(globalsPath, 'utf8');
assert.match(globalsSource, /window\.__DBG__\s*=\s*window\.__DBG__\s*\|\|\s*\{\}/, '__DBG__ initializer must remain defensive');

const location = { protocol: 'http:', hostname: 'example.test', port: '', origin: 'http://example.test' };
const emptyContext = { window: {}, location };
vm.runInNewContext(globalsSource.replace('export const G', 'const G'), emptyContext);
assert.equal(typeof emptyContext.window.__DBG__, 'object', 'dashboard globals must initialize __DBG__ when absent');

const apiRootContext = { window: { __API_ROOT__: 'https://api.example.test' }, location };
vm.runInNewContext(globalsSource.replace('export const G', 'const G'), apiRootContext);
assert.equal(apiRootContext.window.__DBG__.API_ROOT, 'https://api.example.test', 'legacy API root must migrate into __DBG__');
assert.equal('__API_ROOT__' in apiRootContext.window, false, 'legacy API root must be consumed after migration');

const sourceFiles = (await files(root)).filter((path) => /\.(?:js|jsx)$/.test(path) && path !== globalsPath);
const missingGuard = [];
for (const path of sourceFiles) {
  const source = await readFile(path, 'utf8');
  if (source.includes('window.__DBG__') && !source.includes('globals/dashboardGlobals.js')) missingGuard.push(relative(root, path));
}
assert.deepEqual(missingGuard, [], `Every __DBG__ consumer must import the initializer: ${missingGuard.join(', ')}`);
console.log(`PASS: dashboard globals initialize safely; ${sourceFiles.length} frontend modules checked`);
