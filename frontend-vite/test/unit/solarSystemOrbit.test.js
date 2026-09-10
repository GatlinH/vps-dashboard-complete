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
    expect(text).toContain('CanvasTexture');
    expect(text).toContain('InstancedMesh');
    expect(text).toContain('_buildHalleyComet');
    expect(text).toContain('_buildAsteroidBelt');
  });

  it('updates asteroid instances and orients the Halley tail along its direction', async () => {
    const text = await source();
    expect(text).toContain('this.asteroidData=Array.from');
    expect(text).toContain('instanceMatrix.needsUpdate = true');
    expect(text).toMatch(/_advanceBodies[\s\S]*asteroidBelt[\s\S]*setMatrixAt/);
    expect(text).toMatch(/_advanceBodies[\s\S]*h\.tail\.quaternion\.setFromUnitVectors/);
    expect(text).toContain('tailGeometry.translate(0.5,0,0)');
    expect(text).toContain('crossTail');
  });

  it('covers v3.5 ring factory and portrait fitting contracts', async () => {
    const text = await source();
    expect(text).toContain('_generateRingTexture');
    expect(text).toContain('new THREE.InstancedMesh');
    expect(text).toContain('if (aspect < 1)');
    expect(text).toContain('depthWrite: false');
  });

  it('keeps the sun, Earth, and Moon hit targets separated by priority', async () => {
    const text = await source();
    expect(text).toContain('[this.sun, this.earth, this.moon]');
    expect(text).toContain('Joint hit-target solver');
    expect(text).toContain('const MAX_OFF = 11.5;');
    expect(text).toContain('const PROBE_CLEAR = 13.5;');
    expect(text).toContain('const PAIR_MIN = 24.6;');
    // Hysteresis: current placement is reused when still valid (no per-frame snap).
    expect(text).toContain('placementValid(earthRow.offsetX, earthRow.offsetY, moonRow2.offsetX, moonRow2.offsetY)');
    // Moon orbit stays on the vertical plane (xFactor 0.25) so its projection
    // does not cross the sun/earth line — a deliberate hit-test constraint.
    expect(text).toContain('xFactor: 0.25');
    // Detached moon button is re-attached from resume() and visibilitychange.
    expect(text).toContain('_ensureMoonAttached');
  });
});
