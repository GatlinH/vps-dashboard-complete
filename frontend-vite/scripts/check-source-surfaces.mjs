import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const legacyHelperAllowlist = [
  'components/admin/UserAdminPanel.js',
  'components/globe/vpsEntities.js',
];
const helperDefinition =
  /(?:function\s+_?escapeHtml\s*\(|(?:^|\n)\s*_escapeHtml\s*\([^)]*\)\s*\{)/g;

async function jsFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await jsFiles(path)));
    else if (entry.isFile() && /\.[cm]?jsx?$/.test(entry.name)) files.push(path);
  }
  return files.sort();
}

export async function checkSourceSurfaces(sourceRoot) {
  const errors = [];
  const helpers = [];
  const serverCard = join(sourceRoot, 'components/ServerCard.js');
  const files = await jsFiles(sourceRoot);

  for (const path of files) {
    const name = relative(sourceRoot, path).replaceAll('\\', '/');
    const contents = await readFile(path, 'utf8');
    const count = [...contents.matchAll(helperDefinition)].length;
    if (count && name !== 'utils/escapeHtml.js') {
      helpers.push(...Array(count).fill(name));
      if (!legacyHelperAllowlist.includes(name)) {
        errors.push(`${name}: unreviewed HTML escape helper definition`);
      }
    }
  }

  if (files.includes(serverCard)) {
    errors.push('components/ServerCard.js: deleted dead surface was reintroduced');
  }
  const displayDataPath = join(sourceRoot, 'services/displayData.js');
  if (files.includes(displayDataPath)) {
    const displayData = await readFile(displayDataPath, 'utf8');
    for (const name of ['fetchNetworkTimeline', 'fetchPing']) {
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`).test(displayData)) {
        errors.push(`services/displayData.js: deleted export ${name} was reintroduced`);
      }
    }
  }

  const report = [
    `Duplicate HTML escape helper definitions: ${helpers.length}`,
    'Reviewed legacy helper allowlist:',
    ...legacyHelperAllowlist,
    'Deleted dead surfaces: absent',
    'components/ServerCard.js',
    'services/displayData.js:fetchNetworkTimeline',
    'services/displayData.js:fetchPing',
  ].join('\n');
  return { ok: errors.length === 0, errors: errors.sort(), report };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const frontendRoot = resolve(dirname(scriptPath), '..');
  const result = await checkSourceSurfaces(join(frontendRoot, 'src'));
  console.log(result.report);
  for (const error of result.errors) console.error(`ERROR: ${error}`);
  if (!result.ok) process.exitCode = 1;
}
