import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesDir = path.join(root, 'src', 'styles');
const entrySource = fs.readFileSync(path.join(root, 'src', 'admin-main.js'), 'utf8');
const styleFiles = fs.readdirSync(stylesDir).filter((name) => name.endsWith('.css'));
const datedHotfixes = styleFiles.filter((name) => /^hermes_admin_.*_\d{8}\.css$/.test(name));

assert.deepEqual(
  datedHotfixes,
  [],
  `dated admin hotfix styles are forbidden; consolidate these files: ${datedHotfixes.join(', ')}`,
);
assert.match(entrySource, /import '\.\/styles\/admin\.css';/);
assert.match(entrySource, /import '\.\/styles\/admin-legacy-overrides\.css';/);
assert.doesNotMatch(entrySource, /hermes_admin_.*_\d{8}\.css/);

console.log('ADMIN_CSS_STRUCTURE_VERIFIED dated-hotfixes=0 imports=2');
