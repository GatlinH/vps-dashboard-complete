import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const root = new URL('../../src/', import.meta.url);
const source = () => readFile(new URL('modules/serverTable.js', root), 'utf8');
const cesiumSource = () => readFile(new URL('components/CesiumGlobe.js', root), 'utf8');

describe('globe return navigation and first-paint slimming', () => {
  it('defines the solar-system return button and first-entry toast contract', async () => {
    const text = await source();
    expect(text).toContain('globeReturnSolarBtn');
    expect(text).toContain('← 太阳系 (Esc)');
    expect(text).toContain('globeFirstEntryToast');
    expect(text).toContain("sessionStorage.getItem('vps_seen_globe_guide')");
    expect(text).toContain('stopPropagation()');
  });

  it('keeps chart and detail console code out of the top-level server table module', async () => {
    const text = await source();
    expect(text).not.toContain("new TrafficChart()");
    expect(text).not.toContain("import '../styles/detail-starfleet-console.css'");
    expect(text).not.toContain("import '../styles/detail-starmap-background.css'");
    expect(text).not.toContain("from '../pages/detailCharts.js'");
  });

  it('owns globe CSS from the Cesium lazy module', async () => {
    expect(await cesiumSource()).toContain("import '../styles/globe.css'");
  });
});
