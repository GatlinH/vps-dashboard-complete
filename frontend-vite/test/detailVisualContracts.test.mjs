import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const charts = readFileSync(new URL('../src/pages/detailCharts.js', import.meta.url), 'utf8');
const telemetryAxis = readFileSync(new URL('../src/detail/telemetryAxis.js', import.meta.url), 'utf8');
const starmap = readFileSync(new URL('../src/components/GlobeStarmap.jsx', import.meta.url), 'utf8');
const finalStarmapCss = readFileSync(new URL('../src/styles/detail-starmap-background.css', import.meta.url), 'utf8');

test('CPU, RAM, and process axes accumulate from their first sample before rolling', () => {
  const ownAxis = charts.slice(charts.indexOf('const seriesOwnBounds'), charts.indexOf('const cpuAxisBounds'));
  assert.match(ownAxis, /coldStartAxisBounds/);
  assert.match(telemetryAxis, /accumulating-from-first-sample/);
  assert.match(telemetryAxis, /rolling-after-full-window/);
});

test('detail starmap uses semantic theme surfaces as its single source', () => {
  assert.match(starmap, /readCssVar\(canvas, ["']--starmap-canvas-bg["']/);
  assert.match(starmap, /globe-starmap-root/);
  assert.match(starmap, /globe-starmap-viewport/);
  assert.match(finalStarmapCss, /--starmap-canvas-bg/);
  assert.match(finalStarmapCss, /html\[data-theme="dark"\]/);
  assert.match(finalStarmapCss, /html\[data-theme="light"\]/);
});
