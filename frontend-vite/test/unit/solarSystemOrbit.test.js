import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = () => readFile(new URL('../../src/components/SolarSystem.js', import.meta.url), 'utf8');

describe('solar system F2 orbit interaction', () => {
  it('contains orbit, wheel, hit buttons, and tween interruption contracts', async () => {
    const text = await source();
    expect(text).toContain('THREE.Spherical');
    expect(text).toMatch(/addEventListener\(['"]wheel['"]/);
    expect(text).toContain('preventDefault()');
    expect(text).toContain('Math.PI / 2 - 0.08');
    expect(text).toMatch(/clamp\([^;]*25, 140/);
    expect(text).toContain('solar-system-hit');
    expect(text).toContain('cameraTween = null');
    expect(text).not.toMatch(/OrbitControls/);
  });

  it('pauses motion while dragging and uses Saturn rings and nebula background', async () => {
    const text = await source();
    expect(text).toContain('RingGeometry');
    expect(text).toContain("/globe/backgrounds/heic1509a-bg.jpg");
    expect(text).toMatch(/isDragging[\s\S]{0,180}_advanceBodies/);
    expect(text).not.toContain('_buildStars');
    expect(text).not.toContain('PointsMaterial');
  });
});
