import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const charts = readFileSync(new URL('../src/pages/detailCharts.js', import.meta.url), 'utf8');
const starmap = readFileSync(new URL('../src/components/GlobeStarmap.jsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/styles/main.css', import.meta.url), 'utf8');
const finalStarmapCss = readFileSync(new URL('../src/styles/detail-starmap-background.css', import.meta.url), 'utf8');

test('CPU and RAM axes are always a full hour ending at now', () => {
  assert.match(charts, /const min = max - fullSpan;/);
  assert.match(charts, /mode: 'fixed-window-ending-now'/);
  const ownAxis = charts.slice(charts.indexOf('const seriesOwnBounds'), charts.indexOf('const cpuAxisBounds'));
  assert.doesNotMatch(ownAxis, /minVisibleSpan/);
});

test('detail starmap is transparent outside the globe itself', () => {
  assert.match(starmap, /ctx\.clearRect\(0, 0, W, H\)/);
  assert.match(starmap, /background: "transparent"/);
  assert.match(css, /\.detail-globe-starmap-mount\{[\s\S]*background:transparent!important;/);
  assert.match(finalStarmapCss, /\.detail-globe-starmap-mount canvas[\s\S]*background-color: transparent !important;/);
  assert.match(finalStarmapCss, /html\[data-theme="dark"\][\s\S]*\.fleet-starmap-panel/);
  assert.match(finalStarmapCss, /html\[data-theme="light"\][\s\S]*\.fleet-starmap-panel[\s\S]*#f7efdc/);
});
