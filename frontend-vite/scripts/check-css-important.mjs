import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const token = '!important';

async function cssFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await cssFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.css')) files.push(path);
  }
  return files.sort();
}

export async function checkImportantRatchet(sourceRoot, baseline) {
  const counts = {};
  for (const path of await cssFiles(sourceRoot)) {
    const contents = await readFile(path, 'utf8');
    const count = contents.split(token).length - 1;
    if (count > 0) counts[relative(sourceRoot, path).replaceAll('\\', '/')] = count;
  }

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const errors = [];
  if (total > baseline.total) errors.push(`total: ${total} exceeds baseline ${baseline.total}`);
  for (const name of Object.keys(counts).sort()) {
    if (!(name in baseline.files)) {
      errors.push(`${name}: ${counts[name]} is not present in the reviewed baseline`);
    } else if (counts[name] > baseline.files[name]) {
      errors.push(`${name}: ${counts[name]} exceeds baseline ${baseline.files[name]}`);
    }
  }

  const report = [
    `CSS ${token} total: ${total} (baseline: ${baseline.total})`,
    ...Object.keys(counts)
      .sort()
      .map((name) => `${name}: ${counts[name]} (baseline: ${baseline.files[name] ?? 0})`),
  ].join('\n');

  return { ok: errors.length === 0, errors, report, total, files: counts };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const frontendRoot = resolve(dirname(scriptPath), '..');
  const sourceRoot = join(frontendRoot, 'src');
  const baseline = JSON.parse(
    await readFile(join(frontendRoot, 'css-important-baseline.json'), 'utf8'),
  );
  const result = await checkImportantRatchet(sourceRoot, baseline);
  console.log(result.report);
  if (!result.ok) {
    for (const error of result.errors) console.error(`ERROR: ${error}`);
    process.exitCode = 1;
  }
}
