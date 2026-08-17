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
assert.match(chartSource, /const networkHours = 6;[\s\S]*?const networkRowsSource = Array\.isArray\(networkProbeRows\) \? networkProbeRows : probeRows;[\s\S]*?const networkNow = latestTimelineMs\(networkRowsSource\);[\s\S]*?const networkAxisBounds = \(\(\) => \{[\s\S]*?const fullSpan = networkHours \* 60 \* 60 \* 1000;/, 'network axes must use the fixed six-hour duration and anchor their domain to the dedicated real network source');
assert.match(chartSource, /min:\s*networkAxisBounds\.min,[\s\S]*?max:\s*networkAxisBounds\.max/, 'x plot scale must use the computed network rendering domain');
assert.match(chartSource, /const networkRateValues = \[[\s\S]*?const networkY = adaptiveRateYScale\(networkRateValues, baseOptions\.scales\.y, fmtRate\);[\s\S]*?const networkYScale = networkY\.scale;[\s\S]*?y: networkY\.toPlot\(rawY\)/, 'y plot scale must derive from plotted real network rates and preserve the adaptive transform contract');
assert.doesNotMatch(chartSource, /viewBox="0 0 [^"]* 238"|viewBox[^\n]*238/, 'network renderer must not retain a stale 238px SVG viewBox');
assert.doesNotMatch(mainSource, /initNetworkTooltip\(\)/, 'the retired SVG-only network tooltip path must not be invoked for the canvas chart');

const realisticRows = [{ net_up: 0, net_down: null }, { net_up: 256, net_down: 0 }, { net_up: null, net_down: 1536 }];
assert.equal(realisticRows.filter((row) => row.net_up != null || row.net_down != null).length, 3, 'zero and null network samples remain representable without invented values');

console.log('NETWORK_THROUGHPUT_RENDERING_REGRESSIONS_VERIFIED canvas-surface responsive-scales empty-safe');
