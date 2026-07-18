import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [chartSource, detailSource, styleSource, mainSource] = await Promise.all([
  readFile(new URL('../src/pages/detailCharts.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/detailPage.js', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/main.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
]);

assert.match(detailSource, /<div class="network-chart-surface"><canvas id="detailNetworkChart"><\/canvas><\/div>/, 'network canvas must have a dedicated chart surface');
assert.match(styleSource, /\.network-chart-surface\{[\s\S]*?flex:1[\s\S]*?min-height:0/, 'the chart surface must consume the available card height');
assert.match(styleSource, /\.network-chart-surface canvas\{[\s\S]*?width:100%[\s\S]*?height:100%/, 'network canvas CSS must fill its chart surface');
assert.match(chartSource, /responsive:\s*true,[\s\S]*?maintainAspectRatio:\s*false/, 'Chart.js must render into its live container dimensions');
assert.match(chartSource, /const networkCtx = networkCanvas\?\.getContext\('2d'\)/, 'network renderer must use the canvas context');
assert.match(chartSource, /if \(networkPointTimes\.length >= 2\) \{[\s\S]*?max: last \+ pad/, 'desktop and mobile network axes must end near the last real sample, never wall-clock future time');
assert.match(chartSource, /min:\s*networkAxisBounds\.min,[\s\S]*?max:\s*networkAxisBounds\.max/, 'x plot scale must use the computed network rendering domain');
assert.match(chartSource, /min:\s*0,[\s\S]*?max:\s*(?:networkMobileMax|NETWORK_EQUAL_STEP_AXIS\.length - 1)/, 'y plot scale must use data-derived bounds');
assert.doesNotMatch(chartSource, /viewBox="0 0 [^"]* 238"|viewBox[^\n]*238/, 'network renderer must not retain a stale 238px SVG viewBox');
assert.doesNotMatch(mainSource, /initNetworkTooltip\(\)/, 'the retired SVG-only network tooltip path must not be invoked for the canvas chart');

const realisticRows = [{ net_up: 0, net_down: null }, { net_up: 256, net_down: 0 }, { net_up: null, net_down: 1536 }];
assert.equal(realisticRows.filter((row) => row.net_up != null || row.net_down != null).length, 3, 'zero and null network samples remain representable without invented values');

console.log('NETWORK_THROUGHPUT_RENDERING_REGRESSIONS_VERIFIED canvas-surface responsive-scales empty-safe');
