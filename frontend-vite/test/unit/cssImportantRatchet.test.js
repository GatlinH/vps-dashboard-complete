import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkImportantRatchet } from '../../scripts/check-css-important.mjs';

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'css-important-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

describe('CSS !important ratchet', () => {
  it('passes when the source matches the reviewed baseline', async () => {
    const root = await fixture({ 'a.css': '.a { color: red !important; }' });
    const result = await checkImportantRatchet(root, { total: 1, files: { 'a.css': 1 } });

    expect(result.ok).toBe(true);
  });

  it('fails when an existing file increases', async () => {
    const root = await fixture({
      'a.css': '.a { color: red !important; display: none !important; }',
    });
    const result = await checkImportantRatchet(root, { total: 1, files: { 'a.css': 1 } });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('a.css: 2 exceeds baseline 1');
  });

  it('fails when a new CSS file contains !important', async () => {
    const root = await fixture({ 'new.css': '.new { color: red !important; }' });
    const result = await checkImportantRatchet(root, { total: 0, files: {} });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('new.css: 1 is not present in the reviewed baseline');
  });

  it('passes when counts decrease or baseline files disappear', async () => {
    const root = await fixture({ 'a.css': '.a { color: red; }' });
    const result = await checkImportantRatchet(root, {
      total: 2,
      files: { 'a.css': 1, 'deleted.css': 1 },
    });

    expect(result.ok).toBe(true);
  });

  it('reports files deterministically', async () => {
    const root = await fixture({
      'z.css': '.z { color: red !important; }',
      'nested/a.css': '.a { color: red !important; display: none !important; }',
    });
    const result = await checkImportantRatchet(root, {
      total: 3,
      files: { 'z.css': 1, 'nested/a.css': 2 },
    });

    expect(result.report).toBe(
      [
        'CSS !important total: 3 (baseline: 3)',
        'nested/a.css: 2 (baseline: 2)',
        'z.css: 1 (baseline: 1)',
      ].join('\n'),
    );
  });
});
