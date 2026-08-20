import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { checkSourceSurfaces } from '../../scripts/check-source-surfaces.mjs';

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'source-surfaces-'));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, contents);
  }
  return root;
}

describe('source surface guard', () => {
  it('runs the source surface gate in both frontend CI workflows before build', async () => {
    const repositoryRoot = join(import.meta.dirname, '../../..');
    for (const workflowName of ['ci.yml', 'frontend-ci.yml']) {
      const workflow = await readFile(
        join(repositoryRoot, '.github', 'workflows', workflowName),
        'utf8',
      );
      const installIndex = workflow.indexOf('npm ci');
      const sourceGateIndex = workflow.indexOf('npm run check:source-surfaces');
      const buildIndex = workflow.indexOf('npm run build');

      expect(installIndex, `${workflowName} installs dependencies`).toBeGreaterThan(-1);
      expect(sourceGateIndex, `${workflowName} runs the source surface gate`).toBeGreaterThan(
        installIndex,
      );
      expect(buildIndex, `${workflowName} builds after the source surface gate`).toBeGreaterThan(
        sourceGateIndex,
      );
    }
  });

  it('reports reviewed legacy helpers deterministically', async () => {
    const root = await fixture({
      'components/globe/vpsEntities.js': 'export function escapeHtml(value) {}',
      'components/admin/UserAdminPanel.js': 'function escapeHtml(value) {}',
      'utils/escapeHtml.js': 'function escapeHtml(value) {}',
    });

    const result = await checkSourceSurfaces(root);

    expect(result.ok).toBe(true);
    expect(result.report).toBe(
      [
        'Duplicate HTML escape helper definitions: 2',
        'Reviewed legacy helper allowlist:',
        'components/admin/UserAdminPanel.js',
        'components/globe/vpsEntities.js',
        'Deleted dead surfaces: absent',
        'components/ServerCard.js',
        'services/displayData.js:fetchNetworkTimeline',
        'services/displayData.js:fetchPing',
      ].join('\n'),
    );
  });

  it('rejects a new local helper outside the allowlist', async () => {
    const root = await fixture({ 'new.js': 'function escapeHtml(value) {}' });
    const result = await checkSourceSurfaces(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('new.js: unreviewed HTML escape helper definition');
  });

  it('rejects reintroduced dead surfaces', async () => {
    const root = await fixture({
      'components/ServerCard.js': 'export class ServerCard {}',
      'services/displayData.js': 'export function fetchPing() {}',
    });
    const result = await checkSourceSurfaces(root);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'components/ServerCard.js: deleted dead surface was reintroduced',
    );
    expect(result.errors).toContain(
      'services/displayData.js: deleted export fetchPing was reintroduced',
    );
  });
});
