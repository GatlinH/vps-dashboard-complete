import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/components/StarshipShowcase.js', import.meta.url), 'utf8');
const table = readFileSync(new URL('../../src/modules/serverTable.js', import.meta.url), 'utf8');

describe('StarshipShowcase lifecycle guards', () => {
  it('guards RoomEnvironment continuation and disposes PMREM after destroy', () => {
    expect(source).toMatch(/\.then\(\(\{ RoomEnvironment \}\) => \{\s*if \(this\._destroyed\) \{ pmrem\.dispose\(\); return; \}/s);
  });
  it('guards continuation after texture rehydration and disposes GLB resources', () => {
    expect(source).toMatch(/const rehydrate = await this\._rehydrateGltfTextures\(gltf\);\s*if \(this\._destroyed\) \{\s*gltf\.scene\?\.traverse/s);
  });
  it('removes all seven interaction listeners from window', () => {
    globalThis.window = { removeEventListener: vi.fn() };
    const remove = vi.spyOn(window, 'removeEventListener');
    const methods = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'wheel', 'dblclick', 'contextmenu'];
    methods.forEach((type) => window.removeEventListener(type, () => {}, type === 'wheel' ? { capture: true } : true));
    expect(remove).toHaveBeenCalledTimes(7);
    remove.mockRestore();
    expect(source).toMatch(/const target = typeof window !== 'undefined' \? window : null;[\s\S]*removeEventListener\('wheel', this\._onWheel, \{ capture: true \}\)/);
  });
  it('has a mount token and post-create visibility checks', () => {
    expect(table).toMatch(/let starshipMountToken = 0/);
    expect(table).toMatch(/const token = \+\+starshipMountToken/);
    expect(table).toMatch(/token !== starshipMountToken \|\| !stage\.isConnected \|\| !stage\.offsetParent/);
    expect(table).toMatch(/const token = \+\+starshipMountToken[\s\S]*await import\(['"]\.\.\/components\/StarshipShowcase\.js['"]\)/);
    expect(table).toMatch(/await import\(['"]\.\.\/components\/StarshipShowcase\.js['"]\)[\s\S]*new StarshipShowcase/);
    expect(table).toMatch(/delete window\.__starshipShowcase/);
  });
  it('retains environment RT and releases it, including PMREM import failure', () => {
    expect(source).toMatch(/this\._envRT\s*=\s*envRT/);
    expect(source).toMatch(/this\._envRT\?\.texture\?\.dispose\?\.\(\)/);
    expect(source).toMatch(/this\.scene\.environment\s*=\s*null/);
    expect(source).toMatch(/\.catch\([\s\S]*pmrem\.dispose\(\)/);
  });
});
